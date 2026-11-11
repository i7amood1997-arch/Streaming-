import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadApiConfig } from '../config.js';
import { createDatabase } from './client.js';
import type { DatabaseHandle } from './client.js';

/** Generated SQL migrations live in apps/api/drizzle (same path from src/ and dist/). */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

/** Applies pending migrations inside drizzle's advisory-locked transaction. */
export async function runMigrations(handle: DatabaseHandle): Promise<void> {
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadApiConfig();
  const handle = createDatabase(config.databaseUrl, { poolMax: 1 });
  try {
    await runMigrations(handle);
    process.stdout.write('Migrations applied\n');
  } finally {
    await handle.close();
  }
}
