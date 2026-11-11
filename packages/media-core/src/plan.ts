import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from './media-info.js';

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

export interface TranscodeVideoPlan {
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
  /** Source video itself is Safari-compatible (copy was possible codec-wise). */
  copyEligible: boolean;
}

/** Stream copy (remux) of the source video: no re-encoding, original quality. */
export interface CopyVideoPlan {
  action: 'copy';
  codec: 'h264' | 'hevc';
  /** Exact RFC 6381 string from the source's avcC/hvcC. */
  codecString: string;
  outputWidth: number;
  outputHeight: number;
  frameRate: number;
  quality: Quality;
  /** Write HEVC with the hvc1 sample entry (required by Apple players). */
  hvc1: boolean;
  /** HLS VIDEO-RANGE of the untouched source (PQ/HLG for HDR). */
  videoRange: 'SDR' | 'PQ' | 'HLG';
}

export type VideoPlan = TranscodeVideoPlan | CopyVideoPlan;

export interface AudioPlan {
  action: 'transcode' | 'copy';
  /**
   * `muxed`: audio travels inside the video segments.
   * `separate`: its own HLS rendition (EXT-X-MEDIA TYPE=AUDIO), used when the
   * video is copied but the audio must be transcoded.
   */
  delivery: 'muxed' | 'separate';
  streamIndex: number;
  channels: 1 | 2;
  codecString: 'mp4a.40.2';
  /** ISO 639 language of the source stream, when tagged. */
  language: string | undefined;
}

/** Facts about an indexed source that make stream copy possible. */
export interface CopySource {
  codec: 'h264' | 'hevc';
  codecString: string;
  /** Peak bitrate of the copied media (video + audio), bits/s. */
  peakBitrate: number;
}

const QUALITY_RANK: Readonly<Record<Quality, number>> = {
  '480p': 0,
  '720p': 1,
  '1080p': 2,
  '2160p': 3,
};

/** Quality bucket a source height belongs to (for labelling copy renditions). */
export function qualityForHeight(height: number): Quality {
  if (height >= 1800) return '2160p';
  if (height >= 900) return '1080p';
  if (height >= 600) return '720p';
  return '480p';
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
      message:
        '2160p is only served by passthrough of a Safari-compatible 4K source; transcoding is capped to 1080p.',
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

function copyBlockers(
  info: MediaInfo,
  opts: { quality: Quality | 'auto'; caps: ClientCapabilities; copySource?: CopySource },
): PlanReason[] {
  const blockers: PlanReason[] = [];
  if (!opts.copySource) {
    blockers.push({
      code: 'COPY_INDEX_UNAVAILABLE',
      message:
        'No keyframe index for this source (container not MP4/Matroska, fragmented, or no Cues).',
    });
  } else if (opts.copySource.codec !== info.video.codec) {
    blockers.push({
      code: 'COPY_INDEX_MISMATCH',
      message: 'Index and probe disagree on the codec.',
    });
  }
  if (!isSafariCompatibleVideo(info.video, opts.caps)) {
    blockers.push({
      code: 'VIDEO_TRANSCODE_REQUIRED',
      message: `Source video ${info.video.codec}/${info.video.profile ?? '?'}/${info.video.pixFmt ?? '?'} is not decodable by this client.`,
    });
  }
  const sourceQuality = qualityForHeight(info.video.height);
  if (opts.quality !== 'auto' && QUALITY_RANK[opts.quality] < QUALITY_RANK[sourceQuality]) {
    blockers.push({
      code: 'DOWNSCALE_REQUESTED',
      message: `Requested ${opts.quality} is below the source's ${sourceQuality}.`,
    });
  }
  if (info.video.height > opts.caps.maxHeight) {
    blockers.push({
      code: 'CLIENT_RESOLUTION_LIMIT',
      message: `Source ${info.video.height}p exceeds the client's ${opts.caps.maxHeight}p.`,
    });
  }
  return blockers;
}

export function planPlayback(
  info: MediaInfo,
  opts: {
    quality: Quality | 'auto';
    caps: ClientCapabilities;
    preferredAudioLanguage?: string;
    copySource?: CopySource;
  },
): PlaybackPlan {
  const audioForCopy = selectAudioStream(info.audio, opts.preferredAudioLanguage);
  const blockers = copyBlockers(info, opts);
  if (blockers.length === 0 && opts.copySource) {
    const { copySource } = opts;
    const separateAudio = audioForCopy !== undefined && !isSafariCompatibleAudio(audioForCopy);
    return {
      video: {
        action: 'copy',
        codec: copySource.codec,
        codecString: copySource.codecString,
        outputWidth: info.video.width,
        outputHeight: info.video.height,
        frameRate: info.video.frameRate ?? 24,
        quality: qualityForHeight(info.video.height),
        hvc1: copySource.codec === 'hevc',
        videoRange: info.video.videoRange,
      },
      audio: audioForCopy
        ? {
            action: separateAudio ? 'transcode' : 'copy',
            delivery: separateAudio ? 'separate' : 'muxed',
            streamIndex: audioForCopy.index,
            channels: separateAudio || audioForCopy.channels !== 1 ? 2 : 1,
            codecString: 'mp4a.40.2',
            language: audioForCopy.language,
          }
        : null,
      // A separate rendition is selected together with the variant, so its rate counts too.
      bandwidth: Math.ceil(
        ((copySource.peakBitrate + (separateAudio ? AUDIO_BITRATE : 0)) * 11) / 10,
      ),
      reasons: [
        {
          code: 'COPY',
          message: `Source ${info.video.codec} is streamed without re-encoding (${copySource.codecString}).`,
        },
        ...(separateAudio
          ? [
              {
                code: 'AUDIO_SEPARATE_RENDITION',
                message: `Audio ${audioForCopy.codec} ${audioForCopy.channels}ch is transcoded to AAC-LC stereo as a separate rendition; video is not re-encoded.`,
              },
            ]
          : []),
        ...(audioForCopy ? [] : [{ code: 'NO_AUDIO', message: 'Source has no audio stream.' }]),
      ],
    };
  }

  const reasons: PlanReason[] = [...blockers];
  const { rendition, reasons: rReasons } = selectRendition(
    info.video.height,
    opts.quality,
    opts.caps,
  );
  reasons.push(...rReasons);

  const copyEligible = isSafariCompatibleVideo(info.video, opts.caps);
  if (info.video.hdr) {
    reasons.push({
      code: 'HDR_TONEMAP_MISSING',
      message:
        'HDR source transcoded to SDR without tone mapping (not implemented yet); colours will be inaccurate.',
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
      delivery: 'muxed',
      streamIndex: audioStream.index,
      channels: 2,
      codecString: 'mp4a.40.2',
      language: audioStream.language,
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
