import { z } from 'zod';

/** Machine-readable error codes shared by every service. */
export const ErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'CAPACITY_EXCEEDED',
  'SEGMENT_NOT_READY',
  'SOURCE_UNAVAILABLE',
  'TRANSCODE_FAILED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** The only error body shape any endpoint returns. */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    issues: z.array(z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/**
 * Domain error carrying its HTTP mapping. Services throw these; one error
 * handler per service turns them into `ErrorBody` responses.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`, 404);

export const forbidden = (message: string) => new AppError('FORBIDDEN', message, 403);

export const capacityExceeded = (reason: string) =>
  new AppError('CAPACITY_EXCEEDED', reason, 503, 10);
