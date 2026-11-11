import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Catalog } from '../catalog.js';
import type { Config } from '../config.js';
import { capacityExceeded, notFound, sourceUnavailable } from '../errors.js';
import {
  AUDIO_BITRATE,
  UnsupportedSourceError,
  buildTranscodeArgs,
  copySegmentTimeline,
  decodeSubtitleBytes,
  detectSidecarSubtitles,
  indexSource,
  languageInfo,
  parseCues,
  planPlayback,
  segmentTimeline,
  toWebVtt,
} from '@streaming/media-core';
import type {
  ClientCapabilities,
  CopySource,
  CopyTimeline,
  MediaInfo,
  Quality,
  SegmentTiming,
} from '@streaming/media-core';
import { probeMedia } from '../media/probe.js';
import { CopySegmentProducer } from './copy-producer.js';
import { TranscodeJob } from './transcode-job.js';
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
      const copy = await prepareCopy(handle, entry.videoFileIndex, info, config.segmentDurationSec);
      const plan = planPlayback(info, {
        quality: req.quality,
        caps: req.capabilities,
        ...(req.preferredAudioLanguage
          ? { preferredAudioLanguage: req.preferredAudioLanguage }
          : {}),
        ...(copy.source ? { copySource: copy.source } : {}),
      });
      if (copy.indexError && plan.video.action === 'transcode') {
        plan.reasons.push({ code: 'COPY_INDEX_ERROR', message: copy.indexError });
      }
      const copyTimeline = plan.video.action === 'copy' ? copy.timeline : undefined;
      const timeline: SegmentTiming[] =
        copyTimeline?.segments ?? segmentTimeline(info.durationSec, config.segmentDurationSec);
      const jobsDir = path.join(dir, 'jobs');
      const mediaDir = path.join(dir, 'media');
      const video = plan.video;
      const audioIndex = plan.audio?.streamIndex ?? null;
      const subtitles = await prepareSidecarSubtitles(handle, path.join(dir, 'subs'));

      const acquired = handle;
      const session = new PlaybackSession(
        {
          id,
          contentId: entry.id,
          dir,
          info,
          plan,
          timeline,
          subtitles,
          initialSegment: segmentIndexAt(timeline, req.startPositionSec),
          usesTranscodeSlot: video.action === 'transcode',
          createProducer: (startSegment, jobId, hooks) => {
            if (video.action === 'copy' && copyTimeline) {
              return new CopySegmentProducer({
                id: jobId,
                startSegment,
                segments: copyTimeline.segments,
                ffmpegPath: config.ffmpegPath,
                inputUrl,
                videoStreamIndex: info.video.index,
                audioStreamIndex: audioIndex,
                hvc1: video.hvc1,
                jobsDir,
                mediaDir,
                readTimeoutSec: config.sourceReadTimeoutSec,
                onDrift: hooks.onDrift,
              });
            }
            const playlistPath = path.join(jobsDir, `${jobId}.m3u8`);
            const initFileName = `${jobId}-init.mp4`;
            return new TranscodeJob(
              jobId,
              startSegment,
              config.ffmpegPath,
              buildTranscodeArgs({
                inputUrl,
                videoStreamIndex: info.video.index,
                plan,
                startSegment,
                segmentDurationSec: config.segmentDurationSec,
                segmentStartTimes: timeline.slice(startSegment).map((t) => t.startSec),
                mediaDir,
                jobPlaylistPath: playlistPath,
                initFileName,
                threads: config.ffmpegThreads,
                preset: config.x264Preset,
                readTimeoutSec: config.sourceReadTimeoutSec,
              }),
              playlistPath,
              path.join(jobsDir, initFileName),
            );
          },
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

/** Index of the segment containing `sec` (resume position). */
export function segmentIndexAt(timeline: readonly SegmentTiming[], sec: number): number {
  let found = 0;
  for (const seg of timeline) if (seg.startSec <= sec) found = seg.index;
  return found;
}

/**
 * Builds the keyframe index needed for stream copy by reading only the
 * container's index structures from the torrent. Any failure simply means
 * "no copy" and is reported as a plan reason.
 */
async function prepareCopy(
  handle: TorrentHandle,
  fileIndex: number,
  info: MediaInfo,
  segmentDurationSec: number,
): Promise<{ source?: CopySource; timeline?: CopyTimeline; indexError?: string }> {
  if (info.video.codec !== 'h264' && info.video.codec !== 'hevc') return {};
  try {
    const index = await indexSource(handle.reader(fileIndex));
    if (index.video.codec !== info.video.codec || !index.video.codecString) {
      return { indexError: 'Container index does not describe the probed video stream' };
    }
    const timeline = copySegmentTimeline(
      index.video.keyframes,
      info.durationSec,
      segmentDurationSec,
      index.video.endByteMark,
    );
    // MP4 byte marks count video only; add the audio track's rate.
    const audioRate = index.video.videoOnlyBytes
      ? Math.max(0, ...info.audio.map((a) => a.bitRate ?? AUDIO_BITRATE))
      : 0;
    return {
      timeline,
      source: {
        codec: info.video.codec,
        codecString: index.video.codecString,
        peakBitrate: timeline.peakBitrate + audioRate,
      },
    };
  } catch (err) {
    if (err instanceof UnsupportedSourceError) return { indexError: err.message };
    return { indexError: `Index failed: ${err instanceof Error ? err.message : String(err)}` };
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
