import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

export function createDatabase(url: string, opts: { poolMax: number }): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.poolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: 'streaming-api',
  });
  // Idle client errors (e.g. server restart) must not crash the process;
  // the pool discards the client and readiness reports the outage.
  pool.on('error', () => undefined);
  return {
    db: drizzle(pool, { schema }),
    pool,
    ping: async () => {
      await pool.query('SELECT 1');
    },
    close: () => pool.end(),
  };
}
