import { defineConfig } from 'drizzle-kit';

// Only used by `pnpm db:generate` (diffs src/db/schema.ts into SQL migrations).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
});
