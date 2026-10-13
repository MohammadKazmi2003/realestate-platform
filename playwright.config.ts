import { defineConfig } from '@playwright/test';

/**
 * Playwright Test configuration.
 *
 * workers: '50%' — half of available CPU cores (this machine has 8 → 4 workers).
 * Parallelism is capped by browser instances, not test count; 4 workers keeps
 * the CI/dev host responsive while still running spec files concurrently.
 */
export default defineConfig({
  testDir: './specs',
  workers: '50%',
  fullyParallel: true,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
  },
});
