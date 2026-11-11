import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { encodeSingleByte } from '@streaming/media-core';
import WebTorrent from 'webtorrent';

const execFileAsync = promisify(execFile);

/**
 * Generates the M0 test title. It is synthetic (ffmpeg test pattern + tone)
 * and dedicated to the public domain (CC0), so it is unambiguously authorized
 * and reproducible offline and in CI. Real-world titles (Blender open movies,
 * Internet Archive public-domain films) are covered by the runbook in
 * docs/feasibility/M0-pipeline-spike.md.
 */
export const FIXTURE_ID = 'm0-test-pattern';
export const FIXTURE_NAME = 'M0 Test Pattern';
export const FIXTURE_DURATION_SEC = 90;

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURES_DIR = path.resolve(here, '../../fixtures');

export interface Fixtures {
  catalogDir: string;
  mediaRoot: string;
  torrentPath: string;
  infoHash: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const srtTime = (sec: number) =>
  `00:${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))},${String(Math.round((sec % 1) * 1000)).padStart(3, '0')}`;
const clock = (sec: number) => `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;

function srt(cues: [number, number, string][], eol: string): string {
  return cues
    .map(([s, e, t], i) =>
      [String(i + 1), `${srtTime(s)} --> ${srtTime(e)}`, t.replace(/\n/g, eol)].join(eol),
    )
    .join(eol + eol)
    .concat(eol);
}

export function englishSubtitles(): string {
  const cues: [number, number, string][] = [
    [1, 4.5, 'Welcome to the streaming pipeline test.'],
    [5, 9, '<i>This title is synthetic</i> & dedicated to the public domain.'],
    [10, 14, '<font color="#ffff00">Can you hear the tone clearly?</font>'],
  ];
  for (let t = 15; t < FIXTURE_DURATION_SEC - 1; t += 5) {
    cues.push([t, t + 4, `English cue at ${clock(t)}`]);
  }
  return srt(cues, '\n');
}

export function arabicSubtitles(): string {
  const cues: [number, number, string][] = [
    [1, 4.5, 'مرحباً بكم في اختبار البث.'],
    [5, 9, 'هذا مقطع تجريبي رقم 2 بجودة 1080p.'],
    // Deliberately stored in visual order (legacy editor artefact) to exercise the fixer.
    [10, 14, '؟هل تسمع الصوت بوضوح'],
  ];
  for (let t = 15; t < FIXTURE_DURATION_SEC - 1; t += 5) {
    cues.push([t, t + 4, `- الترجمة العربية عند ${clock(t)}\n- ممتاز!`]);
  }
  // Windows line endings, as produced by most Windows subtitle tools.
  return srt(cues, '\r\n');
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function createTorrentFile(
  folder: string,
): Promise<{ torrent: Buffer; infoHash: string; fileNames: string[] }> {
  const client = new WebTorrent({
    dht: false,
    tracker: false,
    lsd: false,
    utPex: false,
    natUpnp: false,
    natPmp: false,
    utp: false,
  });
  try {
    return await new Promise((resolve, reject) => {
      client.on('error', reject);
      client.seed(folder, { announce: [] }, (t) => {
        resolve({
          torrent: Buffer.from(t.torrentFile),
          infoHash: t.infoHash,
          fileNames: t.files.map((f) => f.name),
        });
      });
    });
  } finally {
    await new Promise<void>((resolve) => {
      client.destroy(() => {
        resolve();
      });
    });
  }
}

export async function ensureFixtures(
  dir: string = DEFAULT_FIXTURES_DIR,
  opts: { force?: boolean; ffmpegPath?: string } = {},
): Promise<Fixtures> {
  const mediaRoot = path.join(dir, 'media');
  const folder = path.join(mediaRoot, FIXTURE_NAME);
  const torrentPath = path.join(dir, `${FIXTURE_ID}.torrent`);
  const catalogPath = path.join(dir, 'catalog.json');

  if (!opts.force && (await exists(catalogPath)) && (await exists(torrentPath))) {
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      entries: { infoHash: string }[];
    };
    const infoHash = catalog.entries[0]?.infoHash;
    if (infoHash) return { catalogDir: dir, mediaRoot, torrentPath, infoHash };
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const video = path.join(folder, `${FIXTURE_NAME}.mp4`);
  // 1080p23.976 H.264 High + AAC stereo, 4 s GOP, moov at the END (no faststart)
  // so the pipeline must fetch the tail of the torrent before it can play.
  await execFileAsync(opts.ffmpegPath ?? 'ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1920x1080:rate=24000/1001:duration=${FIXTURE_DURATION_SEC}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:beep_factor=4:sample_rate=48000:duration=${FIXTURE_DURATION_SEC}`,
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '96',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-metadata',
    `title=${FIXTURE_NAME}`,
    '-y',
    video,
  ]);
  await writeFile(path.join(folder, `${FIXTURE_NAME}.en.srt`), englishSubtitles(), 'utf8');
  await writeFile(
    path.join(folder, `${FIXTURE_NAME}.ar.srt`),
    encodeSingleByte(arabicSubtitles(), 'windows-1256'),
  );
  await writeFile(
    path.join(folder, 'LICENSE.txt'),
    [
      `${FIXTURE_NAME} — synthetic test media generated by apps/media-worker/src/fixtures/generate.ts`,
      '(ffmpeg testsrc2 video pattern, sine tone, subtitles written for this project).',
      'To the extent possible under law, the authors waive all copyright and related rights:',
      'CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/',
      '',
    ].join('\n'),
  );

  const { torrent, infoHash, fileNames } = await createTorrentFile(folder);
  await writeFile(torrentPath, torrent);
  const videoFileIndex = fileNames.findIndex((n) => n.endsWith('.mp4'));
  await writeFile(
    catalogPath,
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            id: FIXTURE_ID,
            title: `${FIXTURE_NAME} (synthetic)`,
            license: 'CC0-1.0',
            licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
            attribution:
              'Generated by this repository (ffmpeg testsrc2 + sine). No third-party rights.',
            provenanceUrl: 'apps/media-worker/src/fixtures/generate.ts',
            infoHash,
            torrentFile: path.basename(torrentPath),
            videoFileIndex,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  return { catalogDir: dir, mediaRoot, torrentPath, infoHash };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  const result = await ensureFixtures(DEFAULT_FIXTURES_DIR, { force });
  process.stdout.write(`Fixtures ready in ${result.catalogDir} (infohash ${result.infoHash})\n`);
}
