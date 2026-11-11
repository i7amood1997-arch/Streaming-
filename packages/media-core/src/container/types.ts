/** Random access to a (possibly still downloading) source file. */
export interface ByteRangeReader {
  readonly size: number;
  /** Reads exactly `length` bytes at `offset` (fewer only at end of file). */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bufferReader(buf: Uint8Array): ByteRangeReader {
  return {
    size: buf.length,
    read: (offset, length) =>
      Promise.resolve(buf.subarray(offset, Math.min(buf.length, offset + length))),
  };
}

export interface KeyframeEntry {
  /** Presentation time in seconds, in the container's own timeline (what ffmpeg reports with -copyts). */
  timeSec: number;
  /** Monotonic byte counter used to estimate per-segment bitrate. */
  byteMark: number;
}

export interface SourceIndex {
  container: 'mp4' | 'matroska';
  durationSec: number;
  video: {
    codec: 'h264' | 'hevc' | 'other';
    /** RFC 6381 codec string derived from avcC/hvcC, when the codec is supported. */
    codecString: string | null;
    keyframes: KeyframeEntry[];
    /** byteMark value at the end of the media. */
    endByteMark: number;
    /** True when byteMark counts only video bytes (MP4); false when it includes all tracks (MKV). */
    videoOnlyBytes: boolean;
  };
}

/** The source cannot be indexed without reading the whole file (or at all). */
export class UnsupportedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSourceError';
  }
}

/** Refuse to buffer index structures larger than this (moov / Cues). */
export const MAX_INDEX_BYTES = 128 * 1024 * 1024;
