import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApi } from '../../src/app.js';
import type { ReadinessProbe } from '../../src/app.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function make(probes: Record<string, ReadinessProbe>, allowedOrigins: string[] = []) {
  app = await buildApi({
    config: { logLevel: 'silent', allowedOrigins, readinessTimeoutMs: 200 },
    probes,
  });
  return app;
}

describe('liveness', () => {
  it('reports ok without touching dependencies', async () => {
    const api = await make({ database: () => Promise.reject(new Error('down')) });
    const res = await api.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'streaming-api', version: '0.1.0' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('readiness', () => {
  it('is ready when every probe succeeds', async () => {
    const api = await make({ database: () => Promise.resolve(), redis: () => Promise.resolve() });
    const res = await api.inject('/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ready',
      checks: { database: { ok: true }, redis: { ok: true } },
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports failing and hanging dependencies with 503', async () => {
    const api = await make({
      database: () => Promise.reject(new Error('connection refused')),
      redis: () => new Promise<void>(() => undefined),
    });
    const res = await api.inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'not_ready',
      checks: {
        database: { ok: false, error: 'connection refused' },
        redis: { ok: false, error: 'timed out after 200 ms' },
      },
    });
  });
});

describe('errors and CORS', () => {
  it('returns the shared error body for unknown routes', async () => {
    const api = await make({});
    const res = await api.inject('/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route GET /nope not found' },
    });
  });

  it('only reflects allow-listed origins', async () => {
    const api = await make({}, ['capacitor://localhost']);
    const ok = await api.inject({ url: '/healthz', headers: { origin: 'capacitor://localhost' } });
    expect(ok.headers['access-control-allow-origin']).toBe('capacitor://localhost');
    const evil = await api.inject({ url: '/healthz', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await api.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: { origin: 'capacitor://localhost' },
    });
    expect(preflight.statusCode).toBe(204);
  });
});

describe('OpenAPI', () => {
  it('documents the implemented routes', async () => {
    const api = await make({});
    const doc = (await api.inject('/openapi.json')).json<{
      openapi: string;
      paths: Record<string, unknown>;
    }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(['/healthz', '/readyz']);
  });
});
