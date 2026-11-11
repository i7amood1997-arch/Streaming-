import { z } from 'zod';

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(0).max(65535).default(3000),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** postgres://user:password@host:port/db */
  databaseUrl: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  databasePoolMax: z.coerce.number().int().min(1).max(100).default(10),
  /** redis://[:password@]host:port[/db] */
  redisUrl: z.string().regex(/^rediss?:\/\//, 'must be a redis:// URL'),
  allowedOrigins: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** Per-dependency timeout for /readyz. */
  readinessTimeoutMs: z.coerce.number().int().min(100).max(10_000).default(1500),
  /** Run pending database migrations at startup (single-instance/dev setups). */
  migrateOnStart: z.stringbool().default(false),
});

export type ApiConfig = z.infer<typeof ConfigSchema>;

export function loadApiConfig(rawEnv: NodeJS.ProcessEnv = process.env): ApiConfig {
  // `KEY=` in an env file means "unset".
  const env = Object.fromEntries(
    Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ''),
  );
  return ConfigSchema.parse({
    nodeEnv: env['NODE_ENV'],
    host: env['API_HOST'],
    port: env['API_PORT'],
    logLevel: env['LOG_LEVEL'],
    databaseUrl: env['DATABASE_URL'],
    databasePoolMax: env['DATABASE_POOL_MAX'],
    redisUrl: env['REDIS_URL'],
    allowedOrigins: env['ALLOWED_ORIGINS'],
    readinessTimeoutMs: env['READINESS_TIMEOUT_MS'],
    migrateOnStart: env['MIGRATE_ON_START'],
  });
}
