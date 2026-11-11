import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources.
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'development|production'] } },
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
