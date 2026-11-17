import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };

export default defineConfig({
  testDir: '.',
  testMatch: 'T15.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://localhost',
    locale: 'zh-CN',
    timezoneId: rendering.rendering.timezone,
    viewport: rendering.viewports.desktop,
    browserName: 'chromium',
    launchOptions: { args: ['--host-resolver-rules=MAP localhost 127.0.0.1:4185'] },
  },
  webServer: {
    command: 'PATRICK_LOCAL_SERVICE=http://127.0.0.1:43155 npm run dev -w @patrick/web -- --host 127.0.0.1 --port 4185 --strictPort',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4185',
    reuseExistingServer: false,
  },
});
