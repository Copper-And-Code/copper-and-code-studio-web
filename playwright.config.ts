import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  // Three browsers at once on one PC compete for the CPU and distort the start-up time measured.
  workers: process.env.CI ? undefined : 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/lvgl-mpy-studio-web/`,
    trace: 'retain-on-failure',
    // the IDE takes its language from the browser: the tests read it in English (language.spec.ts
    // switches it)
    locale: 'en-US',
    // The site's service worker caches the whole site (23 MB) for offline use: in every new
    // context of every test it would download it again. Only the tests about it allow it
    // (pwa.spec.ts, and web.spec.ts for the web versions' own worker).
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/lvgl-mpy-studio-web/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
