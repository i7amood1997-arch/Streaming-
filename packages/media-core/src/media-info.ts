/** Normalisation of ffprobe JSON output. Pure: no process execution. */
import { z } from 'zod';

const StreamSchema = z.object({
  index: z.number(),
  codec_type: z.string(),
  codec_name: z.string().optional(),
  codec_tag_string: z.string().optional(),
  profile: z.string().optional(),
  level: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  pix_fmt: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  channels: z.number().optional(),
  sample_rate: z.string().optional(),
  bit_rate: z.string().optional(),
  color_transfer: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  disposition: z.record(z.string(), z.number()).optional(),
});

const ProbeSchema = z.object({
  streams: z.array(StreamSchema),
  format: z.object({
    format_name: z.string(),
    duration: z.string().optional(),
    bit_rate: z.string().optional(),
  }),
});

export type ProbeStream = z.infer<typeof StreamSchema>;

export interface VideoStreamInfo {
  index: number;
  codec: string;
  profile: string | undefined;
  level: number | undefined;
  width: number;
  height: number;
  pixFmt: string | undefined;
  frameRate: number | undefined;
  hdr: boolean;
  /** Transfer characteristics: SDR, HDR10/Dolby-style PQ, or HLG. */
  videoRange: 'SDR' | 'PQ' | 'HLG';
}

export interface AudioStreamInfo {
  index: number;
  codec: string;
  profile: string | undefined;
  channels: number;
  sampleRate: number | undefined;
  language: string | undefined;
  isDefault: boolean;
  /** Bits/s as reported by the container, when known. */
  bitRate: number | undefined;
}

export interface SubtitleStreamInfo {
  index: number;
  codec: string;
  language: string | undefined;
  /** Bitmap subtitles (PGS, VobSub) cannot become WebVTT without OCR. */
  textBased: boolean;
}

export interface MediaInfo {
  container: string;
  durationSec: number;
  bitRate: number | undefined;
  video: VideoStreamInfo;
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
}

const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

export function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [num, den] = value.split('/').map(Number);
  if (num === undefined || !Number.isFinite(num) || num <= 0) return undefined;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den <= 0) return undefined;
  return num / den;
}

/** Converts raw ffprobe JSON into the normalised shape the planner consumes. */
export function toMediaInfo(raw: unknown): MediaInfo {
  const probe = ProbeSchema.parse(raw);
  const durationSec = Number(probe.format.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('Source has no usable duration (live or truncated stream?)');
  }
  const videoRaw = probe.streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.['attached_pic'] !== 1,
  );
  if (!videoRaw?.codec_name || !videoRaw.width || !videoRaw.height) {
    throw new Error('Source has no decodable video stream');
  }
  const transfer = videoRaw.color_transfer;
  const video: VideoStreamInfo = {
    index: videoRaw.index,
    codec: videoRaw.codec_name,
    profile: videoRaw.profile,
    level: videoRaw.level,
    width: videoRaw.width,
    height: videoRaw.height,
    pixFmt: videoRaw.pix_fmt,
    frameRate: parseFrameRate(videoRaw.avg_frame_rate) ?? parseFrameRate(videoRaw.r_frame_rate),
    hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67',
    videoRange: transfer === 'smpte2084' ? 'PQ' : transfer === 'arib-std-b67' ? 'HLG' : 'SDR',
  };
  const audio = probe.streams
    .filter((s) => s.codec_type === 'audio' && s.codec_name)
    .map((s): AudioStreamInfo => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      profile: s.profile,
      channels: s.channels ?? 2,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
      language: s.tags?.['language'],
      isDefault: s.disposition?.['default'] === 1,
      bitRate: s.bit_rate ? Number(s.bit_rate) : undefined,
    }));
  const subtitles = probe.streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s): SubtitleStreamInfo => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      language: s.tags?.['language'],
      textBased: TEXT_SUBTITLE_CODECS.has(s.codec_name ?? ''),
    }));
  return {
    container: probe.format.format_name,
    durationSec,
    bitRate: probe.format.bit_rate ? Number(probe.format.bit_rate) : undefined,
    video,
    audio,
    subtitles,
  };
}
