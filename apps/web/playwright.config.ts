import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config. Browser resolution (TEST-01, portable by default):
 *   • CI / a normal checkout: Playwright's own managed browser install
 *     (`npx playwright install chromium`) — no configuration needed;
 *   • a sandbox with a preinstalled Chromium: point PW_CHROMIUM at the binary
 *     (e.g. PW_CHROMIUM=/opt/pw-browsers/chromium) to skip the download.
 * The dev server is launched automatically for the run.
 */
const executablePath = process.env.PW_CHROMIUM;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'off',
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
  webServer: {
    command: 'npx vite --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
