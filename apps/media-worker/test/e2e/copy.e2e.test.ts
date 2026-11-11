/// <reference lib="dom" />
// DOM types are needed for the callbacks executed inside the browser page.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { bufferReader, indexSource } from '@streaming/media-core';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import {
  FIXTURE_ID,
  SURROUND_FIXTURE_ID,
  UHD_FIXTURE_ID,
  ensureFixtures,
} from '../../src/fixtures/generate.js';
import type { Fixtures } from '../../src/fixtures/generate.js';
import { startSeeder } from '../../src/fixtures/seeder.js';
import type { Seeder } from '../../src/fixtures/seeder.js';

/**
 * Copy (remux) mode end to end: the worker indexes the source over the
 * torrent, plans keyframe-aligned segments and stream-copies them. The
 * assembled output must contain exactly the source's video packets.
 */
const execFileAsync = promisify(execFile);

interface SessionResponse {
  sessionId: string;
  masterPlaylistUrl: string;
  video: { width: number; height: number; codecs: string; quality: string };
  decisions: { code: string }[];
}

let fixtures: Fixtures;
let seeder: Seeder;
let app: App;
let base: string;
let scratch: string;

async function createSession(body: object): Promise<SessionResponse> {
  const res = await fetch(`${base}/v1/playback/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const session = (await res.json()) as SessionResponse;
  session.masterPlaylistUrl = new URL(session.masterPlaylistUrl, base).toString();
  return session;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  expect(res.status, `GET ${url}`).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

async function ffprobeJson(file: string, args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-of', 'json', ...args, file], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function videoPackets(file: string): Promise<{ pts: number; key: boolean }[]> {
  const json = await ffprobeJson(file, [
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time,flags',
  ]);
  return (json['packets'] as { pts_time: string; flags: string }[]).map((p) => ({
    pts: Number(p.pts_time),
    key: p.flags.includes('K'),
  }));
}

/** Downloads every segment in playlist order (or a given order) and assembles one file. */
async function assemble(
  session: SessionResponse,
  order?: number[],
): Promise<{ file: string; count: number }> {
  const media = await (await fetch(new URL('video/index.m3u8', session.masterPlaylistUrl))).text();
  const uris = media.split('\n').filter((l) => l.startsWith('seg-'));
  const indices = order ?? uris.map((_, i) => i);
  const parts = new Map<number, Buffer>();
  for (const i of indices)
    parts.set(
      i,
      await download(new URL(`video/seg-${i}.m4s`, session.masterPlaylistUrl).toString()),
    );
  const init = await download(new URL('video/init.mp4', session.masterPlaylistUrl).toString());
  const file = path.join(scratch, `${session.sessionId}.mp4`);
  await writeFile(
    file,
    Buffer.concat([init, ...uris.map((_, i) => parts.get(i) ?? Buffer.alloc(0))]),
  );
  return { file, count: uris.length };
}

beforeAll(async () => {
  fixtures = await ensureFixtures();
  scratch = path.resolve('.data', `e2e-copy-${Date.now()}`);
  await mkdir(scratch, { recursive: true });
  seeder = await startSeeder({ torrentPaths: fixtures.torrentPaths, dataPath: fixtures.mediaRoot });
  const config = loadConfig(
    {},
    {
      host: '127.0.0.1',
      port: 0,
      workDir: path.join(scratch, 'work'),
      catalogDir: fixtures.catalogDir,
      // Every test here keeps its session open; the browser tests add their own.
      maxSessions: 8,
      maxSegmentsAhead: 50,
      minFreeDiskMiB: 0,
      segmentWaitTimeoutSec: 60,
      torrent: {
        port: 0,
        dht: false,
        trackers: false,
        webSeeds: false,
        allowPrivatePeers: true,
        maxConns: 10,
        uploadLimitKiBps: -1,
      },
    },
  );
  app = await createApp(config, { bootstrapPeers: [seeder.address] });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await seeder.close();
  await rm(scratch, { recursive: true, force: true });
});

describe('copy mode: H.264 MP4 (moov at end, 4 s GOP)', () => {
  let session: SessionResponse;

  it('chooses copy for "auto" and reports the exact source codec string', async () => {
    session = await createSession({ contentId: FIXTURE_ID, quality: 'auto' });
    const expected = await indexSource(bufferReader(await readFile(fixtures.videoPath)));
    expect(session.decisions.map((d) => d.code)).toEqual(['COPY']);
    expect(session.video).toEqual({
      width: 1920,
      height: 1080,
      quality: '1080p',
      codecs: expected.video.codecString,
    });
    const master = await (await fetch(session.masterPlaylistUrl)).text();
    expect(master).toContain(`CODECS="${expected.video.codecString ?? ''},mp4a.40.2"`);
  });

  it('cuts segments on source keyframes, out of order, without losing or duplicating packets', async () => {
    const media = await (
      await fetch(new URL('video/index.m3u8', session.masterPlaylistUrl))
    ).text();
    const durations = [...media.matchAll(/#EXTINF:([0-9.]+),/g)].map((m) => Number(m[1]));
    // Every boundary is a real source keyframe and no segment (but the last) is below the 6 s target.
    const keyframes = (await videoPackets(fixtures.videoPath))
      .filter((p) => p.key)
      .map((p) => p.pts);
    let t = 0;
    for (const d of durations.slice(0, -1)) {
      t += d;
      expect(
        keyframes.some((k) => Math.abs(k - t) < 0.002),
        `boundary ${t.toFixed(3)} is a keyframe`,
      ).toBe(true);
      expect(d).toBeGreaterThanOrEqual(6);
    }

    // Request a late segment first (seek), then the rest.
    const count = durations.length;
    const order = [
      count - 2,
      ...Array.from({ length: count }, (_, i) => i).filter((i) => i !== count - 2),
    ];
    const { file } = await assemble(session, order);
    const out = await videoPackets(file);
    const src = await videoPackets(fixtures.videoPath);
    expect(out.length).toBe(src.length);
    expect(new Set(out.map((p) => p.pts.toFixed(4))).size).toBe(out.length);
    const live = app.manager.get(session.sessionId);
    expect(live?.stats.driftEvents).toBe(0);
    expect(live?.stats.jobsStarted).toBeGreaterThanOrEqual(2);
  });

  it('plays and seeks in Chromium (hls.js) from copied segments', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/player/?autostart=1&engine=hlsjs&quality=auto`);
      await page.waitForFunction(
        () =>
          document.querySelector('video')!.currentTime > 2 ||
          (window as unknown as { __player: { errors: string[] } }).__player.errors.length > 0,
        null,
        { timeout: 60_000 },
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { __player: { errors: string[] } }).__player.errors,
        ),
      ).toEqual([]);
      await page.evaluate(() => {
        document.querySelector('video')!.currentTime = 60;
      });
      await page.waitForFunction(
        () => {
          const v = document.querySelector('video')!;
          return v.currentTime > 61 && !v.paused && v.readyState >= 3;
        },
        null,
        { timeout: 60_000 },
      );
      const state = await page.evaluate(
        () => (window as unknown as { __player: { errors: string[] } }).__player,
      );
      expect(state.errors).toEqual([]);
      expect(await page.evaluate(() => document.querySelector('video')!.videoHeight)).toBe(1080);
    } finally {
      await browser.close();
    }
  });
});

describe('copy mode: 4K HEVC Main 10 Matroska (passthrough)', () => {
  it('passes 4K HEVC through to HEVC-capable clients, tagged hvc1, packet-exact', async () => {
    const session = await createSession({
      contentId: UHD_FIXTURE_ID,
      quality: 'auto',
      capabilities: { hevc: true, maxHeight: 2160 },
    });
    expect(session.decisions.map((d) => d.code)).toEqual(['COPY']);
    expect(session.video).toMatchObject({ width: 3840, height: 2160, quality: '2160p' });
    expect(session.video.codecs).toMatch(/^hvc1\.2\.4\.L\d+(\.[0-9A-F]+)*$/);

    const { file, count } = await assemble(session);
    expect(count).toBe(4); // 2 s GOPs over 20 s: boundaries at 0, 6, 12 and 18 s
    const streams = (
      await ffprobeJson(file, [
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,codec_tag_string,profile,width',
      ])
    )['streams'] as Record<string, unknown>[];
    expect(streams[0]).toMatchObject({
      codec_name: 'hevc',
      codec_tag_string: 'hvc1',
      profile: 'Main 10',
      width: 3840,
    });
    const out = await videoPackets(file);
    const src = await videoPackets(fixtures.uhd.videoPath);
    expect(out.length).toBe(src.length);
    expect(app.manager.get(session.sessionId)?.stats.driftEvents).toBe(0);
  });

  it('falls back to a 1080p H.264 transcode, with reasons, for clients without HEVC', async () => {
    const session = await createSession({
      contentId: UHD_FIXTURE_ID,
      quality: 'auto',
      capabilities: { hevc: false, maxHeight: 1080 },
    });
    expect(session.video).toMatchObject({ height: 1080, quality: '1080p' });
    expect(session.video.codecs).toMatch(/^avc1\.6400/);
    expect(session.decisions.map((d) => d.code)).toEqual(
      expect.arrayContaining(['VIDEO_TRANSCODE_REQUIRED', 'CLIENT_RESOLUTION_LIMIT']),
    );
    expect(
      (await fetch(`${base}/v1/playback/sessions/${session.sessionId}`, { method: 'DELETE' }))
        .status,
    ).toBe(204);
  });
});

describe('copy video + separate AAC audio rendition: H.264 + AC-3 5.1 MKV', () => {
  let session: SessionResponse;
  const url = (rel: string) => new URL(rel, session.masterPlaylistUrl).toString();

  it('copies the video and declares a separate English AAC rendition', async () => {
    session = await createSession({ contentId: SURROUND_FIXTURE_ID, quality: 'auto' });
    expect(session.decisions.map((d) => d.code)).toEqual(['COPY', 'AUDIO_SEPARATE_RENDITION']);
    expect(session.video).toMatchObject({ width: 1280, height: 720, quality: '720p' });
    const master = await (await fetch(session.masterPlaylistUrl)).text();
    expect(master).toContain(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/index.m3u8"',
    );
    expect(master).toMatch(/CODECS="avc1\.[0-9a-f]{6},mp4a\.40\.2".*AUDIO="aud"/);
  });

  it('serves video-only copied segments, packet-exact', async () => {
    const { file } = await assemble(session);
    const streams = (await ffprobeJson(file, ['-show_entries', 'stream=codec_type']))[
      'streams'
    ] as {
      codec_type: string;
    }[];
    expect(streams.map((s) => s.codec_type)).toEqual(['video']);
    expect((await videoPackets(file)).length).toBe(
      (await videoPackets(fixtures.surround.videoPath)).length,
    );
  });

  it('serves AAC-LC stereo audio segments that join seamlessly after a seek restart', async () => {
    const playlist = await (await fetch(url('audio/index.m3u8'))).text();
    const count = (playlist.match(/#EXTINF/g) ?? []).length;
    expect(count).toBe(5);
    // Seek first (forces a restart at the end), then everything in order.
    const order = [count - 1, ...Array.from({ length: count - 1 }, (_, i) => i)];
    const parts = new Map<number, Buffer>();
    for (const i of order) parts.set(i, await download(url(`audio/seg-${i}.m4s`)));
    const file = path.join(scratch, 'audio.mp4');
    await writeFile(
      file,
      Buffer.concat([
        await download(url('audio/init.mp4')),
        ...[...Array(count).keys()].map((i) => parts.get(i) ?? Buffer.alloc(0)),
      ]),
    );
    const stream = (
      (
        await ffprobeJson(file, ['-show_entries', 'stream=codec_name,profile,channels,sample_rate'])
      )['streams'] as Record<string, unknown>[]
    )[0];
    expect(stream).toMatchObject({
      codec_name: 'aac',
      profile: 'LC',
      channels: 2,
      sample_rate: '48000',
    });
    const packets = (
      (await ffprobeJson(file, ['-select_streams', 'a:0', '-show_entries', 'packet=pts_time']))[
        'packets'
      ] as {
        pts_time: string;
      }[]
    ).map((p) => Number(p.pts_time));
    // Strictly increasing (no overlap or duplicates at the restart boundary)...
    expect(packets.every((t, i) => i === 0 || t > (packets[i - 1] ?? -Infinity))).toBe(true);
    // ...with no gaps larger than one AAC frame (1024 samples at 48 kHz).
    const maxGap = Math.max(...packets.slice(1).map((t, i) => t - (packets[i] ?? t)));
    expect(maxGap).toBeLessThan(1024 / 48000 + 0.001);
    // The title's audio tail is served too (overflow fragments are merged into the last segment).
    const sourceAudio = (
      (
        await ffprobeJson(fixtures.surround.videoPath, [
          '-select_streams',
          'a:0',
          '-show_entries',
          'packet=pts_time',
        ])
      )['packets'] as { pts_time: string }[]
    ).map((p) => Number(p.pts_time));
    expect(packets.at(-1)).toBeGreaterThan((sourceAudio.at(-1) ?? 0) - 0.05);
    // Segments came from two producers: one started at the last segment, one at 0.
    const audio = app.manager.get(session.sessionId)?.stats.audio;
    expect(audio?.jobsStarted).toBeGreaterThanOrEqual(2);
  });

  it('plays and seeks in Chromium (hls.js) with the alternate audio rendition', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(
        `${base}/player/?autostart=1&engine=hlsjs&quality=auto&content=${SURROUND_FIXTURE_ID}`,
      );
      await page.waitForFunction(
        () =>
          document.querySelector('video')!.currentTime > 2 ||
          (window as unknown as { __player: { errors: string[] } }).__player.errors.length > 0,
        null,
        { timeout: 60_000 },
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { __player: { errors: string[] } }).__player.errors,
        ),
      ).toEqual([]);
      await page.evaluate(() => {
        document.querySelector('video')!.currentTime = 20;
      });
      await page.waitForFunction(
        () => {
          const v = document.querySelector('video')!;
          return v.currentTime > 21 && !v.paused && v.readyState >= 3;
        },
        null,
        { timeout: 60_000 },
      );
      const state = await page.evaluate(
        () => (window as unknown as { __player: { errors: string[] } }).__player,
      );
      expect(state.errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
