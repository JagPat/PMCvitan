import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
