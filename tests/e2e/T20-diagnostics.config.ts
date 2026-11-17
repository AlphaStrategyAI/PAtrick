import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };

export default defineConfig({
  testDir: '.',
  testMatch: 'T20-diagnostics.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://localhost',
    locale: 'en-US',
    viewport: rendering.viewports.desktop,
    browserName: 'chromium',
    launchOptions: { args: ['--host-resolver-rules=MAP localhost 127.0.0.1:4192'] },
  },
  webServer: {
    command: 'npm run dev -w @patrick/web -- --host 127.0.0.1 --port 4192 --strictPort',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4192',
    reuseExistingServer: false,
  },
});
