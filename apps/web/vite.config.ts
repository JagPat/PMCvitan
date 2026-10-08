import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { buildInfo } from '../../scripts/build-info.mjs';

// Deploy visibility (owner direction 2026-10-08): the commit and build time, stamped at BUILD time from
// Coolify's SOURCE_COMMIT build argument ("unknown" without it). The bundle shows the short SHA, and
// the build emits the same object as /version.json. Only a hex SHA and a timestamp are ever written.
const BUILD = buildInfo();

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'vitan-version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify(BUILD)}\n` });
      },
    },
  ],
  define: { __BUILD_INFO__: JSON.stringify(BUILD) },
  resolve: {
    alias: {
      '@vitan/shared': fileURLToPath(new URL('../../packages/shared/src', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    // Playwright specs live under tests/e2e (demo) and tests/e2e-api (API-backed
    // acceptance) and must not be collected by Vitest.
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests/e2e/**', '**/tests/e2e-api/**'],
  },
});
