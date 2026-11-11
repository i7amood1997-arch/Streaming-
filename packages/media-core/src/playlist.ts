/**
 * HLS playlist generation (RFC 8216 + Apple HLS Authoring Specification).
 *
 * The media playlist is *synthetic*: it is fully written up front as a VOD
 * playlist from the probed duration, before any segment exists. That gives
 * Safari a complete, seekable timeline immediately; segments are produced on
 * demand (see session.ts). This only works because the encoder forces IDR
 * frames at exactly k * segmentDuration, so segment k always covers
 * [k*d, (k+1)*d) no matter which ffmpeg run produced it.
 */

export interface SegmentTiming {
  index: number;
  startSec: number;
  durationSec: number;
}

/**
 * Splits a duration into fixed-length segments. A remainder shorter than
 * `minTailSec` is merged into the previous segment, because the encoder can
 * only cut where a video frame exists (audio often outlasts the last frame).
 */
export function segmentTimeline(
  durationSec: number,
  segmentDurationSec: number,
  minTailSec = 1,
): SegmentTiming[] {
  if (!(durationSec > 0) || !(segmentDurationSec > 0)) throw new RangeError('Invalid durations');
  let count = Math.ceil(durationSec / segmentDurationSec - 1e-9);
  const tail = durationSec - (count - 1) * segmentDurationSec;
  if (count > 1 && tail < minTailSec) count -= 1;
  return Array.from({ length: count }, (_, index) => {
    const startSec = index * segmentDurationSec;
    const durationOfThis = index === count - 1 ? durationSec - startSec : segmentDurationSec;
    return { index, startSec, durationSec: durationOfThis };
  });
}

const fmt = (n: number) => n.toFixed(6);

export function buildMediaPlaylist(
  timeline: SegmentTiming[],
  uris: { init: string; segment: (index: number) => string },
): string {
  const target = Math.max(...timeline.map((s) => Math.round(s.durationSec)), 1);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${uris.init}"`,
  ];
  for (const seg of timeline) {
    lines.push(`#EXTINF:${fmt(seg.durationSec)},`, uris.segment(seg.index));
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/** A single WebVTT file covering the whole title, as Safari accepts for VOD. */
export function buildSubtitlePlaylist(durationSec: number, uri: string): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(durationSec)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXTINF:${fmt(durationSec)},`,
    uri,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

export interface MasterVariant {
  bandwidth: number;
  codecs: string[];
  width: number;
  height: number;
  frameRate: number;
  uri: string;
  /** Omitted means SDR. Required for HDR (PQ/HLG) so Apple players handle it correctly. */
  videoRange?: 'SDR' | 'PQ' | 'HLG';
}

export interface MasterSubtitle {
  language: string;
  name: string;
  uri: string;
  isDefault: boolean;
  forced: boolean;
}

/** Quoted-string attribute values may not contain `"`, CR or LF. */
function quoted(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error(`Invalid HLS quoted-string: ${value}`);
  return `"${value}"`;
}

export function buildMasterPlaylist(variant: MasterVariant, subtitles: MasterSubtitle[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const s of subtitles) {
    lines.push(
      [
        '#EXT-X-MEDIA:TYPE=SUBTITLES',
        'GROUP-ID="subs"',
        `NAME=${quoted(s.name)}`,
        `LANGUAGE=${quoted(s.language)}`,
        `DEFAULT=${s.isDefault ? 'YES' : 'NO'}`,
        `AUTOSELECT=YES`,
        `FORCED=${s.forced ? 'YES' : 'NO'}`,
        `URI=${quoted(s.uri)}`,
      ].join(','),
    );
  }
  const attrs = [
    `BANDWIDTH=${variant.bandwidth}`,
    `CODECS=${quoted(variant.codecs.join(','))}`,
    `RESOLUTION=${variant.width}x${variant.height}`,
    `FRAME-RATE=${variant.frameRate.toFixed(3)}`,
    ...(variant.videoRange && variant.videoRange !== 'SDR'
      ? [`VIDEO-RANGE=${variant.videoRange}`]
      : []),
    'CLOSED-CAPTIONS=NONE',
  ];
  if (subtitles.length > 0) attrs.push('SUBTITLES="subs"');
  lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`, variant.uri, '');
  return lines.join('\n');
}
