import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}/tracer/`,
    trace: 'retain-on-failure',
    // Tests load the network as a first visit would. pwa.spec.ts turns the service worker on.
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The build counts against the start timeout, and on a loaded machine it alone passes the
    // default minute. scripts/e2e-build.js swaps a finished build into dist/ only when complete.
    command: `node scripts/e2e-build.js && pnpm preview --port ${port} --strictPort`,
    timeout: 5 * 60_000,
    url: `http://localhost:${port}/tracer/`,
    reuseExistingServer: !process.env.CI,
  },
});
