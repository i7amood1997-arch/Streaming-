import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

/**
 * Runtime configuration, validated at startup. Every value has a safe default
 * for local development except secrets, which are generated per-process when
 * absent (tokens then simply do not survive a restart).
 */
const ConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(0).max(65535).default(8080),
  /** Public base URL used when building absolute playlist URLs for clients. */
  publicBaseUrl: z.url().optional(),
  /** Comma-separated list of origins allowed to fetch HLS resources (CORS). */
  allowedOrigins: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** HMAC key for signed playback URLs. >= 32 bytes. */
  streamTokenSecret: z.string().min(32).optional(),
  workDir: z.string().default(path.resolve('.data')),
  /** Directory containing the authorized catalog manifest (catalog.json). */
  catalogDir: z.string().default(path.resolve('fixtures')),

  segmentDurationSec: z.coerce.number().int().min(2).max(10).default(6),
  maxSessions: z.coerce.number().int().min(1).default(4),
  maxConcurrentTranscodes: z.coerce.number().int().min(1).default(2),
  ffmpegPath: z.string().default('ffmpeg'),
  ffprobePath: z.string().default('ffprobe'),
  ffmpegThreads: z.coerce.number().int().min(0).default(0),
  x264Preset: z
    .enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'])
    .default('veryfast'),
  /** Seconds ffmpeg waits on a stalled read (torrent starvation) before failing. */
  sourceReadTimeoutSec: z.coerce.number().int().min(5).default(120),

  /** A session with no requests for this long is destroyed (files deleted). */
  sessionIdleTimeoutSec: z.coerce.number().int().min(10).default(600),
  /** A transcode with no segment requests for this long is stopped (session kept). */
  jobIdleTimeoutSec: z.coerce.number().int().min(5).default(60),
  /** Pause the encoder when it is this many segments ahead of the player. */
  maxSegmentsAhead: z.coerce.number().int().min(2).default(10),
  /** A request this many segments beyond the encoder head triggers a restart (seek). */
  seekRestartThreshold: z.coerce.number().int().min(1).default(4),
  segmentWaitTimeoutSec: z.coerce.number().int().min(1).default(30),
  /** Unreferenced torrents are kept this long for reuse, then deleted from disk. */
  torrentLingerSec: z.coerce.number().int().min(0).default(300),
  /** Refuse new sessions when free disk falls below this many MiB. */
  minFreeDiskMiB: z.coerce.number().int().min(0).default(2048),

  torrent: z.object({
    port: z.coerce.number().int().min(0).max(65535).default(0),
    dht: z.stringbool().default(true),
    trackers: z.stringbool().default(true),
    webSeeds: z.stringbool().default(true),
    /** Allow peers on private/loopback ranges. Only for local test swarms. */
    allowPrivatePeers: z.stringbool().default(false),
    maxConns: z.coerce.number().int().min(1).default(55),
    uploadLimitKiBps: z.coerce.number().int().min(-1).default(-1),
  }),
});

export type Config = z.infer<typeof ConfigSchema> & { streamTokenSecret: string };

export function loadConfig(
  rawEnv: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Config> = {},
): Config {
  // `KEY=` in an env file means "unset", so empty strings fall back to defaults.
  const env = Object.fromEntries(
    Object.entries(rawEnv).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = ConfigSchema.parse({
    host: env['HOST'],
    port: env['PORT'],
    publicBaseUrl: env['PUBLIC_BASE_URL'],
    allowedOrigins: env['ALLOWED_ORIGINS'],
    streamTokenSecret: env['STREAM_TOKEN_SECRET'],
    workDir: env['MEDIA_WORK_DIR'],
    catalogDir: env['CATALOG_DIR'],
    segmentDurationSec: env['HLS_SEGMENT_DURATION_SEC'],
    maxSessions: env['MAX_SESSIONS'],
    maxConcurrentTranscodes: env['MAX_CONCURRENT_TRANSCODES'],
    ffmpegPath: env['FFMPEG_PATH'],
    ffprobePath: env['FFPROBE_PATH'],
    ffmpegThreads: env['FFMPEG_THREADS'],
    x264Preset: env['X264_PRESET'],
    sourceReadTimeoutSec: env['SOURCE_READ_TIMEOUT_SEC'],
    sessionIdleTimeoutSec: env['SESSION_IDLE_TIMEOUT_SEC'],
    jobIdleTimeoutSec: env['JOB_IDLE_TIMEOUT_SEC'],
    maxSegmentsAhead: env['MAX_SEGMENTS_AHEAD'],
    seekRestartThreshold: env['SEEK_RESTART_THRESHOLD'],
    segmentWaitTimeoutSec: env['SEGMENT_WAIT_TIMEOUT_SEC'],
    torrentLingerSec: env['TORRENT_LINGER_SEC'],
    minFreeDiskMiB: env['MIN_FREE_DISK_MIB'],
    torrent: {
      port: env['TORRENT_PORT'],
      dht: env['TORRENT_DHT'],
      trackers: env['TORRENT_TRACKERS'],
      webSeeds: env['TORRENT_WEB_SEEDS'],
      allowPrivatePeers: env['TORRENT_ALLOW_PRIVATE_PEERS'],
      maxConns: env['TORRENT_MAX_CONNS'],
      uploadLimitKiBps: env['TORRENT_UPLOAD_LIMIT_KIBPS'],
    },
  });
  return {
    ...parsed,
    streamTokenSecret: parsed.streamTokenSecret ?? randomBytes(32).toString('base64url'),
    ...overrides,
  };
}
