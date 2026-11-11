import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CreatePlaybackSessionRequestSchema } from '@streaming/contracts';
import type { PlaybackSessionResponse } from '@streaming/contracts';
import { z } from 'zod';
import type { Catalog } from '../catalog.js';
import type { Config } from '../config.js';
import { AppError, notFound } from '../errors.js';
import {
  buildMasterPlaylist,
  buildMediaPlaylist,
  buildSubtitlePlaylist,
} from '@streaming/media-core';
import { signStreamToken, verifyStreamToken } from '@streaming/media-core';
import type { PlaybackSession } from '../session/playback-session.js';
import type { SessionManager } from '../session/session-manager.js';
import type { TorrentEngine } from '../torrent/engine.js';

const CONTENT_TYPES = {
  m3u8: 'application/vnd.apple.mpegurl',
  mp4: 'video/mp4',
  m4s: 'video/iso.segment',
  vtt: 'text/vtt; charset=utf-8',
} as const;

const HlsParams = z.object({
  sessionId: z.uuid(),
  token: z.string().max(80),
});

export interface ServerDeps {
  config: Config;
  catalog: Catalog;
  manager: SessionManager;
  engine: TorrentEngine;
  logger?: boolean;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, catalog, manager, engine } = deps;
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 16 * 1024,
    trustProxy: false,
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
      reply.header('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfterSec !== undefined) reply.header('Retry-After', String(err.retryAfterSec));
      return reply.code(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Invalid request', issues: err.issues },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  app.get('/healthz', () => ({
    status: 'ok',
    sessions: manager.size,
    torrents: engine.stats().length,
  }));

  app.get('/v1/catalog', () => ({
    items: catalog.list().map((e) => ({
      id: e.id,
      title: e.title,
      license: e.license,
      licenseUrl: e.licenseUrl,
      attribution: e.attribution,
    })),
  }));

  app.post('/v1/playback/sessions', async (req, reply) => {
    const body = CreatePlaybackSessionRequestSchema.parse(req.body);
    const session = await manager.create({
      contentId: body.contentId,
      quality: body.quality,
      startPositionSec: body.startPositionSec,
      capabilities: body.capabilities,
      ...(body.preferredAudioLanguage
        ? { preferredAudioLanguage: body.preferredAudioLanguage }
        : {}),
    });
    const token = signStreamToken(config.streamTokenSecret, session.id, session.expiresAtSec);
    const base = config.publicBaseUrl ?? '';
    const response: PlaybackSessionResponse = {
      sessionId: session.id,
      masterPlaylistUrl: `${base}/v1/hls/${session.id}/${token}/master.m3u8`,
      expiresAt: new Date(session.expiresAtSec * 1000).toISOString(),
      durationSec: session.info.durationSec,
      video: {
        width: session.plan.video.outputWidth,
        height: session.plan.video.outputHeight,
        quality: session.plan.video.rendition.quality,
        codecs: session.plan.video.codecString,
      },
      subtitles: session.subtitles.map((s) => ({
        language: s.language,
        name: s.name,
        forced: s.forced,
        rtl: s.rtl,
      })),
      decisions: session.plan.reasons,
    };
    return reply.code(201).send(response);
  });

  app.post<{ Params: { id: string } }>(
    '/v1/playback/sessions/:id/heartbeat',
    async (req, reply) => {
      const session = manager.get(req.params.id);
      if (!session) throw notFound('Session');
      session.touch();
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/playback/sessions/:id', async (req, reply) => {
    if (!(await manager.destroy(req.params.id))) throw notFound('Session');
    return reply.code(204).send();
  });

  // ---- HLS delivery (capability URL: /v1/hls/<session>/<token>/...) ----
  const sessionFor = (req: FastifyRequest): PlaybackSession => {
    const { sessionId, token } = HlsParams.parse(req.params);
    if (!verifyStreamToken(config.streamTokenSecret, sessionId, token)) {
      throw new AppError('FORBIDDEN', 'Invalid or expired stream token', 403);
    }
    const session = manager.get(sessionId);
    if (!session) throw notFound('Session');
    session.touch();
    return session;
  };

  const sendText = (reply: FastifyReply, type: string, body: string) =>
    reply.header('Content-Type', type).header('Cache-Control', 'private, no-cache').send(body);

  const sendFile = async (reply: FastifyReply, type: string, file: string) => {
    const { size } = await stat(file);
    return reply
      .header('Content-Type', type)
      .header('Content-Length', size)
      .header('Cache-Control', 'private, max-age=3600, immutable')
      .send(createReadStream(file));
  };

  app.get('/v1/hls/:sessionId/:token/master.m3u8', (req, reply) => {
    const session = sessionFor(req);
    const { plan } = session;
    return sendText(
      reply,
      CONTENT_TYPES.m3u8,
      buildMasterPlaylist(
        {
          bandwidth: plan.bandwidth,
          codecs: [plan.video.codecString, ...(plan.audio ? [plan.audio.codecString] : [])],
          width: plan.video.outputWidth,
          height: plan.video.outputHeight,
          frameRate: plan.video.frameRate,
          uri: 'video/index.m3u8',
        },
        session.subtitles.map((s) => ({
          language: s.language,
          name: s.name,
          uri: `subs/${s.slug}/index.m3u8`,
          isDefault: false,
          forced: s.forced,
        })),
      ),
    );
  });

  app.get('/v1/hls/:sessionId/:token/video/index.m3u8', (req, reply) => {
    const session = sessionFor(req);
    return sendText(
      reply,
      CONTENT_TYPES.m3u8,
      buildMediaPlaylist(session.timeline, {
        init: 'init.mp4',
        segment: (i) => `seg-${i}.m4s`,
      }),
    );
  });

  app.get('/v1/hls/:sessionId/:token/video/init.mp4', async (req, reply) => {
    const session = sessionFor(req);
    return sendFile(reply, CONTENT_TYPES.mp4, await session.getInit());
  });

  app.get<{ Params: { file: string } }>(
    '/v1/hls/:sessionId/:token/video/:file',
    async (req, reply) => {
      const session = sessionFor(req);
      const match = /^seg-(\d{1,6})\.m4s$/.exec(req.params.file);
      const index = match ? Number(match[1]) : -1;
      if (index < 0 || index >= session.timeline.length) throw notFound('Segment');
      return sendFile(reply, CONTENT_TYPES.m4s, await session.getSegment(index));
    },
  );

  const subtitleFor = (session: PlaybackSession, slug: string) => {
    const track = session.subtitles.find((s) => s.slug === slug);
    if (!track) throw notFound('Subtitle track');
    return track;
  };

  app.get<{ Params: { slug: string } }>(
    '/v1/hls/:sessionId/:token/subs/:slug/index.m3u8',
    (req, reply) => {
      const session = sessionFor(req);
      subtitleFor(session, req.params.slug);
      return sendText(
        reply,
        CONTENT_TYPES.m3u8,
        buildSubtitlePlaylist(session.info.durationSec, 'subtitles.vtt'),
      );
    },
  );

  app.get<{ Params: { slug: string } }>(
    '/v1/hls/:sessionId/:token/subs/:slug/subtitles.vtt',
    async (req, reply) => {
      const session = sessionFor(req);
      return sendFile(reply, CONTENT_TYPES.vtt, subtitleFor(session, req.params.slug).path);
    },
  );

  // ---- Diagnostic player (M0 only; not the product UI) ----
  const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
  const require = createRequire(import.meta.url);
  const hlsJsPath = require.resolve('hls.js/dist/hls.min.js');
  const staticFiles: Record<string, { file: string; type: string }> = {
    '/player/': { file: path.join(publicDir, 'player.html'), type: 'text/html; charset=utf-8' },
    '/player/player.js': {
      file: path.join(publicDir, 'player.js'),
      type: 'text/javascript; charset=utf-8',
    },
    '/player/vendor/hls.min.js': { file: hlsJsPath, type: 'text/javascript; charset=utf-8' },
  };
  for (const [route, { file, type }] of Object.entries(staticFiles)) {
    app.get(route, async (_req, reply) =>
      reply.header('Content-Type', type).send(await readFile(file)),
    );
  }

  return app;
}
