import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { configureDemo } from '../../src/demo.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

it('renders uncovered channels on the sources page without forward, tag, or export actions', async () => {
  const config = readConfig({ PATRICK_MODE: 'demo', PATRICK_HOST: '127.0.0.1', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  configureDemo(config);
  const store = new Store(':memory:');
  store.save('projects', { ...config.projects[0]!, ownerId: config.ownerId });
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  const app = createApp({ store, config, engine });
  try {
    const response = await app.request('/sources');
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const name of ['公众号', '个人微信', '第三方 Grok']) expect(html).toContain(name);
    expect(html).toContain('未覆盖');
    expect(html).toContain('不增加转发、贴标签或导出');
    expect(html).not.toContain('>转发<');
    expect(html).not.toContain('>贴标签<');
    expect(html).not.toContain('>导出<');
  } finally { await engine.shutdown(); store.close(); }
});
