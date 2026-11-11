import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  CreatePlaybackSessionRequestSchema,
  ErrorBodySchema,
  buildOpenApiDocument,
  capacityExceeded,
} from '../src/index.js';

describe('CreatePlaybackSessionRequestSchema', () => {
  it('applies defaults', () => {
    expect(CreatePlaybackSessionRequestSchema.parse({ contentId: 'x' })).toEqual({
      contentId: 'x',
      quality: 'auto',
      startPositionSec: 0,
      capabilities: { hevc: false, maxHeight: 1080 },
    });
  });

  it('rejects invalid values', () => {
    expect(() => CreatePlaybackSessionRequestSchema.parse({ contentId: '' })).toThrow();
    expect(() =>
      CreatePlaybackSessionRequestSchema.parse({ contentId: 'x', quality: '8k' }),
    ).toThrow();
    expect(() =>
      CreatePlaybackSessionRequestSchema.parse({ contentId: 'x', startPositionSec: -1 }),
    ).toThrow();
  });
});

describe('errors', () => {
  it('carries HTTP mapping and retry hints', () => {
    const err = capacityExceeded('full');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'CAPACITY_EXCEEDED', httpStatus: 503, retryAfterSec: 10 });
    expect(ErrorBodySchema.safeParse({ error: { code: 'NOPE', message: 'x' } }).success).toBe(
      false,
    );
  });
});

describe('buildOpenApiDocument', () => {
  it('renders paths, parameters, bodies and the shared error response', () => {
    const doc = buildOpenApiDocument({
      title: 'Test',
      version: '1.0.0',
      routes: [
        {
          method: 'post',
          path: '/v1/things/:id',
          summary: 'Create thing',
          request: z.object({ name: z.string() }),
          responses: { 201: { description: 'Created', schema: z.object({ id: z.string() }) } },
        },
      ],
    });
    const op = (doc['paths'] as Record<string, Record<string, Record<string, unknown>>>)[
      '/v1/things/{id}'
    ]?.['post'];
    expect(doc['openapi']).toBe('3.1.0');
    expect(op?.['parameters']).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
    expect(JSON.stringify(op?.['requestBody'])).toContain('"name"');
    expect(Object.keys(op?.['responses'] as object)).toEqual(['201', 'default']);
  });
});
