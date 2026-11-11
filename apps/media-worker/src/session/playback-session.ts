import path from 'node:path';
import type { MediaInfo, PlaybackPlan, SegmentTiming } from '@streaming/media-core';
import type { Config } from '../config.js';
import type { Semaphore } from './semaphore.js';
import { TrackPipeline } from './track-pipeline.js';
import type { TrackInit, TrackKind, TrackStats } from './track-pipeline.js';

export type { ProducerHooks, TrackKind } from './track-pipeline.js';

export interface SubtitleTrack {
  /** URL-safe identifier, e.g. `ar` or `en-forced`. */
  slug: string;
  language: string;
  name: string;
  forced: boolean;
  rtl: boolean;
  sourceEncoding: string;
  /** Absolute path of the generated .vtt file. */
  path: string;
}

type TrackSpec = Omit<TrackInit, 'kind' | 'mediaDir' | 'initialSegment'>;

export interface SessionInit {
  id: string;
  contentId: string;
  dir: string;
  info: MediaInfo;
  plan: PlaybackPlan;
  subtitles: SubtitleTrack[];
  expiresAtSec: number;
  /** Resume position; each track's first producer starts at the segment containing it. */
  startPositionSec: number;
  video: TrackSpec;
  /** Present when audio is delivered as a separate HLS rendition (EXT-X-MEDIA TYPE=AUDIO). */
  audio: TrackSpec | null;
  onDispose: () => Promise<void>;
}

/** Video-track stats at the top level (the common case), audio track stats nested. */
export type SessionStats = TrackStats & { audio: TrackStats | null };

/** Index of the segment containing `sec`. */
export function segmentIndexAt(timeline: readonly SegmentTiming[], sec: number): number {
  let found = 0;
  for (const seg of timeline) if (seg.startSec <= sec) found = seg.index;
  return found;
}

/**
 * A viewer's playback of one title at one rendition: a video track (with
 * muxed audio unless audio is a separate rendition), an optional audio
 * track, and subtitles. Owns the session's lifetime and working directory.
 */
export class PlaybackSession {
  readonly id: string;
  readonly contentId: string;
  readonly info: MediaInfo;
  readonly plan: PlaybackPlan;
  readonly subtitles: SubtitleTrack[];
  readonly expiresAtSec: number;
  readonly createdAt = Date.now();
  readonly video: TrackPipeline;
  readonly audio: TrackPipeline | null;
  lastAccessMs = Date.now();

  private readonly onDispose: () => Promise<void>;
  private disposed = false;

  constructor(init: SessionInit, config: Config, transcodeSlots: Semaphore) {
    this.id = init.id;
    this.contentId = init.contentId;
    this.info = init.info;
    this.plan = init.plan;
    this.subtitles = init.subtitles;
    this.expiresAtSec = init.expiresAtSec;
    this.onDispose = init.onDispose;
    const track = (kind: TrackKind, spec: TrackSpec) =>
      new TrackPipeline(
        {
          ...spec,
          kind,
          mediaDir: path.join(init.dir, kind === 'video' ? 'media' : 'audio'),
          initialSegment: segmentIndexAt(spec.timeline, init.startPositionSec),
        },
        config,
        transcodeSlots,
      );
    this.video = track('video', init.video);
    this.audio = init.audio ? track('audio', init.audio) : null;
  }

  /** Video segment timeline (what video/index.m3u8 describes). */
  get timeline(): SegmentTiming[] {
    return this.video.timeline;
  }

  touch(): void {
    this.lastAccessMs = Date.now();
  }

  track(kind: TrackKind): TrackPipeline | null {
    return kind === 'video' ? this.video : this.audio;
  }

  get stats(): SessionStats {
    return { ...this.video.stats, audio: this.audio?.stats ?? null };
  }

  getInit(): Promise<string> {
    this.touch();
    return this.video.getInit();
  }

  getSegment(index: number): Promise<string> {
    this.touch();
    return this.video.getSegment(index);
  }

  /** Stops all producers (e.g. viewer paused for a long time); segments stay on disk. */
  stopJob(): void {
    this.video.stopJob();
    this.audio?.stopJob();
  }

  get hasActiveJob(): boolean {
    return this.video.hasActiveJob || this.audio?.hasActiveJob === true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.video.dispose();
    this.audio?.dispose();
    await this.onDispose();
  }
}
