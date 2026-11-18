import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };

const cwd = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  // The Vite proxy can deliver idle SSE headers with the service's first 15-second heartbeat.
  timeout: 60_000, expect: { timeout: 22_000 },
  testDir: '.', testMatch: 'T24.a11y.spec.ts', workers: 1,
  use: {
    baseURL: 'http://localhost', locale: 'en-US', viewport: rendering.viewports.desktop,
    timezoneId: rendering.rendering.timezone, deviceScaleFactor: rendering.deviceScaleFactor,
    colorScheme: 'light', reducedMotion: 'no-preference', browserName: 'chromium',
    launchOptions: { args: ['--host-resolver-rules=MAP localhost 127.0.0.1:4194'] },
    video: 'on',
  },
  webServer: [
    { cwd, command: 'PATRICK_LOCAL_SERVICE=http://127.0.0.1:43155 npm run dev -w @patrick/web -- --host 127.0.0.1 --port 4194 --strictPort',
      url: 'http://127.0.0.1:4194' },
    { cwd, command: 'npm run dev:demo -w @patrick/web -- --host 127.0.0.1 --port 4195 --strictPort',
      url: 'http://127.0.0.1:4195' },
  ],
});
