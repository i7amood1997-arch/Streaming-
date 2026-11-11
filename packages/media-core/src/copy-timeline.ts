import type { KeyframeEntry } from './container/types.js';
import type { SegmentTiming } from './playlist.js';

/**
 * Seek offset added to a boundary when starting a stream-copy job.
 *
 * ffmpeg's CLI pulls the seek target back by ~0.13 s for demuxers that seek
 * by DTS when B-frames are present (Matroska), which would otherwise land on
 * the previous keyframe. Seeking 0.2 s past the boundary lands exactly on it
 * for both MP4 (seeks by PTS) and Matroska, provided the next keyframe is
 * further away than MIN_KEYFRAME_GAP_SEC. Stream copy does not drop packets
 * before -ss, so the output still starts at the boundary keyframe.
 * (Validated in docs/feasibility/M2-copy-mode.md.)
 */
export const COPY_SEEK_OFFSET_SEC = 0.2;
export const MIN_KEYFRAME_GAP_SEC = 0.3;

export interface CopySegment extends SegmentTiming {
  /** Absolute container time of the segment's first keyframe. */
  boundarySec: number;
  /** Absolute container time of the next segment's keyframe (undefined for the last). */
  nextBoundarySec: number | undefined;
}

export interface CopyTimeline {
  segments: CopySegment[];
  /** Highest per-segment bitrate (bits/s) estimated from byte marks. */
  peakBitrate: number;
  averageBitrate: number;
}

/**
 * Chooses segment boundaries on real keyframes: greedily the first usable
 * keyframe at least `targetSec` after the previous boundary. GOPs longer than
 * the target produce longer segments (stream copy cannot cut inside a GOP).
 */
export function copySegmentTimeline(
  keyframes: readonly KeyframeEntry[],
  durationSec: number,
  targetSec: number,
  endByteMark: number,
): CopyTimeline {
  if (keyframes.length === 0) throw new RangeError('No keyframes');
  const sorted = [...keyframes].sort((a, b) => a.timeSec - b.timeSec);
  const first = sorted[0];
  if (!first) throw new RangeError('No keyframes');
  const boundaries: KeyframeEntry[] = [first];
  for (let i = 1; i < sorted.length; i++) {
    const kf = sorted[i];
    const last = boundaries.at(-1);
    if (!kf || !last) continue;
    const nextTime = sorted[i + 1]?.timeSec ?? durationSec;
    if (nextTime - kf.timeSec < MIN_KEYFRAME_GAP_SEC) continue;
    if (kf.timeSec >= last.timeSec + targetSec && durationSec - kf.timeSec >= 1) {
      boundaries.push(kf);
    }
  }

  const segments: CopySegment[] = boundaries.map((b, index) => {
    const next = boundaries[index + 1];
    // The playlist timeline starts at 0 even if the first keyframe is slightly later.
    const startSec = index === 0 ? 0 : b.timeSec;
    const endSec = next ? next.timeSec : durationSec;
    return {
      index,
      startSec,
      durationSec: Math.max(0.001, endSec - startSec),
      boundarySec: b.timeSec,
      nextBoundarySec: next?.timeSec,
    };
  });

  let peak = 0;
  for (let i = 0; i < boundaries.length; i++) {
    const seg = segments[i];
    const from = boundaries[i]?.byteMark ?? 0;
    const to = boundaries[i + 1]?.byteMark ?? endByteMark;
    if (seg && seg.durationSec > 0.5) peak = Math.max(peak, ((to - from) * 8) / seg.durationSec);
  }
  const average = durationSec > 0 ? ((endByteMark - (first.byteMark || 0)) * 8) / durationSec : 0;
  return { segments, peakBitrate: Math.ceil(peak), averageBitrate: Math.ceil(average) };
}
