import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';
import type { TorrentHandle } from './engine.js';

/**
 * Loopback-only HTTP server that exposes torrent files as seekable byte-range
 * resources. ffmpeg/ffprobe read from it exactly as from any HTTP file, so the
 * demuxer can jump to an MP4 `moov` atom at the end of the file or seek to a
 * timestamp; each range request re-prioritises the torrent pieces it needs.
 *
 * Never exposed publicly: it binds to 127.0.0.1 and every URL carries a random
 * per-process capability token.
 */
export class TorrentSourceServer {
  private readonly server: http.Server;
  private readonly token = randomBytes(16).toString('hex');
  private readonly handles = new Map<string, TorrentHandle>();
  private baseUrl = '';

  constructor() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    // ffmpeg keeps connections open while paused (SIGSTOP); do not time them out.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 30_000;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}/${this.token}`;
  }

  /** Registers a handle and returns the URL ffmpeg should open for a file. */
  register(key: string, handle: TorrentHandle): (fileIndex: number) => string {
    this.handles.set(key, handle);
    return (fileIndex) => `${this.baseUrl}/${key}/${fileIndex}`;
  }

  unregister(key: string): void {
    this.handles.delete(key);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parts = (req.url ?? '').split('/').filter(Boolean);
    const [token, key, indexStr] = parts;
    if (parts.length !== 3 || token !== this.token || !key || !indexStr) {
      res.writeHead(404).end();
      return;
    }
    const handle = this.handles.get(key);
    const index = Number(indexStr);
    if (!handle || !Number.isInteger(index) || index < 0 || index >= handle.files.length) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    const size = handle.fileLength(index);
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const headers: http.OutgoingHttpHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'application/octet-stream',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    const stream = handle.createReadStream(index, start, end);
    res.on('close', () => stream.destroy());
    try {
      await pipeline(stream, res);
    } catch {
      // Client (ffmpeg) closed the connection after a seek: expected.
    }
  }
}

/** Parses a single-range `Range` header. Returns null when absent. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const [, startStr = '', endStr = ''] = match;
  if (startStr === '' && endStr === '') return 'invalid';
  let start: number;
  let end: number;
  if (startStr === '') {
    const suffix = Number(endStr);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}
