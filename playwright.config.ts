import { defineConfig } from '@playwright/test';
import renderLock from './apps/web/rendering.lock.json' with { type: 'json' };

const baseURL = 'http://127.0.0.1:4179';

export default defineConfig({
  testDir: './apps/web/tests/browser',
  testMatch: '**/*.pw.ts',
  use: {
    baseURL,
    locale: 'en-US',
    timezoneId: renderLock.rendering.timezone,
    colorScheme: renderLock.rendering.colorScheme as 'light',
    reducedMotion: renderLock.rendering.reducedMotion as 'reduce',
    deviceScaleFactor: renderLock.deviceScaleFactor,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-desktop', use: { browserName: 'chromium', viewport: renderLock.viewports.desktop } },
    { name: 'chromium-mobile', use: { browserName: 'chromium', viewport: renderLock.viewports.mobile, hasTouch: true, isMobile: true } },
  ],
  webServer: {
    command: 'npm run dev:demo -w @patrick/web -- --host 127.0.0.1 --port 4179 --strictPort',
    url: baseURL,
  },
});
