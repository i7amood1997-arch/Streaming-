import { copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { segmentNotReady, transcodeFailed } from '../errors.js';
import { buildTranscodeArgs } from '@streaming/media-core';
import type { PlaybackPlan } from '@streaming/media-core';
import type { SegmentTiming } from '@streaming/media-core';
import type { MediaInfo } from '@streaming/media-core';
import type { Semaphore } from './semaphore.js';
import { TranscodeJob } from './transcode-job.js';
import type { JobExit } from './transcode-job.js';

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

export interface SessionInit {
  id: string;
  contentId: string;
  dir: string;
  inputUrl: string;
  info: MediaInfo;
  plan: PlaybackPlan;
  timeline: SegmentTiming[];
  subtitles: SubtitleTrack[];
  expiresAtSec: number;
  /** Segment the viewer starts at (resume position); the first encoder starts there. */
  initialSegment: number;
  onDispose: () => Promise<void>;
}

const MAX_CONSECUTIVE_FAILURES = 3;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SessionStats {
  jobsStarted: number;
  seekRestarts: number;
  segmentsServed: number;
  pauses: number;
  completedSegments: number;
  job: { id: string; startSegment: number; head: number; state: string } | null;
}

/**
 * A viewer's playback of one title at one rendition. Owns the on-demand
 * transcoder: segments are produced ahead of the playhead, the encoder is
 * paused when too far ahead (SIGSTOP), and restarted at the requested segment
 * when the viewer seeks outside the range being produced.
 */
export class PlaybackSession {
  readonly id: string;
  readonly contentId: string;
  readonly info: MediaInfo;
  readonly plan: PlaybackPlan;
  readonly timeline: SegmentTiming[];
  readonly subtitles: SubtitleTrack[];
  readonly expiresAtSec: number;
  readonly createdAt = Date.now();
  lastAccessMs = Date.now();

  private readonly mediaDir: string;
  private readonly jobsDir: string;
  private readonly inputUrl: string;
  private readonly onDispose: () => Promise<void>;
  private readonly completed = new Set<number>();
  private readonly waiters = new Map<number, Set<Waiter>>();
  private job: TranscodeJob | null = null;
  private releaseSlot: (() => void) | null = null;
  private jobSeq = 0;
  private lastRequested = 0;
  private initReady = false;
  private initWaiters = new Set<Waiter>();
  private starting: Promise<void> | null = null;
  private disposed = false;
  private consecutiveFailures = 0;
  private readonly stats_ = { jobsStarted: 0, seekRestarts: 0, segmentsServed: 0, pauses: 0 };

  constructor(
    init: SessionInit,
    private readonly config: Config,
    private readonly transcodeSlots: Semaphore,
  ) {
    this.id = init.id;
    this.contentId = init.contentId;
    this.info = init.info;
    this.plan = init.plan;
    this.timeline = init.timeline;
    this.subtitles = init.subtitles;
    this.expiresAtSec = init.expiresAtSec;
    this.inputUrl = init.inputUrl;
    this.onDispose = init.onDispose;
    this.lastRequested = Math.min(Math.max(0, init.initialSegment), init.timeline.length - 1);
    this.mediaDir = path.join(init.dir, 'media');
    this.jobsDir = path.join(init.dir, 'jobs');
  }

  touch(): void {
    this.lastAccessMs = Date.now();
  }

  get stats(): SessionStats {
    return {
      ...this.stats_,
      completedSegments: this.completed.size,
      job: this.job
        ? {
            id: this.job.id,
            startSegment: this.job.startSegment,
            head: this.job.head,
            state: this.job.state,
          }
        : null,
    };
  }

  get initPath(): string {
    return path.join(this.mediaDir, 'init.mp4');
  }

  segmentPath(index: number): string {
    return path.join(this.mediaDir, `seg-${index}.m4s`);
  }

  async getInit(): Promise<string> {
    this.touch();
    if (this.initReady) return this.initPath;
    await this.ensureJobFor(this.lastRequested);
    await this.wait(this.initWaiters, () => this.initReady, -1);
    return this.initPath;
  }

  async getSegment(index: number): Promise<string> {
    this.touch();
    this.lastRequested = index;
    if (this.completed.has(index)) {
      this.applyThrottle();
      this.stats_.segmentsServed += 1;
      return this.segmentPath(index);
    }
    await this.ensureJobFor(index);
    let set = this.waiters.get(index);
    if (!set) {
      set = new Set();
      this.waiters.set(index, set);
    }
    await this.wait(set, () => this.completed.has(index), index);
    this.stats_.segmentsServed += 1;
    return this.segmentPath(index);
  }

  /** Stops the encoder (e.g. viewer paused for a long time); segments stay on disk. */
  stopJob(): void {
    this.job?.stop();
    this.freeSlot();
  }

  get hasActiveJob(): boolean {
    return this.job?.alive === true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopJob();
    const err = new Error('Session closed');
    for (const set of [...this.waiters.values(), this.initWaiters]) {
      for (const w of set) {
        clearTimeout(w.timer);
        w.reject(err);
      }
    }
    this.waiters.clear();
    this.initWaiters.clear();
    await this.onDispose();
  }

  private wait(set: Set<Waiter>, done: () => boolean, index: number): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          set.delete(waiter);
          reject(segmentNotReady(index));
        }, this.config.segmentWaitTimeoutSec * 1000),
      };
      set.add(waiter);
    });
  }

  private settle(set: Set<Waiter> | undefined, err?: Error): void {
    if (!set) return;
    for (const w of set) {
      clearTimeout(w.timer);
      if (err) w.reject(err);
      else w.resolve();
    }
    set.clear();
  }

  /** Makes sure an encoder will produce `index` soon; restarts it on a seek. */
  private async ensureJobFor(index: number): Promise<void> {
    if (this.starting) await this.starting;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw transcodeFailed('encoder failed repeatedly for this session');
    }
    const job = this.job;
    if (
      job?.alive &&
      index >= job.startSegment &&
      index <= job.head + 1 + this.config.seekRestartThreshold
    ) {
      job.resume();
      return;
    }
    if (job?.alive) this.stats_.seekRestarts += 1;
    this.starting = this.startJob(index).finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async startJob(startSegment: number): Promise<void> {
    this.stopJob();
    this.releaseSlot = await this.transcodeSlots.acquire(this.config.segmentWaitTimeoutSec * 1000);
    if (this.disposed) {
      this.freeSlot();
      return;
    }
    const id = `j${++this.jobSeq}`;
    const playlistPath = path.join(this.jobsDir, `${id}.m3u8`);
    const initFileName = `${id}-init.mp4`;
    const job = new TranscodeJob(
      id,
      startSegment,
      this.config.ffmpegPath,
      buildTranscodeArgs({
        inputUrl: this.inputUrl,
        videoStreamIndex: this.info.video.index,
        plan: this.plan,
        startSegment,
        segmentDurationSec: this.config.segmentDurationSec,
        segmentStartTimes: this.timeline.slice(startSegment).map((t) => t.startSec),
        mediaDir: this.mediaDir,
        jobPlaylistPath: playlistPath,
        initFileName,
        threads: this.config.ffmpegThreads,
        preset: this.config.x264Preset,
        readTimeoutSec: this.config.sourceReadTimeoutSec,
      }),
      playlistPath,
    );
    job.on('segment', (index) => {
      void this.onSegment(job, index, path.join(this.jobsDir, initFileName));
    });
    job.on('exit', (exit) => {
      this.onJobExit(job, exit);
    });
    this.job = job;
    this.stats_.jobsStarted += 1;
    job.start();
  }

  private async onSegment(job: TranscodeJob, index: number, jobInitPath: string): Promise<void> {
    if (!this.initReady) {
      // All jobs emit byte-identical init segments (movflags=+frag_discont),
      // so the first one written becomes the session's canonical init.mp4.
      try {
        await stat(jobInitPath);
        await copyFile(jobInitPath, this.initPath);
        this.initReady = true;
        this.settle(this.initWaiters);
      } catch {
        /* init not flushed yet; retried on next segment */
      }
    }
    this.consecutiveFailures = 0;
    this.completed.add(index);
    this.settle(this.waiters.get(index));
    this.waiters.delete(index);
    if (job === this.job) this.applyThrottle();
  }

  private applyThrottle(): void {
    const job = this.job;
    if (!job?.alive) return;
    const ahead = job.head - this.lastRequested;
    if (job.state === 'running' && ahead > this.config.maxSegmentsAhead) {
      job.pause();
      this.stats_.pauses += 1;
    } else if (job.state === 'paused' && ahead <= this.config.maxSegmentsAhead / 2) {
      job.resume();
    }
  }

  private onJobExit(job: TranscodeJob, exit: JobExit): void {
    if (job !== this.job) return; // superseded by a seek restart
    this.freeSlot();
    if (exit.stoppedByUs) return;
    if (exit.ok) {
      // Encoder reached the end; anything still awaited will never be produced.
      for (const [index, set] of this.waiters) {
        if (!this.completed.has(index))
          this.settle(set, transcodeFailed(`segment ${index} not produced`));
      }
      this.waiters.clear();
      return;
    }
    this.consecutiveFailures += 1;
    const err = transcodeFailed(
      exit.stderrTail.split('\n').slice(-3).join(' | ') || `exit ${exit.code}`,
    );
    for (const set of this.waiters.values()) this.settle(set, err);
    this.waiters.clear();
    this.settle(this.initWaiters, err);
    this.job = null;
  }

  private freeSlot(): void {
    this.releaseSlot?.();
    this.releaseSlot = null;
  }
}
