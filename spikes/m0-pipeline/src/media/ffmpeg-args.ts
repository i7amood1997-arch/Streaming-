import { AUDIO_BITRATE } from './plan.js';
import type { PlaybackPlan } from './plan.js';

export interface TranscodeJobSpec {
  inputUrl: string;
  videoStreamIndex: number;
  plan: PlaybackPlan;
  startSegment: number;
  segmentDurationSec: number;
  /** Absolute start time of every segment from `startSegment` to the end. */
  segmentStartTimes: number[];
  /** Directory receiving `seg-<n>.m4s` files (shared by all jobs of a session). */
  mediaDir: string;
  /** Job playlist path; ffmpeg writes the init segment next to it. */
  jobPlaylistPath: string;
  initFileName: string;
  threads: number;
  preset: string;
  readTimeoutSec: number;
}

/**
 * Builds the ffmpeg command for one on-demand transcode job.
 *
 * Invariants that make restarts at arbitrary segments seamless (validated in
 * docs/feasibility/M0-pipeline-spike.md):
 * - `-ss` before `-i` with `-copyts`: output keeps source timestamps, so a
 *   segment's tfdt is the same whichever job encoded it.
 * - `-force_key_frames <absolute list>`: list entries are compared with the
 *   (copyts) absolute frame pts, so IDRs land on the first frame >= k*d no
 *   matter where the job started. (The `expr:` form is NOT usable: its `t` is
 *   relative to the job's first decoded frame, which drifts by up to a frame
 *   after a seek and misaligns segments between jobs.)
 * - `-sc_threshold 0` and a large GOP: no other keyframes, so the HLS muxer
 *   (with hls_time = d/2) can only cut at those boundaries.
 * - `movflags=+frag_discont`: byte-identical init segments across jobs and
 *   absolute fragment decode times.
 */
export function buildTranscodeArgs(spec: TranscodeJobSpec): string[] {
  const { plan } = spec;
  const d = spec.segmentDurationSec;
  const startSec = spec.startSegment * d;
  const v = plan.video;
  const level = `${Math.floor(v.h264Level / 10)}.${v.h264Level % 10}`;
  const filters = [
    `scale=w=${v.outputWidth}:h=${v.outputHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    'format=yuv420p',
  ];
  if (v.capFrameRate) filters.push(`fps=${v.frameRate}`);

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-rw_timeout',
    String(spec.readTimeoutSec * 1_000_000),
  ];
  if (startSec > 0) args.push('-ss', startSec.toFixed(3));
  args.push('-i', spec.inputUrl, '-map', `0:${spec.videoStreamIndex}`);
  if (plan.audio) args.push('-map', `0:${plan.audio.streamIndex}`);
  args.push(
    '-copyts',
    '-start_at_zero',
    '-avoid_negative_ts',
    'disabled',
    '-max_muxing_queue_size',
    '2048',
    '-threads',
    String(spec.threads),
    '-vf',
    filters.join(','),
    '-c:v',
    'libx264',
    '-preset',
    spec.preset,
    '-profile:v',
    'high',
    '-level:v',
    level,
    '-crf',
    '21',
    '-maxrate',
    String(v.rendition.maxVideoBitrate),
    '-bufsize',
    String(v.rendition.maxVideoBitrate * 2),
    '-sc_threshold',
    '0',
    '-g',
    String(Math.ceil(d * v.frameRate * 4)),
    '-force_key_frames:v',
    spec.segmentStartTimes.map((t) => t.toFixed(3)).join(','),
  );
  if (plan.audio) {
    args.push('-c:a', 'aac', '-b:a', String(AUDIO_BITRATE), '-ac', '2', '-ar', '48000');
  }
  args.push(
    '-f',
    'hls',
    '-hls_time',
    String(d / 2),
    '-hls_segment_type',
    'fmp4',
    '-hls_segment_options',
    'movflags=+frag_discont',
    '-hls_flags',
    'temp_file+independent_segments',
    '-hls_playlist_type',
    'event',
    '-hls_list_size',
    '0',
    '-start_number',
    String(spec.startSegment),
    '-hls_fmp4_init_filename',
    spec.initFileName,
    '-hls_segment_filename',
    `${spec.mediaDir}/seg-%d.m4s`,
    spec.jobPlaylistPath,
  );
  return args;
}

/** Segment indices already listed (i.e. fully written) in an ffmpeg job playlist. */
export function completedSegmentsFromPlaylist(playlist: string): number[] {
  const out: number[] = [];
  for (const match of playlist.matchAll(/^(?:.*\/)?seg-(\d+)\.m4s\s*$/gm)) {
    out.push(Number(match[1]));
  }
  return out;
}
