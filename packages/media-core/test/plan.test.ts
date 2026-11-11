import { describe, expect, it } from 'vitest';
import {
  fitDimensions,
  h264CodecString,
  h264LevelFor,
  isSafariCompatibleVideo,
  planPlayback,
  selectRendition,
} from '../src/index.js';
import { toMediaInfo } from '../src/index.js';
import type { MediaInfo } from '../src/index.js';

const caps = { hevc: false, maxHeight: 1080 };

function media(
  overrides: Partial<MediaInfo['video']> = {},
  audio: Partial<MediaInfo['audio'][0]>[] = [{}],
): MediaInfo {
  return {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSec: 5400,
    bitRate: 8_000_000,
    video: {
      index: 0,
      codec: 'h264',
      profile: 'High',
      level: 41,
      width: 1920,
      height: 1080,
      pixFmt: 'yuv420p',
      frameRate: 24000 / 1001,
      hdr: false,
      videoRange: 'SDR',
      ...overrides,
    },
    audio: audio.map((a, i) => ({
      index: i + 1,
      codec: 'aac',
      profile: 'LC',
      channels: 2,
      sampleRate: 48000,
      language: undefined,
      isDefault: i === 0,
      bitRate: 128_000,
      ...a,
    })),
    subtitles: [],
  };
}

describe('codec strings and levels', () => {
  it('builds RFC 6381 avc1 strings', () => {
    expect(h264CodecString('High', 41)).toBe('avc1.640029');
    expect(h264CodecString('Main', 31)).toBe('avc1.4d401f');
    expect(h264CodecString('Constrained Baseline', 30)).toBe('avc1.42e01e');
    expect(() => h264CodecString('High 10', 41)).toThrow();
  });

  it('picks the smallest H.264 level that fits size and frame rate', () => {
    expect(h264LevelFor(1280, 720, 30)).toBe(31);
    expect(h264LevelFor(1280, 720, 60)).toBe(32);
    expect(h264LevelFor(1920, 1080, 24)).toBe(40);
    expect(h264LevelFor(1920, 1080, 60)).toBe(42);
    expect(h264LevelFor(3840, 2160, 30)).toBe(51);
  });
});

describe('Safari compatibility', () => {
  it('accepts 8-bit H.264 and rejects 10-bit / legacy codecs', () => {
    expect(isSafariCompatibleVideo(media().video, caps)).toBe(true);
    expect(
      isSafariCompatibleVideo(media({ profile: 'High 10', pixFmt: 'yuv420p10le' }).video, caps),
    ).toBe(false);
    expect(
      isSafariCompatibleVideo(
        media({ codec: 'mpeg4', profile: 'Advanced Simple Profile' }).video,
        caps,
      ),
    ).toBe(false);
  });

  it('only accepts HEVC when the client reports HEVC support', () => {
    const hevc = media({ codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le' }).video;
    expect(isSafariCompatibleVideo(hevc, caps)).toBe(false);
    expect(isSafariCompatibleVideo(hevc, { hevc: true, maxHeight: 2160 })).toBe(true);
  });
});

describe('rendition selection', () => {
  it('never upscales and respects client limits', () => {
    expect(selectRendition(720, '1080p', caps).rendition.quality).toBe('720p');
    expect(selectRendition(2160, 'auto', caps).rendition.quality).toBe('1080p');
    expect(selectRendition(1080, '1080p', { hevc: false, maxHeight: 720 }).rendition.quality).toBe(
      '720p',
    );
    expect(selectRendition(360, 'auto', caps).rendition.quality).toBe('480p');
  });

  it('explains that 4K is passthrough-only', () => {
    const { rendition, reasons } = selectRendition(2160, '2160p', { hevc: true, maxHeight: 2160 });
    expect(rendition.quality).toBe('1080p');
    expect(reasons.map((r) => r.code)).toContain('UHD_REQUIRES_PASSTHROUGH');
  });

  it('fits inside the rendition box with even dimensions', () => {
    expect(fitDimensions(1920, 1080, 1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(fitDimensions(1920, 800, 1280, 720)).toEqual({ width: 1280, height: 534 });
    expect(fitDimensions(640, 360, 1280, 720)).toEqual({ width: 640, height: 360 });
    expect(fitDimensions(1440, 1080, 1280, 720)).toEqual({ width: 960, height: 720 });
  });
});

describe('planPlayback', () => {
  it('plans an H.264/AAC transcode with explicit decisions', () => {
    const plan = planPlayback(media(), { quality: '720p', caps });
    expect(plan.video).toMatchObject({
      outputWidth: 1280,
      outputHeight: 720,
      codecString: 'avc1.64001f',
      copyEligible: true,
      capFrameRate: false,
    });
    expect(plan.audio).toMatchObject({ codecString: 'mp4a.40.2', channels: 2, streamIndex: 1 });
    expect(plan.reasons.map((r) => r.code)).toContain('COPY_INDEX_UNAVAILABLE');
    expect(plan.bandwidth).toBe(Math.ceil((3_500_000 + 160_000) * 1.1));
  });

  it('flags surround / non-AAC audio and high frame rates', () => {
    const plan = planPlayback(
      media({ frameRate: 120 }, [{ codec: 'dts', profile: 'DTS', channels: 6 }]),
      {
        quality: '1080p',
        caps,
      },
    );
    if (plan.video.action !== 'transcode') throw new Error('expected transcode');
    expect(plan.video.frameRate).toBe(60);
    expect(plan.video.capFrameRate).toBe(true);
    expect(plan.reasons.map((r) => r.code)).toContain('AUDIO_TRANSCODE_REQUIRED');
  });

  it('prefers the requested audio language', () => {
    const plan = planPlayback(
      media({}, [{ language: 'eng' }, { language: 'ara', isDefault: false }]),
      {
        quality: 'auto',
        caps,
        preferredAudioLanguage: 'ara',
      },
    );
    expect(plan.audio?.streamIndex).toBe(2);
  });

  it('handles silent sources', () => {
    const plan = planPlayback(media({}, []), { quality: 'auto', caps });
    expect(plan.audio).toBeNull();
    expect(plan.reasons.map((r) => r.code)).toContain('NO_AUDIO');
  });
});

describe('planPlayback copy mode', () => {
  const h264Copy = { codec: 'h264' as const, codecString: 'avc1.640028', peakBitrate: 6_000_000 };

  it('copies a Safari-compatible source with AAC audio', () => {
    const plan = planPlayback(media(), { quality: 'auto', caps, copySource: h264Copy });
    expect(plan.video).toEqual({
      action: 'copy',
      codec: 'h264',
      codecString: 'avc1.640028',
      outputWidth: 1920,
      outputHeight: 1080,
      frameRate: 24000 / 1001,
      quality: '1080p',
      hvc1: false,
      videoRange: 'SDR',
    });
    expect(plan.audio).toMatchObject({ action: 'copy', streamIndex: 1, codecString: 'mp4a.40.2' });
    expect(plan.bandwidth).toBe(6_600_000);
    expect(plan.reasons.map((r) => r.code)).toEqual(['COPY']);
  });

  it('serves 4K HEVC by passthrough to capable clients, tagged hvc1', () => {
    const uhd = media({
      codec: 'hevc',
      profile: 'Main 10',
      pixFmt: 'yuv420p10le',
      width: 3840,
      height: 2160,
    });
    const plan = planPlayback(uhd, {
      quality: '2160p',
      caps: { hevc: true, maxHeight: 2160 },
      copySource: { codec: 'hevc', codecString: 'hvc1.2.4.L150.90', peakBitrate: 20_000_000 },
    });
    expect(plan.video).toMatchObject({
      action: 'copy',
      quality: '2160p',
      hvc1: true,
      codecString: 'hvc1.2.4.L150.90',
    });
  });

  it('explains every reason copy is declined, then transcodes', () => {
    const uhd = media(
      { codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le', width: 3840, height: 2160 },
      [{ codec: 'ac3', profile: undefined, channels: 6 }],
    );
    const plan = planPlayback(uhd, {
      quality: 'auto',
      caps: { hevc: false, maxHeight: 1080 },
      copySource: { codec: 'hevc', codecString: 'hvc1.2.4.L150.90', peakBitrate: 1 },
    });
    expect(plan.video.action).toBe('transcode');
    expect(plan.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining([
        'VIDEO_TRANSCODE_REQUIRED',
        'AUDIO_TRANSCODE_REQUIRED',
        'CLIENT_RESOLUTION_LIMIT',
      ]),
    );
  });

  it('copies video and delivers non-AAC audio as a separate AAC rendition', () => {
    const plan = planPlayback(
      media({}, [{ codec: 'ac3', profile: undefined, channels: 6, language: 'eng' }]),
      { quality: 'auto', caps, copySource: h264Copy },
    );
    expect(plan.video.action).toBe('copy');
    expect(plan.audio).toEqual({
      action: 'transcode',
      delivery: 'separate',
      streamIndex: 1,
      channels: 2,
      codecString: 'mp4a.40.2',
      language: 'eng',
    });
    expect(plan.reasons.map((r) => r.code)).toEqual(['COPY', 'AUDIO_SEPARATE_RENDITION']);
    expect(plan.bandwidth).toBe(Math.ceil(((6_000_000 + 160_000) * 11) / 10));
  });

  it('keeps AAC audio muxed when copying', () => {
    const plan = planPlayback(media(), { quality: 'auto', caps, copySource: h264Copy });
    expect(plan.audio).toMatchObject({ action: 'copy', delivery: 'muxed' });
  });

  it('transcodes when the viewer asks for less than the source', () => {
    const plan = planPlayback(media(), { quality: '720p', caps, copySource: h264Copy });
    expect(plan.video.action).toBe('transcode');
    expect(plan.reasons.map((r) => r.code)).toContain('DOWNSCALE_REQUESTED');
  });
});

describe('toMediaInfo', () => {
  it('normalises ffprobe output and ignores cover art', () => {
    const info = toMediaInfo({
      format: { format_name: 'matroska,webm', duration: '100.5', bit_rate: '5000000' },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 600,
          height: 900,
          disposition: { attached_pic: 1 },
        },
        {
          index: 1,
          codec_type: 'video',
          codec_name: 'hevc',
          profile: 'Main 10',
          width: 3840,
          height: 2160,
          pix_fmt: 'yuv420p10le',
          avg_frame_rate: '24000/1001',
          color_transfer: 'smpte2084',
        },
        {
          index: 2,
          codec_type: 'audio',
          codec_name: 'eac3',
          channels: 6,
          sample_rate: '48000',
          tags: { language: 'eng' },
          disposition: { default: 1 },
        },
        {
          index: 3,
          codec_type: 'subtitle',
          codec_name: 'hdmv_pgs_subtitle',
          tags: { language: 'ara' },
        },
        { index: 4, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
      ],
    });
    expect(info.video).toMatchObject({
      index: 1,
      codec: 'hevc',
      hdr: true,
      videoRange: 'PQ',
      height: 2160,
    });
    expect(info.video.frameRate).toBeCloseTo(23.976, 3);
    expect(info.audio[0]).toMatchObject({
      codec: 'eac3',
      channels: 6,
      isDefault: true,
      language: 'eng',
    });
    expect(info.subtitles.map((s) => s.textBased)).toEqual([false, true]);
  });

  it('rejects sources without duration or video', () => {
    expect(() => toMediaInfo({ format: { format_name: 'mp4' }, streams: [] })).toThrow(/duration/);
    expect(() =>
      toMediaInfo({
        format: { format_name: 'mp3', duration: '10' },
        streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3' }],
      }),
    ).toThrow(/video/);
  });
});
