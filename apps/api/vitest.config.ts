import { defineConfig } from 'vitest/config';

// Unit suite: src-only. The PostgreSQL-backed integration suite lives under
// test/integration and runs separately via vitest.integration.config.ts
// (pnpm test:integration) against a real database.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
