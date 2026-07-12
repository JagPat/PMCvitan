import { defineConfig } from 'vitest/config';

// Integration suite: a REAL Nest application over a REAL PostgreSQL database
// (DATABASE_URL must point at a disposable test DB with migrations applied).
// Serial on purpose — the suites share one database.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
