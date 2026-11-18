import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: 'T25-directory-block.spec.ts', workers: 1,
  use: { baseURL: 'http://localhost', locale: 'en-US', browserName: 'chromium',
    launchOptions: { args: ['--host-resolver-rules=MAP localhost 127.0.0.1:44182'] } },
  webServer: {
    command: 'npm run dev -w @patrick/web -- --host 127.0.0.1 --port 44182 --strictPort',
    cwd: fileURLToPath(new URL('../..', import.meta.url)), url: 'http://127.0.0.1:44182', reuseExistingServer: false,
  },
});
