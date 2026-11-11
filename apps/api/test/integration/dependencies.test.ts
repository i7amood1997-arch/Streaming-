import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../../src/app.js';
import { createDatabase } from '../../src/db/client.js';
import type { DatabaseHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createRedis } from '../../src/redis.js';
import type { RedisHandle } from '../../src/redis.js';

/**
 * Runs against real PostgreSQL and Redis. Fails loudly (never skips) when
 * they are not configured, so a green run always means "actually tested".
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const REDIS_URL = process.env['TEST_REDIS_URL'];
if (!DATABASE_URL || !REDIS_URL) {
  throw new Error('Integration tests need TEST_DATABASE_URL and TEST_REDIS_URL');
}

let database: DatabaseHandle;
let redis: RedisHandle;

async function waitReady(handle: RedisHandle) {
  for (let i = 0; i < 50; i++) {
    try {
      await handle.ping();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('redis never became ready');
}

beforeAll(async () => {
  database = createDatabase(DATABASE_URL, { poolMax: 2 });
  // Start from an empty schema so the migration path is exercised every run.
  await database.pool.query(
    'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
  );
  redis = createRedis(REDIS_URL, () => undefined);
  await waitReady(redis);
});

afterAll(async () => {
  await database.close();
  await redis.close();
});

describe('database migrations', () => {
  it('apply on an empty database and are idempotent', async () => {
    await runMigrations(database);
    await runMigrations(database);
    const { rows } = await database.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual(['sources', 'title_localizations', 'titles']);
  });

  it('enforce the authorization record constraints', async () => {
    const {
      rows: [title],
    } = await database.pool.query<{ id: string }>(
      "INSERT INTO titles (slug, kind, title) VALUES ('sintel', 'movie', 'Sintel') RETURNING id",
    );
    const insert = (infohash: string, verifiedBy: string | null) =>
      database.pool.query(
        `INSERT INTO sources (title_id, infohash, torrent, video_file_index, license, license_url, attribution, provenance_url, verified_by, verified_at)
         VALUES ($1, $2, '\\x00', 0, 'CC-BY-3.0', 'https://creativecommons.org/licenses/by/3.0/', 'Blender Foundation', 'https://durian.blender.org', $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)`,
        [title?.id, infohash, verifiedBy],
      );
    await insert('08ada5a7a6183aae1e09d831df6748d566095a10', 'reviewer');
    await expect(insert('08ada5a7a6183aae1e09d831df6748d566095a10', null)).rejects.toThrow(
      /sources_infohash_key/,
    );
    await expect(insert('NOT-A-HASH', null)).rejects.toThrow(/sources_infohash_format/);
    await expect(
      database.pool.query(
        "INSERT INTO titles (slug, kind, title) VALUES ('Bad Slug', 'movie', 'x')",
      ),
    ).rejects.toThrow(/titles_slug_format/);
    await expect(database.pool.query('DELETE FROM titles')).rejects.toThrow(
      /sources_title_id_titles_id_fk/,
    );
  });
});

describe('readiness against real dependencies', () => {
  it('is ready when PostgreSQL and Redis answer', async () => {
    const app = await buildApi({
      config: { logLevel: 'silent', allowedOrigins: [], readinessTimeoutMs: 1500 },
      probes: { database: database.ping, redis: redis.ping },
    });
    const res = await app.inject('/readyz');
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready' });
  });

  it('is not ready when a dependency is unreachable', async () => {
    const deadDb = createDatabase('postgres://streaming:streaming@127.0.0.1:1/none', {
      poolMax: 1,
    });
    const deadRedis = createRedis('redis://127.0.0.1:1', () => undefined);
    const app = await buildApi({
      config: { logLevel: 'silent', allowedOrigins: [], readinessTimeoutMs: 1500 },
      probes: { database: deadDb.ping, redis: deadRedis.ping },
    });
    const res = await app.inject('/readyz');
    await app.close();
    await deadDb.close();
    await deadRedis.close();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'not_ready',
      checks: { database: { ok: false }, redis: { ok: false, error: 'not connected' } },
    });
  });
});
