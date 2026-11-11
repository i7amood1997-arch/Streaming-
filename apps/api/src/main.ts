import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi } from './app.js';
import { loadApiConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createRedis } from './redis.js';

// Optional .env: package directory first, then the repository root.
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [path.join(packageDir, '.env'), path.resolve(packageDir, '../../.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const config = loadApiConfig();
const database = createDatabase(config.databaseUrl, { poolMax: config.databasePoolMax });
if (config.migrateOnStart) await runMigrations(database);

let lastRedisError = '';
const redis = createRedis(config.redisUrl, (err) => {
  // Reconnect loops would otherwise log every attempt.
  if (err.message !== lastRedisError) app.log.warn({ err }, 'redis error');
  lastRedisError = err.message;
});

const app = await buildApi({
  config,
  probes: { database: database.ping, redis: redis.ping },
});
await app.listen({ host: config.host, port: config.port });

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    Promise.allSettled([app.close(), database.close(), redis.close()]).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
