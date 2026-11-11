import { AppError } from '@streaming/contracts';
import type { ErrorBody } from '@streaming/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/** Single mapping from thrown errors to the shared ErrorBody shape. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    const body: ErrorBody = {
      error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` },
    };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfterSec !== undefined) reply.header('Retry-After', String(err.retryAfterSec));
      const body: ErrorBody = { error: { code: err.code, message: err.message } };
      return reply.code(err.httpStatus).send(body);
    }
    if (err instanceof z.ZodError) {
      const body: ErrorBody = {
        error: { code: 'VALIDATION_FAILED', message: 'Invalid request', issues: err.issues },
      };
      return reply.code(400).send(body);
    }
    // Fastify's own client errors (malformed JSON, body too large, ...).
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      const body: ErrorBody = {
        error: { code: 'VALIDATION_FAILED', message: (err as Error).message },
      };
      return reply.code(status).send(body);
    }
    req.log.error({ err }, 'unhandled error');
    const body: ErrorBody = { error: { code: 'INTERNAL', message: 'Internal server error' } };
    return reply.code(500).send(body);
  });
}
