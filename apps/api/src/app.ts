import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  buildOpenApiDocument,
} from '@streaming/contracts';
import type { DependencyCheck, LivenessResponse, ReadinessResponse } from '@streaming/contracts';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from './config.js';
import { registerErrorHandling } from './http/errors.js';

export const SERVICE_NAME = 'streaming-api';
export const SERVICE_VERSION = '0.1.0';

/** A dependency probe used by /readyz; must reject when the dependency is unusable. */
export type ReadinessProbe = () => Promise<void>;

export interface ApiDeps {
  config: Pick<ApiConfig, 'logLevel' | 'allowedOrigins' | 'readinessTimeoutMs'>;
  probes: Record<string, ReadinessProbe>;
}

async function runProbe(probe: ReadinessProbe, timeoutMs: number): Promise<DependencyCheck> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

const OPENAPI = buildOpenApiDocument({
  title: 'Streaming API',
  version: SERVICE_VERSION,
  routes: [
    {
      method: 'get',
      path: '/healthz',
      summary: 'Liveness probe (no dependency checks)',
      responses: { 200: { description: 'Process is alive', schema: LivenessResponseSchema } },
    },
    {
      method: 'get',
      path: '/readyz',
      summary: 'Readiness probe (PostgreSQL, Redis)',
      responses: {
        200: { description: 'All dependencies reachable', schema: ReadinessResponseSchema },
        503: {
          description: 'At least one dependency unavailable',
          schema: ReadinessResponseSchema,
        },
      },
    },
  ],
});

export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.logLevel === 'silent' ? false : { level: deps.config.logLevel },
    bodyLimit: 64 * 1024,
    trustProxy: false,
    disableRequestLogging: false,
  });
  registerErrorHandling(app);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    const origin = req.headers.origin;
    if (origin && deps.config.allowedOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      reply.header('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') await reply.code(204).send();
  });

  app.get('/healthz', (): LivenessResponse => ({
    status: 'ok',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
  }));

  app.get('/readyz', async (_req, reply) => {
    const entries = await Promise.all(
      Object.entries(deps.probes).map(
        async ([name, probe]) =>
          [name, await runProbe(probe, deps.config.readinessTimeoutMs)] as const,
      ),
    );
    const checks = Object.fromEntries(entries);
    const ready = entries.every(([, c]) => c.ok);
    const body: ReadinessResponse = { status: ready ? 'ready' : 'not_ready', checks };
    return reply
      .code(ready ? 200 : 503)
      .header('Cache-Control', 'no-store')
      .send(body);
  });

  app.get('/openapi.json', () => OPENAPI);

  return app;
}
