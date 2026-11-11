import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';

export interface TorrentFileInfo {
  index: number;
  name: string;
  path: string;
  length: number;
}

export interface TorrentStats {
  infoHash: string;
  peers: number;
  downloaded: number;
  uploaded: number;
  downloadSpeed: number;
  progress: number;
  refs: number;
}

export interface EngineOptions {
  dataDir: string;
  port: number;
  dht: boolean;
  trackers: boolean;
  webSeeds: boolean;
  allowPrivatePeers: boolean;
  maxConns: number;
  uploadLimitKiBps: number;
  lingerMs: number;
}

/**
 * IPv4 ranges a production server must never dial. Peers are untrusted input
 * (DHT/PEX/tracker responses), so without this a torrent could make the worker
 * connect to internal services (SSRF). IPv6 and defence-in-depth are handled by
 * the network egress policy (see ARCHITECTURE.md §Security).
 */
export const PRIVATE_IPV4_BLOCKLIST = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

export class TorrentHandle {
  constructor(
    private readonly torrent: Torrent,
    private readonly onRelease: () => void,
  ) {}

  private released = false;

  get infoHash(): string {
    return this.torrent.infoHash;
  }

  get files(): TorrentFileInfo[] {
    return this.torrent.files.map((f, index) => ({
      index,
      name: f.name,
      path: f.path,
      length: f.length,
    }));
  }

  fileLength(index: number): number {
    return this.file(index).length;
  }

  /**
   * Byte-range stream over a file. WebTorrent prioritises the pieces backing
   * the range (critical first, then sequential). `end` is inclusive.
   */
  createReadStream(index: number, start: number, end: number): Readable {
    const file = this.file(index);
    if (start < 0 || end < start || end >= file.length) {
      throw new RangeError(`Invalid range ${start}-${end} for file of ${file.length} bytes`);
    }
    // WebTorrent treats `end: 0` as "until EOF"; enforce the exact length ourselves.
    return limitStream(file.createReadStream({ start, end }), end - start + 1);
  }

  async readFile(index: number, maxBytes = 5 * 1024 * 1024): Promise<Buffer> {
    const length = this.fileLength(index);
    if (length > maxBytes) throw new Error(`File ${index} is ${length} bytes, above ${maxBytes}`);
    if (length === 0) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    for await (const chunk of this.createReadStream(index, 0, length - 1)) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  addPeer(addr: string): void {
    this.torrent.addPeer(addr);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease();
  }

  private file(index: number) {
    const file = this.torrent.files[index];
    if (!file) throw new RangeError(`Torrent ${this.infoHash} has no file #${index}`);
    return file;
  }
}

interface Entry {
  torrent: Torrent;
  refs: number;
  lingerTimer: NodeJS.Timeout | undefined;
}

/**
 * Owns the single WebTorrent client of a worker process. Torrents are shared
 * between playback sessions through reference counting; when the last session
 * releases a torrent it lingers (for quick re-use / seeks from a new session)
 * and is then destroyed together with its downloaded data.
 */
export class TorrentEngine {
  private readonly client: WebTorrent;
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Torrent>>();

  constructor(private readonly opts: EngineOptions) {
    this.client = new WebTorrent({
      torrentPort: opts.port,
      dht: opts.dht,
      tracker: opts.trackers,
      webSeeds: opts.webSeeds,
      lsd: false,
      utPex: opts.dht,
      natUpnp: false,
      natPmp: false,
      utp: false,
      maxConns: opts.maxConns,
      uploadLimit: opts.uploadLimitKiBps < 0 ? -1 : opts.uploadLimitKiBps * 1024,
      ...(opts.allowPrivatePeers ? {} : { blocklist: PRIVATE_IPV4_BLOCKLIST }),
    });
    this.client.on('error', () => {
      // Client-level errors are surfaced per torrent; never crash the worker.
    });
  }

  /** Adds (or re-uses) a torrent and resolves once its metadata is available. */
  async acquire(
    torrentFile: Buffer,
    infoHash: string,
    opts: { peers?: string[]; timeoutMs?: number } = {},
  ): Promise<TorrentHandle> {
    const torrent = await this.getOrAdd(torrentFile, infoHash, opts.timeoutMs ?? 60_000);
    const entry = this.entries.get(infoHash);
    if (!entry) throw new Error(`Torrent ${infoHash} disappeared while acquiring`);
    if (entry.lingerTimer) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = undefined;
    }
    entry.refs += 1;
    for (const peer of opts.peers ?? []) torrent.addPeer(peer);
    return new TorrentHandle(torrent, () => {
      this.releaseRef(infoHash);
    });
  }

  stats(): TorrentStats[] {
    return [...this.entries.values()].map(({ torrent, refs }) => ({
      infoHash: torrent.infoHash,
      peers: torrent.numPeers,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
      downloadSpeed: torrent.downloadSpeed,
      progress: torrent.progress,
      refs,
    }));
  }

  async destroy(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.lingerTimer) clearTimeout(entry.lingerTimer);
    }
    await Promise.all([...this.entries.keys()].map((infoHash) => this.destroyTorrent(infoHash)));
    await new Promise<void>((resolve) => {
      this.client.destroy(() => {
        resolve();
      });
    });
  }

  private async getOrAdd(torrentFile: Buffer, infoHash: string, timeoutMs: number) {
    const existing = this.entries.get(infoHash);
    if (existing) return existing.torrent;
    const inFlight = this.pending.get(infoHash);
    if (inFlight) return inFlight;

    const promise = this.addTorrent(torrentFile, infoHash, timeoutMs).finally(() => {
      this.pending.delete(infoHash);
    });
    this.pending.set(infoHash, promise);
    return promise;
  }

  private async addTorrent(torrentFile: Buffer, infoHash: string, timeoutMs: number) {
    const dir = path.join(this.opts.dataDir, infoHash);
    await mkdir(dir, { recursive: true });
    const torrent = await new Promise<Torrent>((resolve, reject) => {
      const t = this.client.add(torrentFile, { path: dir, deselect: true, strategy: 'sequential' });
      const timer = setTimeout(() => {
        cleanup();
        t.destroy();
        reject(new Error(`Timed out waiting for torrent ${infoHash} metadata`));
      }, timeoutMs);
      const onReady = () => {
        cleanup();
        resolve(t);
      };
      const onError = (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const cleanup = () => {
        clearTimeout(timer);
        t.off('ready', onReady);
        t.off('error', onError);
      };
      if (t.ready) {
        onReady();
        return;
      }
      t.once('ready', onReady);
      t.once('error', onError);
    });
    if (torrent.infoHash !== infoHash) {
      torrent.destroy({ destroyStore: true });
      throw new Error(
        `Torrent file infohash ${torrent.infoHash} does not match catalog ${infoHash}`,
      );
    }
    torrent.on('error', () => {
      /* surfaced through stalled reads / ffmpeg timeouts */
    });
    this.entries.set(infoHash, { torrent, refs: 0, lingerTimer: undefined });
    return torrent;
  }

  private releaseRef(infoHash: string): void {
    const entry = this.entries.get(infoHash);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    entry.lingerTimer = setTimeout(() => {
      void this.destroyTorrent(infoHash);
    }, this.opts.lingerMs);
    entry.lingerTimer.unref();
  }

  private destroyTorrent(infoHash: string): Promise<void> {
    const entry = this.entries.get(infoHash);
    if (!entry) return Promise.resolve();
    this.entries.delete(infoHash);
    return new Promise<void>((resolve) => {
      entry.torrent.destroy({ destroyStore: true }, () => {
        resolve();
      });
    }).then(() =>
      // The chunk store deletes files but can leave the directory tree behind.
      rm(path.join(this.opts.dataDir, infoHash), { recursive: true, force: true }),
    );
  }
}

/** Passes through at most `length` bytes, then ends and destroys the source. */
export function limitStream(source: Readable, length: number): Readable {
  let remaining = length;
  async function* limited() {
    try {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        if (buf.length >= remaining) {
          yield buf.subarray(0, remaining);
          remaining = 0;
          return;
        }
        remaining -= buf.length;
        yield buf;
      }
    } finally {
      source.destroy();
    }
  }
  return Readable.from(limited(), { objectMode: false });
}
