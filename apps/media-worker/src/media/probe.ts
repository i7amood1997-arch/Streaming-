import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toMediaInfo } from '@streaming/media-core';
import type { MediaInfo } from '@streaming/media-core';

const execFileAsync = promisify(execFile);

export async function probeMedia(
  ffprobePath: string,
  url: string,
  opts: { timeoutMs: number; readTimeoutSec: number },
): Promise<MediaInfo> {
  const { stdout } = await execFileAsync(
    ffprobePath,
    [
      '-v',
      'error',
      '-rw_timeout',
      String(opts.readTimeoutSec * 1_000_000),
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ],
    { timeout: opts.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
  );
  return toMediaInfo(JSON.parse(stdout));
}
