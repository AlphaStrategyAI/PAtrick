import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { now, type Project } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

it('shows a delivery note on the original task without calling it a Feishu send', async () => {
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: config.ownerId, autoMerge: false, budgetUsd: 1, createdAt: now() };
  config.projects = [project];
  const store = new Store(':memory:');
  store.save('projects', project);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('unused'); } }, research: { research: async () => { throw Error('unused'); } } });
  const app = createApp({ store, config, engine });
  try {
    const task = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'idea', title: '草稿恢复', content: '导出失败后保留草稿。' })!;
    const at = now();
    store.save('outbox', { id: 'local-delivery', projectId: 'p', domain: 'personal', taskId: task.id, channel: 'origin', recipient: project.ownerId, text: '草稿恢复 已交付：https://example.com/pull/1\n合并后的反馈已记下。', status: 'pending', attempts: 0, runAfter: at, createdAt: at });
    store.save('outbox', { id: 'feishu-switch', projectId: 'p', domain: 'personal', taskId: task.id, channel: 'feishu', recipient: 'owner-open', text: '草稿恢复：整理证据从 grok 换到 dsh。原因：原来的运行器暂时不可用。已继续原任务。', status: 'pending', attempts: 0, runAfter: at, createdAt: at });
    const page = await (await app.request(`/tasks/${task.id}?project=p`)).text();
    expect(page).toContain('记回这件任务');
    expect(page).toContain('合并后的反馈已记下。');
    expect(page).toContain('等待发到飞书');
    expect(page).toContain('已继续原任务');
    expect(page).not.toContain('已发到飞书');
    expect(store.get('outbox', 'local-delivery')?.status).toBe('pending');
  } finally {
    await engine.shutdown();
    store.close();
  }
});
