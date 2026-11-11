import { appendFile, copyFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SegmentTiming } from '@streaming/media-core';
import type { Config } from '../config.js';
import { segmentNotReady, transcodeFailed } from '../errors.js';
import type { Semaphore } from './semaphore.js';
import type { JobExit, SegmentProducer } from './transcode-job.js';

export type TrackKind = 'video' | 'audio';

export interface ProducerHooks {
  onDrift: (index: number, plannedSec: number, actualSec: number) => void;
}

export interface TrackInit {
  kind: TrackKind;
  timeline: SegmentTiming[];
  /** Directory receiving this track's init.mp4 and seg-<n>.m4s. */
  mediaDir: string;
  initialSegment: number;
  /** Builds the producer for a (re)start at `startSegment`. */
  createProducer: (startSegment: number, id: string, hooks: ProducerHooks) => SegmentProducer;
  /** Video transcoding is CPU-bound and limited by a worker-wide semaphore; copy and audio are not. */
  usesTranscodeSlot: boolean;
}

const MAX_CONSECUTIVE_FAILURES = 3;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface TrackStats {
  jobsStarted: number;
  seekRestarts: number;
  segmentsServed: number;
  pauses: number;
  /** Copy mode: segments whose actual length differed from the planned one. */
  driftEvents: number;
  completedSegments: number;
  job: { id: string; startSegment: number; head: number; state: string } | null;
}

/**
 * On-demand production of one HLS media playlist's segments (video or audio):
 * segments are produced ahead of the playhead, the producer is paused when too
 * far ahead, and restarted at the requested segment when the viewer seeks
 * outside the range being produced.
 */
export class TrackPipeline {
  readonly kind: TrackKind;
  readonly timeline: SegmentTiming[];
  private readonly mediaDir: string;
  private readonly createProducer: TrackInit['createProducer'];
  private readonly usesTranscodeSlot: boolean;
  private readonly completed = new Set<number>();
  /** onSegment handlers still running (they may await the init copy). */
  private readonly inFlight = new Set<Promise<void>>();
  /** Segments at or beyond the last playlist index, held until the producer exits. */
  private readonly tailSeen = new Set<number>();
  private readonly waiters = new Map<number, Set<Waiter>>();
  private job: SegmentProducer | null = null;
  private releaseSlot: (() => void) | null = null;
  private jobSeq = 0;
  private lastRequested = 0;
  private initReady = false;
  private initWaiters = new Set<Waiter>();
  private starting: Promise<void> | null = null;
  private disposed = false;
  private consecutiveFailures = 0;
  private readonly stats_ = {
    jobsStarted: 0,
    seekRestarts: 0,
    segmentsServed: 0,
    pauses: 0,
    driftEvents: 0,
  };

  constructor(
    init: TrackInit,
    private readonly config: Config,
    private readonly transcodeSlots: Semaphore,
  ) {
    this.kind = init.kind;
    this.timeline = init.timeline;
    this.createProducer = init.createProducer;
    this.usesTranscodeSlot = init.usesTranscodeSlot;
    this.lastRequested = Math.min(Math.max(0, init.initialSegment), init.timeline.length - 1);
    this.mediaDir = init.mediaDir;
  }

  get stats(): TrackStats {
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
    if (this.initReady) return this.initPath;
    await this.ensureJobFor(this.lastRequested);
    await this.wait(this.initWaiters, () => this.initReady, -1);
    return this.initPath;
  }

  async getSegment(index: number): Promise<string> {
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

  dispose(): void {
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
      throw transcodeFailed(`encoder failed repeatedly for this ${this.kind} track`);
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
    if (this.usesTranscodeSlot) {
      this.releaseSlot = await this.transcodeSlots.acquire(
        this.config.segmentWaitTimeoutSec * 1000,
      );
    }
    if (this.disposed) {
      this.freeSlot();
      return;
    }
    const id = `${this.kind === 'video' ? 'v' : 'a'}${++this.jobSeq}`;
    const job = this.createProducer(startSegment, id, {
      onDrift: () => {
        this.stats_.driftEvents += 1;
      },
    });
    job.on('segment', (index) => {
      const handled = this.onSegment(job, index, job.initPath).finally(() => {
        this.inFlight.delete(handled);
      });
      this.inFlight.add(handled);
    });
    job.on('exit', (exit) => {
      this.onJobExit(job, exit);
    });
    this.job = job;
    this.stats_.jobsStarted += 1;
    job.start();
  }

  private async onSegment(job: SegmentProducer, index: number, jobInitPath: string): Promise<void> {
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
    // The last listed segment is only final once the producer has finished:
    // a time-cut producer (audio) may write the title's tail as extra segments
    // beyond the playlist, which finalizeTail() appends to it.
    if (index >= this.timeline.length - 1) {
      this.tailSeen.add(index);
      return;
    }
    this.markComplete(index);
    if (job === this.job) this.applyThrottle();
  }

  private markComplete(index: number): void {
    this.completed.add(index);
    this.settle(this.waiters.get(index));
    this.waiters.delete(index);
  }

  /** Appends overflow segments (fMP4 fragments) to the last listed segment. */
  private async finalizeTail(): Promise<void> {
    const last = this.timeline.length - 1;
    if (!this.tailSeen.has(last)) return;
    const overflow = [...this.tailSeen].filter((i) => i > last).sort((a, b) => a - b);
    for (const i of overflow) {
      await appendFile(this.segmentPath(last), await readFile(this.segmentPath(i)));
      await rm(this.segmentPath(i), { force: true });
    }
    this.tailSeen.clear();
    this.markComplete(last);
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

  private onJobExit(job: SegmentProducer, exit: JobExit): void {
    if (job !== this.job) return; // superseded by a seek restart
    this.freeSlot();
    if (exit.stoppedByUs) return;
    if (exit.ok) {
      void Promise.all(this.inFlight)
        .then(() => this.finalizeTail())
        .then(
          () => {
            this.failUnproduced();
          },
          (err: unknown) => {
            this.failAll(
              transcodeFailed(
                `finalizing tail: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          },
        );
      return;
    }
    this.consecutiveFailures += 1;
    this.failAll(
      transcodeFailed(exit.stderrTail.split('\n').slice(-3).join(' | ') || `exit ${exit.code}`),
    );
    this.job = null;
  }

  /** Producer reached the end; anything still awaited will never be produced. */
  private failUnproduced(): void {
    for (const [index, set] of this.waiters) {
      if (!this.completed.has(index))
        this.settle(set, transcodeFailed(`segment ${index} not produced`));
    }
    this.waiters.clear();
  }

  private failAll(err: Error): void {
    for (const set of this.waiters.values()) this.settle(set, err);
    this.waiters.clear();
    this.settle(this.initWaiters, err);
  }

  private freeSlot(): void {
    this.releaseSlot?.();
    this.releaseSlot = null;
  }
}
