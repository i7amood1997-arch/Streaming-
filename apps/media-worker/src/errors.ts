import { AppError } from '@streaming/contracts';

export { AppError, capacityExceeded, notFound } from '@streaming/contracts';

/** Worker-specific domain errors; mapped to HTTP in http/server.ts. */
export const segmentNotReady = (index: number) =>
  new AppError('SEGMENT_NOT_READY', `Segment ${index} is not ready yet`, 503, 2);

export const transcodeFailed = (detail: string) =>
  new AppError('TRANSCODE_FAILED', `Transcoding failed: ${detail}`, 502);

export const sourceUnavailable = (detail: string) =>
  new AppError('SOURCE_UNAVAILABLE', `Media source unavailable: ${detail}`, 502);
