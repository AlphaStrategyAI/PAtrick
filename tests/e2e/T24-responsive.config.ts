import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };

export default defineConfig({
  testDir: '.', testMatch: 'T24-responsive.spec.ts', workers: 1, timeout: 45_000,
  use: {
    baseURL: 'http://localhost', browserName: 'chromium', viewport: rendering.viewports.desktop,
    timezoneId: rendering.rendering.timezone,
    colorScheme: 'light', reducedMotion: 'reduce', actionTimeout: 6000,
    launchOptions: { args: ['--host-resolver-rules=MAP localhost 127.0.0.1:4198'] },
  },
  webServer: {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    command: 'npm run dev -w @patrick/web -- --host 127.0.0.1 --port 4198 --strictPort',
    url: 'http://127.0.0.1:4198', reuseExistingServer: false,
  },
});
