import { mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ByteRangeReader } from '@streaming/media-core';
import WebTorrent from 'webtorrent';
import { selectEvictions } from './cache-policy.js';
import type { CacheEntry } from './cache-policy.js';
import type { Torrent, TorrentFile } from 'webtorrent';

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
  /**
   * Bytes of released torrent data kept on disk for reuse (LRU-evicted above
   * this). 0 disables the cache: data is deleted once a torrent stops lingering.
   */
  cacheMaxBytes: number;
  /** Read-window size: bounds how far ahead of the reader pieces are prioritised. */
  readWindowBytes: number;
}

const INFOHASH_DIR = /^[0-9a-f]{40}$/;
const MARKER = '.last-used';

export interface CacheUsage {
  torrents: number;
  bytes: number;
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
    private readonly readWindowBytes: number,
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
    return limitStream(windowedStream(file, start, end, this.readWindowBytes), end - start + 1);
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

  /** Random-access reader over one file, for container indexing (fetches only what is read). */
  reader(index: number): ByteRangeReader {
    const size = this.fileLength(index);
    return {
      size,
      read: async (offset, length) => {
        const end = Math.min(size, offset + length) - 1;
        if (end < offset) return new Uint8Array(0);
        const chunks: Buffer[] = [];
        for await (const chunk of this.createReadStream(index, offset, end))
          chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
      },
    };
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
  private quotaPass: Promise<void> = Promise.resolve();

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
    // Never add a torrent while an eviction pass might be deleting its directory.
    await this.quotaPass;
    const torrent = await this.getOrAdd(torrentFile, infoHash, opts.timeoutMs ?? 60_000);
    await this.touch(infoHash);
    const entry = this.entries.get(infoHash);
    if (!entry) throw new Error(`Torrent ${infoHash} disappeared while acquiring`);
    if (entry.lingerTimer) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = undefined;
    }
    entry.refs += 1;
    for (const peer of opts.peers ?? []) torrent.addPeer(peer);
    return new TorrentHandle(
      torrent,
      () => {
        this.releaseRef(infoHash);
      },
      this.opts.readWindowBytes,
    );
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

  /** Creates the data directory and applies the quota to data left by earlier runs. */
  async start(): Promise<void> {
    await mkdir(this.opts.dataDir, { recursive: true });
    await this.enforceQuota();
  }

  /** Disk used by torrent data (active and cached). */
  async cacheUsage(): Promise<CacheUsage> {
    const entries = await this.scanCache();
    return { torrents: entries.length, bytes: entries.reduce((sum, e) => sum + e.bytes, 0) };
  }

  /** Shutdown keeps data on disk: the cache survives restarts. */
  async destroy(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.lingerTimer) clearTimeout(entry.lingerTimer);
    }
    await Promise.all(
      [...this.entries.keys()].map((infoHash) => this.destroyTorrent(infoHash, { keepData: true })),
    );
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
      void this.destroyTorrent(infoHash, { keepData: true }).then(() => this.enforceQuota());
    }, this.opts.lingerMs);
    entry.lingerTimer.unref();
  }

  private async destroyTorrent(infoHash: string, opts: { keepData: boolean }): Promise<void> {
    const entry = this.entries.get(infoHash);
    if (!entry) return;
    this.entries.delete(infoHash);
    await new Promise<void>((resolve) => {
      entry.torrent.destroy({ destroyStore: !opts.keepData }, () => {
        resolve();
      });
    });
    if (opts.keepData) await this.touch(infoHash);
    // The chunk store deletes files but can leave the directory tree behind.
    else await rm(path.join(this.opts.dataDir, infoHash), { recursive: true, force: true });
  }

  /** Records use time in a marker file, so LRU order survives restarts. */
  private async touch(infoHash: string): Promise<void> {
    const marker = path.join(this.opts.dataDir, infoHash, MARKER);
    try {
      const now = new Date();
      await writeFile(marker, now.toISOString());
      await utimes(marker, now, now);
    } catch {
      /* directory removed concurrently; nothing to record */
    }
  }

  private async scanCache(): Promise<CacheEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.opts.dataDir);
    } catch {
      return [];
    }
    const out: CacheEntry[] = [];
    for (const name of names.filter((n) => INFOHASH_DIR.test(n))) {
      const dir = path.join(this.opts.dataDir, name);
      let lastUsedMs: number;
      try {
        lastUsedMs = (await stat(path.join(dir, MARKER))).mtimeMs;
      } catch {
        lastUsedMs = (await stat(dir)).mtimeMs;
      }
      out.push({
        infoHash: name,
        bytes: await allocatedBytes(dir),
        lastUsedMs,
        active: this.entries.has(name) || this.pending.has(name),
      });
    }
    return out;
  }

  /** Serialised: one eviction pass at a time, and acquires wait for it. */
  private enforceQuota(): Promise<void> {
    this.quotaPass = this.quotaPass.then(async () => {
      try {
        const evict = selectEvictions(await this.scanCache(), this.opts.cacheMaxBytes);
        for (const infoHash of evict) {
          if (this.entries.has(infoHash) || this.pending.has(infoHash)) continue; // re-acquired meanwhile
          await rm(path.join(this.opts.dataDir, infoHash), { recursive: true, force: true });
        }
      } catch {
        // A failed pass (e.g. a directory vanishing mid-scan) must not block
        // later acquires, which wait on this chain; the next release retries.
      }
    });
    return this.quotaPass;
  }
}

/** Bytes allocated on disk under `dir` (sparse, partially downloaded files count only written blocks). */
async function allocatedBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await allocatedBytes(full);
    else if (entry.isFile()) total += (await stat(full)).blocks * 512;
  }
  return total;
}

/**
 * WebTorrent selects (prioritises for download) every piece of a read range
 * as soon as the stream is opened. ffmpeg opens ranges to end-of-file, so a
 * plain stream would pull the whole remainder of the title from the swarm on
 * every open (each seek, and for as long as a paused encoder holds its
 * connection). Reading in windows selects only the window being read plus one
 * primed window of read-ahead; abandoning the stream deselects both.
 */
export function windowedStream(
  file: TorrentFile,
  start: number,
  end: number,
  windowBytes: number,
): Readable {
  async function* windows() {
    let current: Readable | null = null;
    let next: Readable | null = null;
    try {
      let pos = start;
      while (pos <= end) {
        const windowEnd = Math.min(pos + windowBytes - 1, end);
        current = next ?? file.createReadStream({ start: pos, end: windowEnd });
        // Prime the following window now so its pieces download while this one is read.
        next =
          windowEnd < end
            ? file.createReadStream({
                start: windowEnd + 1,
                end: Math.min(windowEnd + windowBytes, end),
              })
            : null;
        yield* current;
        current.destroy();
        current = null;
        pos = windowEnd + 1;
      }
    } finally {
      current?.destroy();
      next?.destroy();
    }
  }
  return Readable.from(windows(), { objectMode: false });
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
