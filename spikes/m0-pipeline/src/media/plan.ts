import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from './probe.js';

export type Quality = '480p' | '720p' | '1080p' | '2160p';
export const QUALITIES: readonly Quality[] = ['480p', '720p', '1080p', '2160p'];

export interface Rendition {
  quality: Quality;
  maxWidth: number;
  maxHeight: number;
  /** Peak video bitrate (bits/s) enforced with VBV maxrate. */
  maxVideoBitrate: number;
}

/**
 * Transcode ladder. 2160p is deliberately absent: real-time 4K software
 * encoding is not economically viable per viewer, so 4K is only ever offered
 * as passthrough (remux) of a 4K source (milestone M2).
 */
export const TRANSCODE_LADDER: Readonly<Record<Exclude<Quality, '2160p'>, Rendition>> = {
  '480p': {
    quality: '480p',
    maxWidth: 854,
    maxHeight: 480,
    maxVideoBitrate: 1_600_000,
  },
  '720p': {
    quality: '720p',
    maxWidth: 1280,
    maxHeight: 720,
    maxVideoBitrate: 3_500_000,
  },
  '1080p': {
    quality: '1080p',
    maxWidth: 1920,
    maxHeight: 1080,
    maxVideoBitrate: 7_000_000,
  },
};

export const AUDIO_BITRATE = 160_000;

/** What the requesting client can decode, detected client-side via canPlayType/MSE. */
export interface ClientCapabilities {
  hevc: boolean;
  maxHeight: number;
}

export interface PlanReason {
  code: string;
  message: string;
}

export interface VideoPlan {
  action: 'transcode';
  rendition: Rendition;
  outputWidth: number;
  outputHeight: number;
  frameRate: number;
  /** Source is above 60 fps and must be resampled. */
  capFrameRate: boolean;
  /** level_idc, e.g. 40 for level 4.0. */
  h264Level: number;
  codecString: string;
  /** Source could be remuxed without re-encoding once copy mode exists. */
  copyEligible: boolean;
}

export interface AudioPlan {
  action: 'transcode';
  streamIndex: number;
  channels: 2;
  codecString: 'mp4a.40.2';
}

export interface PlaybackPlan {
  video: VideoPlan;
  audio: AudioPlan | null;
  /** Peak bandwidth for the EXT-X-STREAM-INF BANDWIDTH attribute (bits/s). */
  bandwidth: number;
  reasons: PlanReason[];
}

/** H.264 Annex A limits: [level_idc, MaxFS (macroblocks), MaxMBPS]. */
const H264_LEVELS: readonly (readonly [number, number, number])[] = [
  [30, 1620, 40_500],
  [31, 3600, 108_000],
  [32, 5120, 216_000],
  [40, 8192, 245_760],
  [41, 8192, 245_760],
  [42, 8704, 522_240],
  [50, 22_080, 589_824],
  [51, 36_864, 983_040],
  [52, 36_864, 2_073_600],
];

/** Smallest H.264 level whose frame-size and macroblock-rate limits fit the output. */
export function h264LevelFor(width: number, height: number, fps: number): number {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = frameMbs * fps;
  const level = H264_LEVELS.find(([, maxFs, maxMbps]) => frameMbs <= maxFs && mbps <= maxMbps);
  if (!level) throw new Error(`No H.264 level fits ${width}x${height}@${fps}`);
  return level[0];
}

const H264_PROFILE_IDC: Readonly<Record<string, { idc: number; constraints: number }>> = {
  'Constrained Baseline': { idc: 0x42, constraints: 0xe0 },
  Baseline: { idc: 0x42, constraints: 0x00 },
  Main: { idc: 0x4d, constraints: 0x40 },
  High: { idc: 0x64, constraints: 0x00 },
};

/** RFC 6381 codec string for H.264, e.g. High@4.1 -> avc1.640029. */
export function h264CodecString(profile: string, levelIdc: number): string {
  const p = H264_PROFILE_IDC[profile];
  if (!p) throw new Error(`Unsupported H.264 profile for HLS: ${profile}`);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(p.idc)}${hex(p.constraints)}${hex(levelIdc)}`;
}

/**
 * Would iOS/macOS Safari decode this video stream natively inside fMP4 HLS?
 * (H.264 8-bit 4:2:0 up to High@5.2; HEVC Main/Main10 on HEVC-capable devices.)
 */
export function isSafariCompatibleVideo(v: VideoStreamInfo, caps: ClientCapabilities): boolean {
  if (v.codec === 'h264') {
    return (
      (v.pixFmt === 'yuv420p' || v.pixFmt === 'yuvj420p') &&
      v.profile !== undefined &&
      v.profile in H264_PROFILE_IDC &&
      (v.level ?? 0) <= 52
    );
  }
  if (v.codec === 'hevc') {
    return caps.hevc && (v.profile === 'Main' || v.profile === 'Main 10');
  }
  return false;
}

export function isSafariCompatibleAudio(a: AudioStreamInfo): boolean {
  return a.codec === 'aac' && (a.profile === 'LC' || a.profile === undefined) && a.channels <= 2;
}

/** Picks the audio stream to play: default flag, then preferred language, then first. */
export function selectAudioStream(
  streams: AudioStreamInfo[],
  preferredLanguage?: string,
): AudioStreamInfo | undefined {
  return (
    (preferredLanguage ? streams.find((s) => s.language === preferredLanguage) : undefined) ??
    streams.find((s) => s.isDefault) ??
    streams[0]
  );
}

export function selectRendition(
  sourceHeight: number,
  requested: Quality | 'auto',
  caps: ClientCapabilities,
): { rendition: Rendition; reasons: PlanReason[] } {
  const reasons: PlanReason[] = [];
  const ladder = Object.values(TRANSCODE_LADDER);
  let target: Rendition;
  if (requested === '2160p') {
    reasons.push({
      code: 'UHD_REQUIRES_PASSTHROUGH',
      message: '2160p is only served by passthrough of a 4K source (not in M0); capped to 1080p.',
    });
    target = TRANSCODE_LADDER['1080p'];
  } else if (requested === 'auto') {
    target = TRANSCODE_LADDER['1080p'];
  } else {
    target = TRANSCODE_LADDER[requested];
  }
  const ceiling = Math.min(target.maxHeight, sourceHeight, caps.maxHeight);
  // Largest rung that does not upscale; sources below 480p keep their own size.
  const chosen =
    [...ladder].reverse().find((r) => r.maxHeight <= ceiling) ?? TRANSCODE_LADDER['480p'];
  if (chosen.quality !== target.quality) {
    reasons.push({
      code: 'QUALITY_CAPPED',
      message: `Requested ${target.quality} capped to ${chosen.quality} (source ${sourceHeight}p, client max ${caps.maxHeight}p).`,
    });
  }
  return { rendition: chosen, reasons };
}

/** Output size after "fit inside rendition box, never upscale, even dimensions". */
export function fitDimensions(
  srcW: number,
  srcH: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(srcW * scale), height: even(srcH * scale) };
}

export function planPlayback(
  info: MediaInfo,
  opts: { quality: Quality | 'auto'; caps: ClientCapabilities; preferredAudioLanguage?: string },
): PlaybackPlan {
  const reasons: PlanReason[] = [];
  const { rendition, reasons: rReasons } = selectRendition(
    info.video.height,
    opts.quality,
    opts.caps,
  );
  reasons.push(...rReasons);

  const copyEligible = isSafariCompatibleVideo(info.video, opts.caps);
  reasons.push(
    copyEligible
      ? {
          code: 'COPY_ELIGIBLE_NOT_IMPLEMENTED',
          message:
            'Source video is Safari-compatible and could be remuxed, but copy mode needs a keyframe index (milestone M2); transcoding.',
        }
      : {
          code: 'VIDEO_TRANSCODE_REQUIRED',
          message: `Source video ${info.video.codec}/${info.video.profile ?? '?'}/${info.video.pixFmt ?? '?'} is not natively decodable by Safari.`,
        },
  );
  if (info.video.hdr) {
    reasons.push({
      code: 'HDR_TONEMAP_MISSING',
      message: 'HDR source: SDR tone mapping is not implemented in M0; colours will be inaccurate.',
    });
  }

  const sourceFps = info.video.frameRate ?? 24;
  const frameRate = Math.min(sourceFps, 60);
  const { width, height } = fitDimensions(
    info.video.width,
    info.video.height,
    rendition.maxWidth,
    rendition.maxHeight,
  );

  const audioStream = selectAudioStream(info.audio, opts.preferredAudioLanguage);
  let audio: AudioPlan | null = null;
  if (audioStream) {
    audio = {
      action: 'transcode',
      streamIndex: audioStream.index,
      channels: 2,
      codecString: 'mp4a.40.2',
    };
    if (!isSafariCompatibleAudio(audioStream)) {
      reasons.push({
        code: 'AUDIO_TRANSCODE_REQUIRED',
        message: `Audio ${audioStream.codec} ${audioStream.channels}ch is transcoded to AAC-LC stereo.`,
      });
    }
  } else {
    reasons.push({ code: 'NO_AUDIO', message: 'Source has no audio stream.' });
  }

  const h264Level = h264LevelFor(width, height, frameRate);
  const bandwidth = Math.ceil((rendition.maxVideoBitrate + (audio ? AUDIO_BITRATE : 0)) * 1.1);
  return {
    video: {
      action: 'transcode',
      rendition,
      outputWidth: width,
      outputHeight: height,
      frameRate,
      capFrameRate: sourceFps > 60,
      h264Level,
      codecString: h264CodecString('High', h264Level),
      copyEligible,
    },
    audio,
    bandwidth,
    reasons,
  };
}
