import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Catalog } from '../catalog.js';
import type { Config } from '../config.js';
import { capacityExceeded, notFound, sourceUnavailable } from '../errors.js';
import { planPlayback } from '../media/plan.js';
import type { ClientCapabilities, Quality } from '../media/plan.js';
import { segmentTimeline } from '../media/playlist.js';
import { probeMedia } from '../media/probe.js';
import { decodeSubtitleBytes } from '../subtitles/decode.js';
import { detectSidecarSubtitles, languageInfo } from '../subtitles/language.js';
import { parseCues, toWebVtt } from '../subtitles/webvtt.js';
import type { TorrentEngine, TorrentHandle } from '../torrent/engine.js';
import type { TorrentSourceServer } from '../torrent/source-server.js';
import { PlaybackSession } from './playback-session.js';
import type { SubtitleTrack } from './playback-session.js';
import { Semaphore } from './semaphore.js';

export interface CreateSessionRequest {
  contentId: string;
  quality: Quality | 'auto';
  capabilities: ClientCapabilities;
  startPositionSec: number;
  preferredAudioLanguage?: string;
}

export interface ManagerDeps {
  config: Config;
  catalog: Catalog;
  engine: TorrentEngine;
  sourceServer: TorrentSourceServer;
  /** Extra peers to dial for every torrent (local test swarms only). */
  bootstrapPeers?: string[];
}

/**
 * Owns all playback sessions of a worker: admission control, creation
 * (torrent -> probe -> plan -> subtitles), lookup, idle reaping and the
 * on-disk lifecycle of each session's working directory.
 */
export class SessionManager {
  private readonly sessions = new Map<string, PlaybackSession>();
  private readonly creating = new Set<string>();
  private readonly transcodeSlots: Semaphore;
  private reaper: NodeJS.Timeout | null = null;
  private readonly sessionsDir: string;

  constructor(private readonly deps: ManagerDeps) {
    this.transcodeSlots = new Semaphore(deps.config.maxConcurrentTranscodes);
    this.sessionsDir = path.join(deps.config.workDir, 'sessions');
  }

  /** Removes directories left by a previous crash and starts the idle reaper. */
  async start(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    for (const entry of await readdir(this.sessionsDir)) {
      await rm(path.join(this.sessionsDir, entry), { recursive: true, force: true });
    }
    this.reaper = setInterval(() => {
      void this.reap();
    }, 5_000);
    this.reaper.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  get(id: string): PlaybackSession | undefined {
    return this.sessions.get(id);
  }

  list(): PlaybackSession[] {
    return [...this.sessions.values()];
  }

  async create(req: CreateSessionRequest): Promise<PlaybackSession> {
    const { config, catalog, engine, sourceServer } = this.deps;
    const entry = catalog.get(req.contentId);
    if (!entry) throw notFound(`Content ${req.contentId}`);
    if (this.sessions.size + this.creating.size >= config.maxSessions) {
      throw capacityExceeded('Maximum concurrent playback sessions reached');
    }
    const free = await freeDiskMiB(config.workDir);
    if (free < config.minFreeDiskMiB) {
      throw capacityExceeded(`Insufficient free disk (${free} MiB)`);
    }

    const id = randomUUID();
    const dir = path.join(this.sessionsDir, id);
    this.creating.add(id);
    let handle: TorrentHandle | null = null;
    try {
      await mkdir(path.join(dir, 'media'), { recursive: true });
      await mkdir(path.join(dir, 'jobs'), { recursive: true });
      await mkdir(path.join(dir, 'subs'), { recursive: true });

      const torrentFile = await catalog.readTorrentFile(entry);
      handle = await engine
        .acquire(torrentFile, entry.infoHash, { peers: this.deps.bootstrapPeers ?? [] })
        .catch((err: unknown) => {
          throw sourceUnavailable(err instanceof Error ? err.message : String(err));
        });
      const urlFor = sourceServer.register(id, handle);
      const inputUrl = urlFor(entry.videoFileIndex);

      const info = await probeMedia(config.ffprobePath, inputUrl, {
        timeoutMs: config.sourceReadTimeoutSec * 1000,
        readTimeoutSec: config.sourceReadTimeoutSec,
      }).catch((err: unknown) => {
        throw sourceUnavailable(
          `probe failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      const plan = planPlayback(info, {
        quality: req.quality,
        caps: req.capabilities,
        ...(req.preferredAudioLanguage
          ? { preferredAudioLanguage: req.preferredAudioLanguage }
          : {}),
      });
      const timeline = segmentTimeline(info.durationSec, config.segmentDurationSec);
      const subtitles = await prepareSidecarSubtitles(handle, path.join(dir, 'subs'));

      const acquired = handle;
      const session = new PlaybackSession(
        {
          id,
          contentId: entry.id,
          dir,
          inputUrl,
          info,
          plan,
          timeline,
          subtitles,
          initialSegment: Math.floor(req.startPositionSec / config.segmentDurationSec),
          // Valid for the title's duration plus generous headroom for pauses.
          expiresAtSec: Math.floor(Date.now() / 1000 + info.durationSec + 4 * 3600),
          onDispose: async () => {
            sourceServer.unregister(id);
            acquired.release();
            await rm(dir, { recursive: true, force: true });
          },
        },
        config,
        this.transcodeSlots,
      );
      this.sessions.set(id, session);
      return session;
    } catch (err) {
      sourceServer.unregister(id);
      handle?.release();
      await rm(dir, { recursive: true, force: true });
      throw err;
    } finally {
      this.creating.delete(id);
    }
  }

  async destroy(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.dispose();
    return true;
  }

  async shutdown(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }

  /** Two-level idle policy: stop the encoder quickly, delete the session later. */
  async reap(now = Date.now()): Promise<void> {
    const { sessionIdleTimeoutSec, jobIdleTimeoutSec } = this.deps.config;
    for (const session of this.list()) {
      const idleMs = now - session.lastAccessMs;
      if (idleMs > sessionIdleTimeoutSec * 1000 || now / 1000 > session.expiresAtSec) {
        await this.destroy(session.id);
      } else if (idleMs > jobIdleTimeoutSec * 1000 && session.hasActiveJob) {
        session.stopJob();
      }
    }
  }
}

async function freeDiskMiB(dir: string): Promise<number> {
  await mkdir(dir, { recursive: true });
  const s = await statfs(dir);
  return Math.floor((s.bavail * s.bsize) / (1024 * 1024));
}

/** Converts sidecar .srt/.vtt files shipped in the torrent to normalised WebVTT. */
export async function prepareSidecarSubtitles(
  handle: TorrentHandle,
  outDir: string,
): Promise<SubtitleTrack[]> {
  const tracks: SubtitleTrack[] = [];
  const seen = new Set<string>();
  for (const sidecar of detectSidecarSubtitles(handle.files)) {
    const key = `${sidecar.language}:${String(sidecar.forced)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lang = languageInfo(sidecar.language);
    const bytes = await handle.readFile(sidecar.fileIndex);
    const { text, encoding } = decodeSubtitleBytes(bytes, sidecar.language);
    const cues = parseCues(text);
    if (cues.length === 0) continue;
    const vtt = toWebVtt(cues, { rtl: lang.rtl ? { fixReversedPunctuation: true } : null });
    const slug = `${sidecar.language}${sidecar.forced ? '-forced' : ''}`;
    const file = path.join(outDir, `${slug}.vtt`);
    await writeFile(file, vtt, 'utf8');
    tracks.push({
      slug,
      language: lang.tag,
      name: sidecar.forced ? `${lang.nativeName} (forced)` : lang.nativeName,
      forced: sidecar.forced,
      rtl: lang.rtl,
      sourceEncoding: encoding,
      path: file,
    });
  }
  return tracks;
}
