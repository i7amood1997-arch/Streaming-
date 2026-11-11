import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildCopySegmentArgs, segmentDurationsFromPlaylist } from '@streaming/media-core';
import type { CopySegment } from '@streaming/media-core';
import type { JobEvents, JobExit, JobState, SegmentProducer } from './transcode-job.js';

export interface CopyProducerOptions {
  id: string;
  startSegment: number;
  segments: readonly CopySegment[];
  ffmpegPath: string;
  inputUrl: string;
  videoStreamIndex: number;
  audioStreamIndex: number | null;
  hvc1: boolean;
  jobsDir: string;
  mediaDir: string;
  readTimeoutSec: number;
  /** Called when ffmpeg's segment length differs from the plan (index/ffmpeg disagreement). */
  onDrift?: (index: number, plannedSec: number, actualSec: number) => void;
}

/** Tolerance before a planned/actual duration mismatch is reported as drift. */
const DRIFT_TOLERANCE_SEC = 0.1;

/**
 * Stream-copies segments one at a time, each with its own short ffmpeg run
 * (see buildCopySegmentArgs for why per-segment runs are exact). Sequential
 * by design: copy is I/O-bound on the torrent, and order matches playback.
 */
export class CopySegmentProducer extends EventEmitter<JobEvents> implements SegmentProducer {
  private proc: ChildProcess | null = null;
  private _state: JobState = 'running';
  private _head: number;
  private stopping = false;
  private resumeWaiter: (() => void) | null = null;
  readonly initPath: string;

  constructor(private readonly opts: CopyProducerOptions) {
    super();
    this._head = opts.startSegment - 1;
    this.initPath = path.join(opts.jobsDir, `${opts.id}-init.mp4`);
  }

  get id(): string {
    return this.opts.id;
  }
  get startSegment(): number {
    return this.opts.startSegment;
  }
  get head(): number {
    return this._head;
  }
  get state(): JobState {
    return this._state;
  }
  get alive(): boolean {
    return this._state !== 'exited';
  }

  start(): void {
    void this.run();
  }

  /** Finishes the segment in progress, then waits. */
  pause(): void {
    if (this._state === 'running') this._state = 'paused';
  }

  resume(): void {
    if (this._state !== 'paused') return;
    this._state = 'running';
    this.resumeWaiter?.();
    this.resumeWaiter = null;
  }

  stop(): void {
    if (!this.alive) return;
    this.stopping = true;
    this.proc?.kill('SIGKILL');
    this.resumeWaiter?.();
    this.resumeWaiter = null;
  }

  private isStopping(): boolean {
    return this.stopping;
  }

  private async run(): Promise<void> {
    let exit: JobExit = { ok: true, code: 0, signal: null, stderrTail: '', stoppedByUs: false };
    for (let index = this.opts.startSegment; index < this.opts.segments.length; index++) {
      if (this._state === 'paused' && !this.isStopping()) {
        await new Promise<void>((resolve) => (this.resumeWaiter = resolve));
      }
      if (this.isStopping()) break;
      const result = await this.copySegment(index);
      // stop() may have been called while awaiting.
      if (this.isStopping()) break;
      if (!result.ok) {
        exit = result;
        break;
      }
      this._head = index;
      this.emit('segment', index);
    }
    this._state = 'exited';
    this.emit('exit', this.isStopping() ? { ...exit, ok: false, stoppedByUs: true } : exit);
  }

  private async copySegment(index: number): Promise<JobExit> {
    const segment = this.opts.segments[index];
    if (!segment)
      return {
        ok: false,
        code: null,
        signal: null,
        stderrTail: 'no such segment',
        stoppedByUs: false,
      };
    const run = `${this.opts.id}-s${index}`;
    const playlist = path.join(this.opts.jobsDir, `${run}.m3u8`);
    const args = buildCopySegmentArgs({
      inputUrl: this.opts.inputUrl,
      videoStreamIndex: this.opts.videoStreamIndex,
      audioStreamIndex: this.opts.audioStreamIndex,
      segment,
      hvc1: this.opts.hvc1,
      segmentFilePattern: path.join(this.opts.jobsDir, `${run}-%d.m4s`),
      jobPlaylistPath: playlist,
      initFileName: path.basename(this.initPath),
      readTimeoutSec: this.opts.readTimeoutSec,
    });
    const { code, signal, stderr } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve) => {
      let stderrBuf = '';
      const proc = spawn(this.opts.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = proc;
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (c: string) => (stderrBuf = (stderrBuf + c).slice(-4096)));
      proc.on('error', (err) => (stderrBuf += `\nspawn error: ${err.message}`));
      proc.on('close', (c, s) => {
        resolve({ code: c, signal: s, stderr: stderrBuf });
      });
    });
    this.proc = null;
    try {
      if (code !== 0)
        return { ok: false, code, signal, stderrTail: stderr.trim(), stoppedByUs: this.stopping };
      const produced = path.join(this.opts.jobsDir, `${run}-${index}.m4s`);
      const durations = segmentDurationsFromPlaylist(await readFile(playlist, 'utf8'));
      const actual = durations.get(index);
      if (actual === undefined) {
        return {
          ok: false,
          code,
          signal,
          stderrTail: `segment ${index} missing from job playlist`,
          stoppedByUs: false,
        };
      }
      const planned = (segment.nextBoundarySec ?? Number.NaN) - segment.boundarySec;
      if (Number.isFinite(planned) && Math.abs(actual - planned) > DRIFT_TOLERANCE_SEC) {
        this.opts.onDrift?.(index, planned, actual);
      }
      await rename(produced, path.join(this.opts.mediaDir, `seg-${index}.m4s`));
      return { ok: true, code, signal, stderrTail: '', stoppedByUs: false };
    } finally {
      // Drop the partial following segment and the per-run playlist.
      const leftovers = (await readdir(this.opts.jobsDir)).filter(
        (f) => f.startsWith(`${run}-`) || f === `${run}.m3u8`,
      );
      await Promise.all(leftovers.map((f) => rm(path.join(this.opts.jobsDir, f), { force: true })));
    }
  }
}
