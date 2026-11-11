import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  UnsupportedSourceError,
  bufferReader,
  copySegmentTimeline,
  hevcCodecString,
  avcCodecString,
  indexSource,
} from '../src/index.js';
import type { ByteRangeReader } from '../src/index.js';

/**
 * The index must agree with ffmpeg's own view of the file (packet pts of
 * keyframes), because copy-mode jobs seek with ffmpeg using these times.
 * Files are generated with ffmpeg so every case is reproducible.
 */
let dir: string;
const ff = (...args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const SRC_H264 = [
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x240:rate=24000/1001:duration=12,noise=alls=30:allf=t',
  '-f',
  'lavfi',
  '-i',
  'sine=duration=12:sample_rate=48000',
];
const X264 = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-bf',
  '3',
  '-g',
  '72',
  '-keyint_min',
  '12',
  '-sc_threshold',
  '40',
  '-c:a',
  'aac',
];

function ffprobeKeyframes(file: string): number[] {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time,flags',
    '-of',
    'csv=p=0',
    file,
  ]).toString();
  return out
    .trim()
    .split('\n')
    .map((l) => l.split(','))
    .filter(([, flags]) => flags?.includes('K'))
    .map(([pts]) => Number(pts))
    .sort((a, b) => a - b);
}

function probeStream(file: string): { profile: string; level: number } {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=profile,level',
    '-of',
    'json',
    file,
  ]).toString();
  const s = (JSON.parse(out) as { streams: { profile: string; level: number }[] }).streams[0];
  if (!s) throw new Error('no stream');
  return s;
}

function countingReader(file: string): ByteRangeReader & { bytesRead: number } {
  const inner = bufferReader(readFileSync(file));
  const r = {
    size: inner.size,
    bytesRead: 0,
    read: async (offset: number, length: number) => {
      const chunk = await inner.read(offset, length);
      r.bytesRead += chunk.length;
      return chunk;
    },
  };
  return r;
}

const files: Record<string, string> = {};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'media-core-container-'));
  const f = (name: string) => (files[name] = path.join(dir, name));
  ff(...SRC_H264, ...X264, f('moov-at-end.mp4'));
  ff(...SRC_H264, ...X264, '-movflags', '+faststart', f('faststart.mp4'));
  ff(...SRC_H264, ...X264, '-use_editlist', '0', f('no-editlist.mp4'));
  ff(...SRC_H264, ...X264, '-movflags', 'frag_keyframe+empty_moov', f('fragmented.mp4'));
  ff(...SRC_H264, ...X264, f('h264.mkv'));
  ff(
    ...SRC_H264,
    '-c:v',
    'libx265',
    '-preset',
    'ultrafast',
    '-x265-params',
    'keyint=48:min-keyint=12:log-level=error',
    '-c:a',
    'aac',
    f('hevc.mkv'),
  );
  // Written through a pipe: no SeekHead/Cues can be back-patched.
  const piped = execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', ...SRC_H264, ...X264, '-f', 'matroska', 'pipe:1'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(f('no-cues.mkv'), piped);
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('indexSource agrees with ffmpeg', () => {
  for (const name of [
    'moov-at-end.mp4',
    'faststart.mp4',
    'no-editlist.mp4',
    'h264.mkv',
    'hevc.mkv',
  ]) {
    it(`${name}: keyframe times match ffprobe packet pts`, async () => {
      const file = files[name] ?? '';
      const reader = countingReader(file);
      const index = await indexSource(reader);
      const expected = ffprobeKeyframes(file);
      const got = index.video.keyframes.map((k) => k.timeSec);
      expect(got.length).toBe(expected.length);
      got.forEach((t, i) => {
        expect(t).toBeCloseTo(expected[i] ?? Number.NaN, 3);
      });
      expect(index.durationSec).toBeGreaterThan(11.5);
      // Torrent-friendly: never reads media payload, only headers and the index.
      expect(reader.bytesRead / reader.size).toBeLessThan(0.15);
    });
  }

  it('derives exact codec strings from avcC / hvcC', async () => {
    const h264 = await indexSource(countingReader(files['moov-at-end.mp4'] ?? ''));
    const p = probeStream(files['moov-at-end.mp4'] ?? '');
    expect(p.profile).toBe('High');
    expect(h264.video.codecString).toBe(`avc1.6400${p.level.toString(16).padStart(2, '0')}`);
    const mkvH264 = await indexSource(countingReader(files['h264.mkv'] ?? ''));
    expect(mkvH264.video.codecString).toBe(h264.video.codecString);
    const hevc = await indexSource(countingReader(files['hevc.mkv'] ?? ''));
    const hp = probeStream(files['hevc.mkv'] ?? '');
    expect(hp.profile).toBe('Main');
    expect(hevc.video).toMatchObject({ codec: 'hevc' });
    expect(hevc.video.codecString).toMatch(new RegExp(`^hvc1\\.1\\.6\\.L${hp.level}\\.[0-9A-F]+$`));
  });

  it('refuses sources it cannot index without reading everything', async () => {
    await expect(indexSource(countingReader(files['fragmented.mp4'] ?? ''))).rejects.toThrow(
      UnsupportedSourceError,
    );
    await expect(indexSource(countingReader(files['no-cues.mkv'] ?? ''))).rejects.toThrow(
      UnsupportedSourceError,
    );
    await expect(indexSource(bufferReader(new Uint8Array(64)))).rejects.toThrow(
      UnsupportedSourceError,
    );
  });
});

describe('codec strings (spec vectors)', () => {
  it('formats HEVC per ISO/IEC 14496-15 Annex E', () => {
    // Main profile, Main+Main10 compatibility, level 3.1, progressive-source constraint.
    const main = Uint8Array.from([1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93]);
    expect(hevcCodecString(main)).toBe('hvc1.1.6.L93.B0');
    // Main 10, high tier, level 5.1, two constraint bytes.
    const main10 = Uint8Array.from([1, 0x22, 0x20, 0, 0, 0, 0x90, 0x08, 0, 0, 0, 0, 153]);
    expect(hevcCodecString(main10)).toBe('hvc1.2.4.H153.90.8');
  });

  it('formats AVC from avcC bytes', () => {
    expect(avcCodecString(Uint8Array.from([1, 0x64, 0x00, 0x28, 0xff]))).toBe('avc1.640028');
    expect(() => avcCodecString(Uint8Array.from([0, 1]))).toThrow();
  });
});

describe('copySegmentTimeline', () => {
  const kf = (t: number, b = t * 1000) => ({ timeSec: t, byteMark: b });

  it('chooses the first keyframe at least the target after the previous boundary', () => {
    const { segments } = copySegmentTimeline(
      [kf(0), kf(2), kf(4), kf(6), kf(8), kf(10), kf(12)],
      14,
      6,
      14_000,
    );
    expect(segments.map((s) => [s.boundarySec, s.nextBoundarySec])).toEqual([
      [0, 6],
      [6, 12],
      [12, undefined],
    ]);
    expect(segments.map((s) => s.durationSec)).toEqual([6, 6, 2]);
  });

  it('keeps long GOPs whole and skips keyframes too close to the next one', () => {
    const { segments } = copySegmentTimeline(
      [kf(0), kf(10), kf(10.1), kf(10.5), kf(20)],
      25,
      6,
      25_000,
    );
    // 10.0 is followed by a keyframe 0.1 s later: unusable as a seek target.
    expect(segments.map((s) => s.boundarySec)).toEqual([0, 10.1, 20]);
  });

  it('never creates a sub-second tail and estimates peak bitrate', () => {
    const { segments, peakBitrate, averageBitrate } = copySegmentTimeline(
      [kf(0, 0), kf(6, 600_000), kf(12, 900_000)],
      12.5,
      6,
      950_000,
    );
    expect(segments.map((s) => s.boundarySec)).toEqual([0, 6]);
    expect(peakBitrate).toBe(800_000); // 600 kB in 6 s
    expect(averageBitrate).toBe(608_000);
  });
});
