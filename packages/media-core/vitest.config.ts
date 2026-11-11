import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources (no build step in dev/test).
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'development|production'] } },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
