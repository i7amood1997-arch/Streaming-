/// <reference lib="dom" />
// DOM types are needed for the callbacks executed inside the browser page.
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { FIXTURE_ID, ensureFixtures } from '../../src/fixtures/generate.js';
import type { Fixtures } from '../../src/fixtures/generate.js';
import { startSeeder } from '../../src/fixtures/seeder.js';
import type { Seeder } from '../../src/fixtures/seeder.js';
import { RLM } from '../../src/subtitles/rtl.js';

const execFileAsync = promisify(execFile);
const SEG = 6;

interface SessionResponse {
  sessionId: string;
  masterPlaylistUrl: string;
  durationSec: number;
  video: { width: number; height: number; codecs: string; quality: string };
  subtitles: { language: string; name: string; rtl: boolean }[];
  decisions: { code: string }[];
}

interface Packet {
  pts_time: string;
  flags: string;
}

let fixtures: Fixtures;
let seeder: Seeder;
let app: App;
let config: Config;
let base: string;
let session: SessionResponse;
let scratch: string;

async function createSession(body: object): Promise<Response> {
  return fetch(`${base}/v1/playback/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Resolves a URI relative to the master playlist, exactly as a player does. */
const resolve = (relative: string) => new URL(relative, session.masterPlaylistUrl).toString();

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  expect(res.status, `GET ${url}`).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

/** ffprobe a segment the way a player sees it: canonical init + media segment. */
async function probeSegment(index: number) {
  const file = path.join(scratch, `probe-${index}.mp4`);
  await writeFile(
    file,
    Buffer.concat([
      await download(resolve('video/init.mp4')),
      await download(resolve(`video/seg-${index}.m4s`)),
    ]),
  );
  const run = async (args: string[]) =>
    JSON.parse(
      (await execFileAsync('ffprobe', ['-v', 'error', '-of', 'json', ...args, file])).stdout,
    ) as Record<string, unknown>;
  const streams = (await run(['-show_streams']))['streams'] as Record<string, unknown>[];
  const videoPackets = (
    await run(['-select_streams', 'v', '-show_entries', 'packet=pts_time,flags'])
  )['packets'] as Packet[];
  return { streams, videoPackets };
}

beforeAll(async () => {
  fixtures = await ensureFixtures();
  scratch = path.resolve('.data', `e2e-${Date.now()}`);
  await mkdir(scratch, { recursive: true });
  seeder = await startSeeder({ torrentPath: fixtures.torrentPath, dataPath: fixtures.mediaRoot });
  config = loadConfig(
    {},
    {
      host: '127.0.0.1',
      port: 0,
      workDir: path.join(scratch, 'work'),
      catalogDir: fixtures.catalogDir,
      maxSessions: 2,
      maxConcurrentTranscodes: 2,
      maxSegmentsAhead: 4,
      minFreeDiskMiB: 0,
      torrentLingerSec: 0,
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

describe('M0 pipeline: authorized torrent -> on-demand HLS -> browser', () => {
  it('refuses content that is not in the authorized catalog', async () => {
    const res = await createSession({ contentId: 'not-in-catalog' });
    expect(res.status).toBe(404);
  });

  it('creates a session by downloading from a BitTorrent peer', async () => {
    const res = await createSession({ contentId: FIXTURE_ID, quality: '720p' });
    expect(res.status).toBe(201);
    session = (await res.json()) as SessionResponse;
    // Relative unless PUBLIC_BASE_URL is set; resolve against the API origin like a client.
    session.masterPlaylistUrl = new URL(session.masterPlaylistUrl, base).toString();
    expect(session.video).toMatchObject({
      width: 1280,
      height: 720,
      codecs: 'avc1.64001f',
      quality: '720p',
    });
    expect(session.durationSec).toBeCloseTo(90, 0);
    expect(session.subtitles).toHaveLength(2);
    expect(session.subtitles).toEqual(
      expect.arrayContaining([
        { language: 'en', name: 'English', forced: false, rtl: false },
        { language: 'ar', name: 'العربية', forced: false, rtl: true },
      ]),
    );
    const [torrent] = app.engine.stats();
    // Bytes came over the peer wire protocol (moov at EOF + subtitles + head).
    expect(torrent?.peers).toBeGreaterThanOrEqual(1);
    expect(torrent?.downloaded).toBeGreaterThan(0);
    expect(torrent?.progress).toBeLessThan(1);
  });

  it('serves Safari-compatible master and media playlists behind a signed path token', async () => {
    const master = await fetch(session.masterPlaylistUrl);
    expect(master.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const text = await master.text();
    expect(text).toContain('CODECS="avc1.64001f,mp4a.40.2"');
    expect(text).toContain('RESOLUTION=1280x720');
    expect(text).toMatch(/TYPE=SUBTITLES,GROUP-ID="subs",NAME="العربية",LANGUAGE="ar"/);

    const media = await (await fetch(resolve('video/index.m3u8'))).text();
    expect(media).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(media).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(media.match(/#EXTINF/g)).toHaveLength(15);
    expect(media.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);

    const forged = session.masterPlaylistUrl.replace(
      /\/(\d+)\.[^/]+\/master/,
      '/$1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/master',
    );
    expect((await fetch(forged)).status).toBe(403);
  });

  it('produces H.264 High / AAC-LC fMP4 segments on the 6 s grid', async () => {
    const first = await probeSegment(0);
    const video = first.streams.find((s) => s['codec_type'] === 'video');
    const audio = first.streams.find((s) => s['codec_type'] === 'audio');
    expect(video).toMatchObject({
      codec_name: 'h264',
      profile: 'High',
      pix_fmt: 'yuv420p',
      width: 1280,
      height: 720,
      level: 31,
    });
    expect(audio).toMatchObject({
      codec_name: 'aac',
      profile: 'LC',
      channels: 2,
      sample_rate: '48000',
    });
    expect(Number(first.videoPackets[0]?.pts_time)).toBeLessThan(0.05);
    expect(first.videoPackets[0]?.flags).toContain('K');

    const second = await probeSegment(1);
    expect(Number(second.videoPackets[0]?.pts_time)).toBeCloseTo(SEG, 1);
    expect(second.videoPackets.filter((p) => p.flags.includes('K'))).toHaveLength(1);
  });

  it('pauses the encoder when it gets too far ahead of the viewer', async () => {
    const live = app.manager.get(session.sessionId);
    // Viewer is at segment 1; with maxSegmentsAhead=4 the encoder stops at ~6.
    await expect.poll(() => live?.stats.job?.state, { timeout: 60_000 }).toBe('paused');
    expect(live?.stats.pauses).toBeGreaterThanOrEqual(1);
    const head = live?.stats.job?.head ?? 0;
    expect(head).toBeGreaterThan(1 + 4);
    expect(head).toBeLessThan(10);
  });

  it('restarts the encoder on a seek and keeps segments on the same timeline', async () => {
    const live = app.manager.get(session.sessionId);
    const restartsBefore = live?.stats.seekRestarts ?? 0;
    // Far beyond the paused encoder head (+ restart threshold): must restart.
    const far = await probeSegment(13);
    expect(live?.stats.seekRestarts).toBeGreaterThan(restartsBefore);
    // Encoded by a different ffmpeg run, decoded with the first run's init segment.
    expect(Number(far.videoPackets[0]?.pts_time)).toBeCloseTo(13 * SEG, 1);
    expect(far.videoPackets[0]?.flags).toContain('K');
    // Must end on the same frame a continuous encode would (first frame >= 84 starts seg 14).
    const last = Number(far.videoPackets.at(-1)?.pts_time);
    expect(last).toBeGreaterThan(13 * SEG + 5.8);
    expect(last).toBeLessThan(14 * SEG);
    const next = await probeSegment(14);
    expect(Number(next.videoPackets[0]?.pts_time)).toBeGreaterThanOrEqual(14 * SEG);
    expect(Number(next.videoPackets[0]?.pts_time)).toBeLessThan(14 * SEG + 0.05);
  });

  it('serves normalised UTF-8 WebVTT, including Windows-1256 Arabic with RTL marks', async () => {
    const res = await fetch(resolve('subs/ar/subtitles.vtt'));
    expect(res.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    const ar = await res.text();
    expect(ar.startsWith('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n')).toBe(true);
    expect(ar).toContain(`${RLM}مرحباً بكم في اختبار البث.${RLM}`);
    expect(ar).toContain(`${RLM}هل تسمع الصوت بوضوح؟${RLM}`);
    const en = await (await fetch(resolve('subs/en/subtitles.vtt'))).text();
    expect(en).toContain('<i>This title is synthetic</i> &amp; dedicated');
    expect(en).not.toContain('<font');
    const playlist = await (await fetch(resolve('subs/ar/index.m3u8'))).text();
    expect(playlist).toContain('subtitles.vtt');
  });

  it('plays, seeks and renders Arabic cues in Chromium via hls.js', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/player/?autostart=1&engine=hlsjs&quality=720p`);
      await page.waitForFunction(() => document.querySelector('video')!.currentTime > 2, null, {
        timeout: 60_000,
      });

      const tracks = await page.evaluate(() =>
        Array.from(document.querySelector('video')!.textTracks).map((t) => t.language),
      );
      expect(tracks).toEqual(expect.arrayContaining(['en', 'ar']));

      await page.evaluate(() => {
        for (const t of Array.from(document.querySelector('video')!.textTracks)) {
          t.mode = t.language === 'ar' ? 'showing' : 'disabled';
        }
        document.querySelector('video')!.currentTime = 15.5;
      });
      const cue = await page.waitForFunction(
        () => {
          const ar = Array.from(document.querySelector('video')!.textTracks).find(
            (t) => t.language === 'ar',
          );
          const active = ar?.activeCues?.[0] as VTTCue | undefined;
          return active?.text ?? false;
        },
        null,
        { timeout: 60_000 },
      );
      const cueText = (await cue.jsonValue()) as string;
      expect(cueText.startsWith(RLM)).toBe(true);
      expect(cueText).toContain('الترجمة العربية');

      // Seek beyond the encoded range: forces a server-side encoder restart.
      await page.evaluate(() => {
        document.querySelector('video')!.currentTime = 70;
      });
      await page.waitForFunction(
        () => {
          const v = document.querySelector('video')!;
          return v.currentTime > 71 && !v.paused && v.readyState >= 3;
        },
        null,
        { timeout: 60_000 },
      );
      const playerState = await page.evaluate(
        () => (window as unknown as { __player: { errors: string[]; engine: string } }).__player,
      );
      expect(playerState).toMatchObject({ engine: 'hlsjs', errors: [] });
    } finally {
      await browser.close();
    }
  });

  it('enforces admission control when the worker is full', async () => {
    expect(app.manager.size).toBe(2); // API session + browser session
    const res = await createSession({ contentId: FIXTURE_ID });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
  });

  it('deletes session files on DELETE and on idle expiry, then drops the torrent', async () => {
    const sessionsDir = path.join(config.workDir, 'sessions');
    expect(
      (await fetch(`${base}/v1/playback/sessions/${session.sessionId}`, { method: 'DELETE' }))
        .status,
    ).toBe(204);
    expect((await fetch(session.masterPlaylistUrl)).status).toBe(404);
    expect(await readdir(sessionsDir)).toHaveLength(1);

    await app.manager.reap(Date.now() + (config.sessionIdleTimeoutSec + 1) * 1000);
    expect(app.manager.size).toBe(0);
    expect(await readdir(sessionsDir)).toHaveLength(0);

    await expect.poll(() => app.engine.stats().length, { timeout: 10_000 }).toBe(0);
    const torrentDir = path.join(config.workDir, 'torrents', fixtures.infoHash);
    await expect
      .poll(
        () =>
          access(torrentDir).then(
            () => 'present',
            () => 'deleted',
          ),
        { timeout: 10_000 },
      )
      .toBe('deleted');
  });

  it('plays and seeks with a second, independent HLS implementation (Chromium native)', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/player/?autostart=1&engine=native&quality=720p`);
      const supported = await page.evaluate(
        () => document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '',
      );
      if (!supported) return; // older Chromium without native HLS
      await page.waitForFunction(() => document.querySelector('video')!.currentTime > 2, null, {
        timeout: 60_000,
      });
      await page.evaluate(() => {
        document.querySelector('video')!.currentTime = 70;
      });
      await page.waitForFunction(() => document.querySelector('video')!.currentTime > 71, null, {
        timeout: 60_000,
      });
      const playerState = await page.evaluate(
        () => (window as unknown as { __player: { errors: string[] } }).__player,
      );
      expect(playerState.errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
