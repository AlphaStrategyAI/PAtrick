import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import rendering from '../../apps/web/rendering.lock.json' with { type: 'json' };
import { overviewProxyTarget } from '../visual/T24-baseline-fixture.js';

const serviceTarget = await overviewProxyTarget();

export default defineConfig({
  testDir: '.',
  testMatch: 'T17.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://localhost',
    locale: 'en-US',
    timezoneId: rendering.rendering.timezone,
    viewport: rendering.viewports.desktop,
    browserName: 'chromium',
    launchOptions: { args: ['--host-resolver-rules=MAP localhost 127.0.0.1:4187'] },
  },
  webServer: {
    env: { PATRICK_LOCAL_SERVICE: serviceTarget },
    command: 'npm run dev -w @patrick/web -- --host 127.0.0.1 --port 4187 --strictPort',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
  },
});
