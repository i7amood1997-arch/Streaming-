import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed capability tokens for HLS URLs.
 *
 * Safari's native player cannot attach Authorization headers to playlist or
 * segment requests, and it resolves relative URIs against the playlist URL
 * *without* its query string. The token is therefore a path segment
 * (`/v1/hls/<session>/<token>/...`) so every relative URI inherits it.
 *
 * Format: `<expiresAtUnixSec>.<base64url HMAC-SHA256(secret, sessionId:exp)>`.
 */
export function signStreamToken(secret: string, sessionId: string, expiresAtSec: number): string {
  const exp = Math.floor(expiresAtSec);
  return `${exp}.${mac(secret, sessionId, exp)}`;
}

export function verifyStreamToken(
  secret: string,
  sessionId: string,
  token: string,
  nowSec: number = Date.now() / 1000,
): boolean {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const exp = Number(match[1]);
  if (exp <= nowSec) return false;
  const expected = Buffer.from(mac(secret, sessionId, exp));
  const given = Buffer.from(match[2] ?? '');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function mac(secret: string, sessionId: string, exp: number): string {
  return createHmac('sha256', secret).update(`${sessionId}:${exp}`).digest('base64url');
}
