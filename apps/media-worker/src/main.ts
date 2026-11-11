import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

// Optional .env: package directory first, then the repository root.
// Variables already set in the environment take precedence.
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [path.join(packageDir, '.env'), path.resolve(packageDir, '../../.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const config = loadConfig();
const bootstrapPeers = (process.env['TORRENT_BOOTSTRAP_PEERS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = await createApp(config, { bootstrapPeers, logger: true });
await app.server.listen({ host: config.host, port: config.port });

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.server.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.server.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
