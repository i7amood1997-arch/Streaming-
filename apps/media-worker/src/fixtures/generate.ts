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

export const UHD_FIXTURE_ID = 'm2-uhd-hevc';
export const UHD_FIXTURE_NAME = 'M2 UHD HEVC';
export const UHD_FIXTURE_DURATION_SEC = 20;

export const SURROUND_FIXTURE_ID = 'm2-ac3-surround';
export const SURROUND_FIXTURE_NAME = 'M2 AC-3 Surround';
export const SURROUND_FIXTURE_DURATION_SEC = 30;

export interface FixtureTitle {
  id: string;
  torrentPath: string;
  infoHash: string;
  /** Path of the video file on disk (seeded data), for comparisons in tests. */
  videoPath: string;
}

export interface Fixtures {
  catalogDir: string;
  mediaRoot: string;
  /** Primary title (1080p H.264 MP4); kept as top-level fields for convenience. */
  torrentPath: string;
  infoHash: string;
  videoPath: string;
  uhd: FixtureTitle;
  /** 720p H.264 + AC-3 5.1 (English) MKV: copy video, separate AAC audio rendition. */
  surround: FixtureTitle;
  torrentPaths: string[];
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
  const uhdFolder = path.join(mediaRoot, UHD_FIXTURE_NAME);
  const uhdTorrentPath = path.join(dir, `${UHD_FIXTURE_ID}.torrent`);
  const surroundFolder = path.join(mediaRoot, SURROUND_FIXTURE_NAME);
  const surroundTorrentPath = path.join(dir, `${SURROUND_FIXTURE_ID}.torrent`);
  const surroundVideoPath = path.join(surroundFolder, `${SURROUND_FIXTURE_NAME}.mkv`);
  const catalogPath = path.join(dir, 'catalog.json');
  const videoPath = path.join(folder, `${FIXTURE_NAME}.mp4`);
  const uhdVideoPath = path.join(uhdFolder, `${UHD_FIXTURE_NAME}.mkv`);
  const result = (infoHash: string, uhdInfoHash: string, surroundInfoHash: string): Fixtures => ({
    catalogDir: dir,
    mediaRoot,
    torrentPath,
    infoHash,
    videoPath,
    uhd: {
      id: UHD_FIXTURE_ID,
      torrentPath: uhdTorrentPath,
      infoHash: uhdInfoHash,
      videoPath: uhdVideoPath,
    },
    surround: {
      id: SURROUND_FIXTURE_ID,
      torrentPath: surroundTorrentPath,
      infoHash: surroundInfoHash,
      videoPath: surroundVideoPath,
    },
    torrentPaths: [torrentPath, uhdTorrentPath, surroundTorrentPath],
  });

  if (
    !opts.force &&
    (await exists(catalogPath)) &&
    (await exists(torrentPath)) &&
    (await exists(uhdTorrentPath)) &&
    (await exists(surroundTorrentPath))
  ) {
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      entries: { id: string; infoHash: string }[];
    };
    const main = catalog.entries.find((e) => e.id === FIXTURE_ID)?.infoHash;
    const uhd = catalog.entries.find((e) => e.id === UHD_FIXTURE_ID)?.infoHash;
    const surround = catalog.entries.find((e) => e.id === SURROUND_FIXTURE_ID)?.infoHash;
    if (main && uhd && surround) return result(main, uhd, surround);
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const video = videoPath;
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

  // Second title: 4K HEVC Main 10 in Matroska with 2 s GOPs, for passthrough (copy) mode.
  await mkdir(uhdFolder, { recursive: true });
  await execFileAsync(opts.ffmpegPath ?? 'ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=3840x2160:rate=24:duration=${UHD_FIXTURE_DURATION_SEC}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=330:beep_factor=4:sample_rate=48000:duration=${UHD_FIXTURE_DURATION_SEC}`,
    '-c:v',
    'libx265',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p10le',
    '-x265-params',
    'keyint=48:min-keyint=24:log-level=error',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-metadata',
    `title=${UHD_FIXTURE_NAME}`,
    '-y',
    uhdVideoPath,
  ]);
  await writeFile(
    path.join(uhdFolder, 'LICENSE.txt'),
    `${UHD_FIXTURE_NAME} — synthetic test media (ffmpeg testsrc2 + sine). CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/\n`,
  );
  const uhdTorrent = await createTorrentFile(uhdFolder);
  await writeFile(uhdTorrentPath, uhdTorrent.torrent);
  const uhdVideoFileIndex = uhdTorrent.fileNames.findIndex((n) => n.endsWith('.mkv'));

  // Third title: 720p H.264 + AC-3 5.1 (English) in Matroska, like many disc
  // releases. AC-3 is not decodable through MSE in Chromium/Firefox (hls.js),
  // so video is copied and audio becomes a separate AAC stereo rendition.
  await mkdir(surroundFolder, { recursive: true });
  await execFileAsync(opts.ffmpegPath ?? 'ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=24:duration=${SURROUND_FIXTURE_DURATION_SEC}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=550:beep_factor=4:sample_rate=48000:duration=${SURROUND_FIXTURE_DURATION_SEC}`,
    '-filter_complex',
    '[1:a]pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0[a]',
    '-map',
    '0:v',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-g',
    '48',
    '-c:a',
    'ac3',
    '-b:a',
    '384k',
    '-metadata:s:a:0',
    'language=eng',
    '-y',
    surroundVideoPath,
  ]);
  await writeFile(
    path.join(surroundFolder, 'LICENSE.txt'),
    `${SURROUND_FIXTURE_NAME} — synthetic test media (ffmpeg testsrc2 + sine). CC0 1.0 Universal — https://creativecommons.org/publicdomain/zero/1.0/\n`,
  );
  const surroundTorrent = await createTorrentFile(surroundFolder);
  await writeFile(surroundTorrentPath, surroundTorrent.torrent);
  const surroundVideoFileIndex = surroundTorrent.fileNames.findIndex((n) => n.endsWith('.mkv'));
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
          {
            id: UHD_FIXTURE_ID,
            title: `${UHD_FIXTURE_NAME} (synthetic)`,
            license: 'CC0-1.0',
            licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
            attribution:
              'Generated by this repository (ffmpeg testsrc2 + sine). No third-party rights.',
            provenanceUrl: 'apps/media-worker/src/fixtures/generate.ts',
            infoHash: uhdTorrent.infoHash,
            torrentFile: path.basename(uhdTorrentPath),
            videoFileIndex: uhdVideoFileIndex,
          },
          {
            id: SURROUND_FIXTURE_ID,
            title: `${SURROUND_FIXTURE_NAME} (synthetic)`,
            license: 'CC0-1.0',
            licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
            attribution:
              'Generated by this repository (ffmpeg testsrc2 + sine). No third-party rights.',
            provenanceUrl: 'apps/media-worker/src/fixtures/generate.ts',
            infoHash: surroundTorrent.infoHash,
            torrentFile: path.basename(surroundTorrentPath),
            videoFileIndex: surroundVideoFileIndex,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  return result(infoHash, uhdTorrent.infoHash, surroundTorrent.infoHash);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  const result = await ensureFixtures(DEFAULT_FIXTURES_DIR, { force });
  process.stdout.write(
    `Fixtures ready in ${result.catalogDir} (${result.infoHash}, ${result.uhd.infoHash})\n`,
  );
}
