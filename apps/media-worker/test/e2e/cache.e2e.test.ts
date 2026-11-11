import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { FIXTURE_ID, ensureFixtures } from '../../src/fixtures/generate.js';
import type { Fixtures } from '../../src/fixtures/generate.js';
import { startSeeder } from '../../src/fixtures/seeder.js';
import type { Seeder } from '../../src/fixtures/seeder.js';

/**
 * Persistent torrent cache: released torrent data stays on disk, is
 * re-verified on re-add and serves playback without any peer — across
 * sessions and across worker restarts — until LRU quota eviction.
 */
let fixtures: Fixtures;
let seeder: Seeder | undefined;
let scratch: string;
let workDir: string;

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

async function startWorker(
  overrides: Partial<Config>,
  peers: string[],
): Promise<{ app: App; base: string }> {
  const config = loadConfig(
    {},
    {
      host: '127.0.0.1',
      port: 0,
      workDir,
      catalogDir: fixtures.catalogDir,
      minFreeDiskMiB: 0,
      torrentLingerSec: 0,
      segmentWaitTimeoutSec: 60,
      torrentCacheMaxMiB: 1024,
      // Small read-ahead so the download footprint reflects what was played.
      maxSegmentsAhead: 2,
      torrentReadWindowMiB: 1,
      torrent: {
        port: 0,
        dht: false,
        trackers: false,
        webSeeds: false,
        allowPrivatePeers: true,
        maxConns: 10,
        uploadLimitKiBps: -1,
      },
      ...overrides,
    },
  );
  const app = await createApp(config, { bootstrapPeers: peers });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return { app, base: `http://127.0.0.1:${address.port}` };
}

/** Creates a session and fetches init + the first two segments; returns the session id. */
async function playFirstSegments(base: string): Promise<string> {
  const res = await fetch(`${base}/v1/playback/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentId: FIXTURE_ID, quality: 'auto' }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    sessionId: string;
    masterPlaylistUrl: string;
    decisions: { code: string }[];
  };
  expect(body.decisions.map((d) => d.code)).toEqual(['COPY']);
  const master = new URL(body.masterPlaylistUrl, base);
  for (const rel of ['video/init.mp4', 'video/seg-0.m4s', 'video/seg-1.m4s']) {
    const r = await fetch(new URL(rel, master));
    expect(r.status, rel).toBe(200);
    await r.arrayBuffer();
  }
  return body.sessionId;
}

async function release(app: App, base: string, sessionId: string): Promise<void> {
  expect(
    (await fetch(`${base}/v1/playback/sessions/${sessionId}`, { method: 'DELETE' })).status,
  ).toBe(204);
  await expect.poll(() => app.engine.stats().length, { timeout: 10_000 }).toBe(0);
}

beforeAll(async () => {
  fixtures = await ensureFixtures();
  scratch = path.resolve('.data', `e2e-cache-${Date.now()}`);
  workDir = path.join(scratch, 'work');
  await mkdir(scratch, { recursive: true });
  seeder = await startSeeder({ torrentPaths: fixtures.torrentPaths, dataPath: fixtures.mediaRoot });
});

afterAll(async () => {
  await seeder?.close();
  await rm(scratch, { recursive: true, force: true });
});

describe('persistent torrent cache', () => {
  const torrentDir = () => path.join(workDir, 'torrents', fixtures.infoHash);

  it('keeps released torrent data on disk with a recency marker', async () => {
    if (!seeder) throw new Error('seeder not started');
    const { app, base } = await startWorker({}, [seeder.address]);
    try {
      await release(app, base, await playFirstSegments(base));
      expect(await exists(path.join(torrentDir(), '.last-used'))).toBe(true);
      const usage = await app.engine.cacheUsage();
      expect(usage.torrents).toBe(1);
      // Only what was read (+ bounded read-ahead) was downloaded, not the 29 MB title.
      expect(usage.bytes).toBeGreaterThan(0);
      // Measured 8.0 MB with 1 MiB windows; unbounded reads cached the whole 29.6 MB title.
      expect(usage.bytes).toBeLessThan(12 * 1024 * 1024);
    } finally {
      await app.close();
    }
  });

  it('replays from cache with no peer at all, after a worker restart', async () => {
    await seeder?.close();
    seeder = undefined; // the only peer is gone
    const { app, base } = await startWorker({}, []);
    try {
      const sessionId = await playFirstSegments(base);
      const [torrent] = app.engine.stats();
      expect(torrent?.peers).toBe(0);
      await release(app, base, sessionId);
    } finally {
      await app.close();
    }
  });

  it('evicts idle cached data at startup when it exceeds the quota', async () => {
    expect(await exists(torrentDir())).toBe(true);
    const { app } = await startWorker({ torrentCacheMaxMiB: 0 }, []);
    try {
      expect(await exists(torrentDir())).toBe(false);
      expect(await app.engine.cacheUsage()).toEqual({ torrents: 0, bytes: 0 });
    } finally {
      await app.close();
    }
  });
});
