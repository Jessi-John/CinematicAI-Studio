import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: { mode: 'only-on-failure', fullPage: true },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // webServer omitted: the dockerized frontend at localhost:3000 is already running.
  // If Playwright's webServer config is set to start `npm run dev`, it conflicts
  // with the dockerized frontend on port 3000 and causes 10s polling hangs.
  // Run `npm run dev` manually (or use docker compose up) before running tests.
  // Full 10-episode generation with live MiniMax API takes 40+ minutes.
  // Global timeout must exceed this. Only use for full generation validation, not CI smoke tests.
  timeout: 30000, // 30 second default; individual tests use test.setTimeout() for longer runs
});