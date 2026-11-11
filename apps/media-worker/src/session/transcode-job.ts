import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { completedSegmentsFromPlaylist } from '@streaming/media-core';

export type JobState = 'running' | 'paused' | 'exited';

export interface JobExit {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  stoppedByUs: boolean;
}

interface JobEvents {
  segment: [index: number];
  exit: [JobExit];
}

/**
 * One ffmpeg process producing segments from `startSegment` onwards.
 * Completion is detected from ffmpeg's own job playlist, which it rewrites
 * atomically (temp_file) after each segment is fully written.
 */
export class TranscodeJob extends EventEmitter<JobEvents> {
  private proc: ChildProcess | null = null;
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<number>();
  private stderr = '';
  private stopping = false;
  private _state: JobState = 'running';
  private _head: number;
  private scanning: Promise<void> | null = null;

  constructor(
    readonly id: string,
    readonly startSegment: number,
    private readonly ffmpegPath: string,
    private readonly args: string[],
    private readonly playlistPath: string,
  ) {
    super();
    this._head = startSegment - 1;
  }

  get state(): JobState {
    return this._state;
  }

  /** Highest segment index this job has completed (startSegment - 1 if none). */
  get head(): number {
    return this._head;
  }

  get alive(): boolean {
    return this._state !== 'exited';
  }

  start(): void {
    const proc = spawn(this.ffmpegPath, this.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4096);
    });
    proc.on('error', (err) => {
      this.stderr += `\nspawn error: ${err.message}`;
    });
    proc.on('close', (code, signal) => {
      void this.finish(code, signal);
    });

    const dir = path.dirname(this.playlistPath);
    const base = path.basename(this.playlistPath);
    try {
      this.watcher = watch(dir, (_event, filename) => {
        if (filename === base) this.scheduleScan();
      });
      this.watcher.on('error', () => {
        /* polling below remains as fallback */
      });
    } catch {
      this.watcher = null;
    }
    // Fallback for filesystems without reliable inotify (network/overlay volumes).
    this.pollTimer = setInterval(() => {
      this.scheduleScan();
    }, 1000);
    this.pollTimer.unref();
  }

  pause(): void {
    if (this._state !== 'running' || !this.proc) return;
    if (this.proc.kill('SIGSTOP')) this._state = 'paused';
  }

  resume(): void {
    if (this._state !== 'paused' || !this.proc) return;
    if (this.proc.kill('SIGCONT')) this._state = 'running';
  }

  stop(): void {
    if (!this.alive || !this.proc) return;
    this.stopping = true;
    this.proc.kill('SIGKILL');
  }

  private scheduleScan(): void {
    this.scanning ??= this.scan().finally(() => {
      this.scanning = null;
    });
  }

  private async scan(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.playlistPath, 'utf8');
    } catch {
      return; // not written yet
    }
    const indices = completedSegmentsFromPlaylist(text).sort((a, b) => a - b);
    for (const index of indices) {
      if (this.seen.has(index)) continue;
      this.seen.add(index);
      if (index > this._head) this._head = index;
      this.emit('segment', index);
    }
  }

  private async finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.scanning) await this.scanning;
    await this.scan();
    this._state = 'exited';
    this.emit('exit', {
      ok: code === 0,
      code,
      signal,
      stderrTail: this.stderr.trim(),
      stoppedByUs: this.stopping,
    });
  }
}
