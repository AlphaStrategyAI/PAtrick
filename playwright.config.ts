import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4318', trace: 'retain-on-failure', screenshot: 'only-on-failure', reducedMotion: 'reduce' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run demo',
    url: 'http://127.0.0.1:4318',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PATRICK_MODE: 'demo', PATRICK_HOST: '127.0.0.1', PATRICK_PORT: '4318', PATRICK_DATA_DIR: `/tmp/patrick-e2e-${process.pid}` },
  },
});
