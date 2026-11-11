import { describe, expect, it } from 'vitest';
import {
  buildTranscodeArgs,
  completedSegmentsFromPlaylist,
  planPlayback,
  signStreamToken,
  verifyStreamToken,
} from '../src/index.js';

describe('stream tokens', () => {
  const secret = 'x'.repeat(32);
  it('round-trips and binds to the session', () => {
    const token = signStreamToken(secret, 'session-a', 2_000_000_000);
    expect(verifyStreamToken(secret, 'session-a', token, 1_900_000_000)).toBe(true);
    expect(verifyStreamToken(secret, 'session-b', token, 1_900_000_000)).toBe(false);
    expect(verifyStreamToken('y'.repeat(32), 'session-a', token, 1_900_000_000)).toBe(false);
  });

  it('rejects expired, tampered and malformed tokens', () => {
    const token = signStreamToken(secret, 's', 1000);
    expect(verifyStreamToken(secret, 's', token, 1001)).toBe(false);
    const [, mac] = token.split('.');
    expect(verifyStreamToken(secret, 's', `9999999999.${mac ?? ''}`, 0)).toBe(false);
    expect(verifyStreamToken(secret, 's', '../../etc', 0)).toBe(false);
  });
});

describe('buildTranscodeArgs', () => {
  const plan = planPlayback(
    {
      container: 'mp4',
      durationSec: 90,
      bitRate: undefined,
      video: {
        index: 0,
        codec: 'h264',
        profile: 'High',
        level: 40,
        width: 1920,
        height: 1080,
        pixFmt: 'yuv420p',
        frameRate: 24000 / 1001,
        hdr: false,
        videoRange: 'SDR',
      },
      audio: [
        {
          index: 1,
          codec: 'aac',
          profile: 'LC',
          channels: 2,
          sampleRate: 48000,
          language: undefined,
          isDefault: true,
          bitRate: 128_000,
        },
      ],
      subtitles: [],
    },
    { quality: '720p', caps: { hevc: false, maxHeight: 1080 } },
  );
  const args = buildTranscodeArgs({
    inputUrl: 'http://127.0.0.1:1/t/k/0',
    videoStreamIndex: 0,
    plan,
    startSegment: 7,
    segmentDurationSec: 6,
    segmentStartTimes: [42, 48, 54, 60],
    mediaDir: '/w/media',
    jobPlaylistPath: '/w/jobs/j1.m3u8',
    initFileName: 'j1-init.mp4',
    threads: 0,
    preset: 'veryfast',
    readTimeoutSec: 120,
  });
  const after = (flag: string) => args[args.indexOf(flag) + 1];

  it('seeks to the segment boundary before the input and keeps timestamps', () => {
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(after('-ss')).toBe('42.000');
    expect(args).toContain('-copyts');
    expect(after('-start_number')).toBe('7');
  });

  it('pins keyframes and segmenting to the fixed grid', () => {
    // Absolute times: the expr form drifts by a frame after a seek.
    expect(after('-force_key_frames:v')).toBe('42.000,48.000,54.000,60.000');
    expect(after('-sc_threshold')).toBe('0');
    expect(after('-hls_time')).toBe('3');
    expect(after('-hls_segment_options')).toBe('movflags=+frag_discont');
    expect(after('-hls_segment_type')).toBe('fmp4');
  });

  it('encodes Safari-safe H.264 High 8-bit and AAC-LC stereo', () => {
    expect(after('-profile:v')).toBe('high');
    expect(after('-level:v')).toBe('3.1');
    expect(after('-vf')).toContain('format=yuv420p');
    expect(after('-c:a')).toBe('aac');
    expect(after('-ac')).toBe('2');
  });

  it('omits -ss at the start of the title', () => {
    expect(buildTranscodeArgs({ ...argsSpec(), startSegment: 0 })).not.toContain('-ss');
  });

  function argsSpec() {
    return {
      inputUrl: 'u',
      videoStreamIndex: 0,
      plan,
      startSegment: 0,
      segmentDurationSec: 6,
      segmentStartTimes: [0, 6],
      mediaDir: '/m',
      jobPlaylistPath: '/j.m3u8',
      initFileName: 'i.mp4',
      threads: 0,
      preset: 'veryfast',
      readTimeoutSec: 1,
    };
  }
});

describe('completedSegmentsFromPlaylist', () => {
  it('extracts segment indices from an ffmpeg job playlist', () => {
    const text =
      '#EXTM3U\n#EXT-X-MAP:URI="j1-init.mp4"\n#EXTINF:6.0,\nseg-7.m4s\n#EXTINF:6.0,\n../media/seg-8.m4s\n';
    expect(completedSegmentsFromPlaylist(text)).toEqual([7, 8]);
  });
});
