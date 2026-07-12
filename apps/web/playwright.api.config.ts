import { defineConfig, devices } from '@playwright/test';

/**
 * API-backed acceptance config (Phase 0 Task 8) — the demo config's opposite:
 * the app runs in API MODE (VITE_API_URL set) against a real NestJS server on a
 * real PostgreSQL seeded with the deterministic two-project fixture. Launch via
 * `pnpm test:e2e:api` (scripts/test-api-e2e.sh), which migrates + seeds first
 * and refuses to run without an explicit disposable DATABASE_URL.
 *
 * Serial by design: the scenarios exercise auth, live project switches and a
 * membership revocation against ONE shared database — parallel workers would
 * race the fixture.
 */
const executablePath = process.env.PW_CHROMIUM;

export default defineConfig({
  testDir: './tests/e2e-api',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: [
    {
      // the real API as the COMPILED artifact (scripts/test-api-e2e.sh builds it
      // first) — the same `node dist/main.js` that production runs, with dev auth
      // OFF so the suite exercises the secure default. The tsx watch loader can't
      // emit Nest's decorator metadata reliably, and an acceptance gate should
      // prove the shipped artifact anyway.
      command: 'node ../api/dist/main.js',
      url: 'http://localhost:3000/health',
      reuseExistingServer: false,
      timeout: 90_000,
      env: { ...process.env, PORT: '3000' },
    },
    {
      // the web app in API mode, pointed at the server above (invoke vite
      // directly: `pnpm dev -- --port` forwards the literal `--` and vite
      // silently ignores the port flags)
      command: 'pnpm exec vite --port 4174 --strictPort',
      url: 'http://localhost:4174',
      reuseExistingServer: false,
      timeout: 90_000,
      env: { ...process.env, VITE_API_URL: 'http://localhost:3000' },
    },
  ],
});
