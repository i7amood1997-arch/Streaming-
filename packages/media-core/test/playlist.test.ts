import { describe, expect, it } from 'vitest';
import {
  buildMasterPlaylist,
  buildMediaPlaylist,
  buildSubtitlePlaylist,
  segmentTimeline,
} from '../src/index.js';

describe('segmentTimeline', () => {
  it('splits into fixed segments with a shorter final one', () => {
    const t = segmentTimeline(20, 6);
    expect(t.map((s) => s.durationSec)).toEqual([6, 6, 6, 2]);
    expect(t.map((s) => s.startSec)).toEqual([0, 6, 12, 18]);
  });

  it('merges a sub-second tail into the previous segment', () => {
    // Audio commonly outlasts the last video frame by a few ms (e.g. 90.0066s).
    const t = segmentTimeline(90.0066, 6);
    expect(t).toHaveLength(15);
    expect(t.at(-1)?.durationSec).toBeCloseTo(6.0066, 4);
  });

  it('handles exact multiples and very short titles', () => {
    expect(segmentTimeline(12, 6)).toHaveLength(2);
    expect(segmentTimeline(0.5, 6)).toEqual([{ index: 0, startSec: 0, durationSec: 0.5 }]);
  });

  it('rejects invalid input', () => {
    expect(() => segmentTimeline(0, 6)).toThrow(RangeError);
    expect(() => segmentTimeline(Number.NaN, 6)).toThrow(RangeError);
  });
});

describe('buildMediaPlaylist', () => {
  it('produces a complete VOD fMP4 playlist', () => {
    const text = buildMediaPlaylist(segmentTimeline(13, 6), {
      init: 'init.mp4',
      segment: (i) => `seg-${i}.m4s`,
    });
    expect(text).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:6.000000,',
        'seg-0.m4s',
        '#EXTINF:6.000000,',
        'seg-1.m4s',
        '#EXTINF:1.000000,',
        'seg-2.m4s',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );
  });

  it('keeps TARGETDURATION >= every rounded EXTINF (RFC 8216 4.3.3.1)', () => {
    const timeline = segmentTimeline(90.6, 6);
    const text = buildMediaPlaylist(timeline, { init: 'i', segment: (i) => `${i}` });
    const target = Number(/TARGETDURATION:(\d+)/.exec(text)?.[1]);
    for (const s of timeline) expect(Math.round(s.durationSec)).toBeLessThanOrEqual(target);
  });
});

describe('buildMasterPlaylist', () => {
  it('declares codecs, resolution and subtitle renditions', () => {
    const text = buildMasterPlaylist(
      {
        bandwidth: 4_026_000,
        codecs: ['avc1.640028', 'mp4a.40.2'],
        width: 1280,
        height: 720,
        frameRate: 23.976,
        uri: 'video/index.m3u8',
      },
      [
        {
          language: 'en',
          name: 'English',
          uri: 'subs/en/index.m3u8',
          isDefault: false,
          forced: false,
        },
        {
          language: 'ar',
          name: 'العربية',
          uri: 'subs/ar/index.m3u8',
          isDefault: false,
          forced: false,
        },
      ],
    );
    expect(text).toContain(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="العربية",LANGUAGE="ar",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="subs/ar/index.m3u8"',
    );
    expect(text).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=4026000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=23.976,CLOSED-CAPTIONS=NONE,SUBTITLES="subs"\nvideo/index.m3u8',
    );
  });

  it('signals HDR video range and omits it for SDR', () => {
    const v = {
      bandwidth: 1,
      codecs: ['hvc1.2.4.L153.B0'],
      width: 3840,
      height: 2160,
      frameRate: 24,
      uri: 'v.m3u8',
    };
    expect(buildMasterPlaylist({ ...v, videoRange: 'PQ' }, [])).toContain(',VIDEO-RANGE=PQ');
    expect(buildMasterPlaylist({ ...v, videoRange: 'SDR' }, [])).not.toContain('VIDEO-RANGE');
  });

  it('omits the SUBTITLES group when there are no tracks', () => {
    const text = buildMasterPlaylist(
      { bandwidth: 1, codecs: ['avc1.640028'], width: 2, height: 2, frameRate: 25, uri: 'v.m3u8' },
      [],
    );
    expect(text).not.toContain('SUBTITLES');
  });

  it('rejects attribute values that would break the playlist', () => {
    expect(() =>
      buildMasterPlaylist(
        { bandwidth: 1, codecs: ['x'], width: 2, height: 2, frameRate: 25, uri: 'v' },
        [{ language: 'en', name: 'bad"name', uri: 'u', isDefault: false, forced: false }],
      ),
    ).toThrow();
  });
});

describe('buildSubtitlePlaylist', () => {
  it('covers the whole title with one WebVTT segment', () => {
    const text = buildSubtitlePlaylist(90.0066, 'subtitles.vtt');
    expect(text).toContain('#EXT-X-TARGETDURATION:91');
    expect(text).toContain('#EXTINF:90.006600,\nsubtitles.vtt');
    expect(text).toContain('#EXT-X-ENDLIST');
  });
});
