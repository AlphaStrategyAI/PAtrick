import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createRuntime } from '../../src/runtime.js';

it('shows this week’s unasked host judgment without calling it the owner’s decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-unasked-'));
  const runtime = await createRuntime(readConfig({ PATRICK_MODE: 'demo', PATRICK_HOST: '127.0.0.1', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' }));
  const app = createApp(runtime);
  try {
    const html = await (await app.request('/')).text();
    expect(html).toContain('本周没有向你提问');
    expect(html).toContain('不是你的决定');
    expect(html).not.toContain('当时，你的决定');
  } finally { await runtime.close(); }
});
