/** Typed domain errors mapped to HTTP responses in one place (http/server.ts). */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`, 404);

export const capacityExceeded = (reason: string) =>
  new AppError('CAPACITY_EXCEEDED', reason, 503, 10);

export const segmentNotReady = (index: number) =>
  new AppError('SEGMENT_NOT_READY', `Segment ${index} is not ready yet`, 503, 2);

export const transcodeFailed = (detail: string) =>
  new AppError('TRANSCODE_FAILED', `Transcoding failed: ${detail}`, 502);

export const sourceUnavailable = (detail: string) =>
  new AppError('SOURCE_UNAVAILABLE', `Media source unavailable: ${detail}`, 502);
