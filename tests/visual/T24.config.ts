import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };

export default defineConfig({
  testDir: '.',
  testMatch: ['T24.spec.ts', 'T24-edit.spec.ts', 'T24-feishu.spec.ts', 'T24-baseline.spec.ts', 'T24-settings-index.spec.ts', 'T24-zh-reference.spec.ts'],
  workers: 1, timeout: 60_000,
  use: {
    actionTimeout: 8000, navigationTimeout: 15000, baseURL: 'http://localhost', browserName: 'chromium', viewport: rendering.viewports.desktop,
    deviceScaleFactor: rendering.deviceScaleFactor, timezoneId: rendering.rendering.timezone,
    colorScheme: 'light', reducedMotion: 'reduce',
    launchOptions: { args: ['--host-resolver-rules=MAP localhost 127.0.0.1:4196'] },
  },
  webServer: {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    command: 'npm run dev -w @patrick/web -- --host 127.0.0.1 --port 4196 --strictPort',
    url: 'http://127.0.0.1:4196', reuseExistingServer: false,
  },
});
