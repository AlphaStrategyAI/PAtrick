import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { now, type Project } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

it('revises one manual idea once and keeps the current task when the text is unchanged', async () => {
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/product/PRD.md', allowedPaths: ['docs/product/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: config.ownerId, autoMerge: true, budgetUsd: 0, createdAt: now(), executionRunner: 'grok', reviewIntervalDays: 7 };
  config.projects = [project];
  const store = new Store(':memory:');
  store.save('projects', project);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  const app = createApp({ store, config, engine });
  const post = (body: Record<string, string>) => app.request('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ projectId: project.id, kind: 'manual', ...body }) });
  try {
    const created = await (await post({ title: '草稿', content: '导出失败后保留草稿。' })).json() as { task: { id: string } };
    engine.ingest({ projectId: project.id, kind: 'reading', purpose: 'reference', externalId: 'research:https://example.com/draft', title: '草稿说明', content: '一手摘录', authorId: project.ownerId });
    const page = await (await app.request('/sources?project=p')).text();
    expect(page.match(/修改这份想法/g)).toHaveLength(1);
    expect(page).toContain('导出失败后保留草稿。');
    const source = store.list('sources').find(item => item.id === store.get('tasks', created.task.id)?.sourceId)!;
    const revised = await (await post({ title: '草稿', content: '导出失败后保留草稿七天。', externalId: source.externalId })).json() as { task: { id: string }; message: string };
    expect(revised.message).toBe('已按新材料处理一次。');
    expect(revised.task.id).not.toBe(created.task.id);
    const openManual = () => {
      const ids = new Set(store.list('sources').filter(item => item.kind === 'manual').map(item => item.id));
      return store.list('tasks').filter(item => ids.has(item.sourceId) && item.status !== 'cancelled');
    };
    expect(store.get('tasks', created.task.id)?.status).toBe('cancelled');
    expect(store.list('sources').filter(item => item.kind === 'manual' && item.status === 'active')).toHaveLength(1);
    expect(openManual()).toHaveLength(1);
    const same = await (await post({ title: '草稿', content: '导出失败后保留草稿七天。', externalId: source.externalId })).json() as { task: { id: string }; unchanged: boolean };
    expect(same).toMatchObject({ unchanged: true, task: { id: revised.task.id } });
    expect(openManual()).toHaveLength(1);
    const restored = await (await post({ title: '草稿', content: '导出失败后保留草稿。', externalId: source.externalId })).json() as { task: { id: string } };
    expect(restored.task.id).not.toBe(revised.task.id);
    expect(store.get('tasks', revised.task.id)?.status).toBe('cancelled');
    expect(store.list('sources').filter(item => item.kind === 'manual' && item.status === 'active')).toHaveLength(1);
    expect(openManual()).toHaveLength(1);
  } finally {
    await engine.shutdown();
    store.close();
  }
});
