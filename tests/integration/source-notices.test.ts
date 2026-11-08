import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { now, type Decision, type Project } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { publicError } from '../../src/readiness.js';
import { Store } from '../../src/store.js';

it('explains a superseded citation and a withdrawal in the task page', async () => {
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/product/PRD.md', allowedPaths: ['docs/product/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: config.ownerId, autoMerge: false, budgetUsd: 0, createdAt: now() };
  config.projects = [project];
  const store = new Store(':memory:');
  store.save('projects', project);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('unused'); } }, research: { research: async () => { throw Error('unused'); } } });
  const app = createApp({ store, config, engine });
  try {
    engine.ingest({ projectId: 'p', kind: 'reading', purpose: 'reference', externalId: 'evidence', revision: 'r1', title: '用户证据', content: '有人希望失败后保留七天。' });
    const evidence = store.list('sources').find(source => source.externalId === 'evidence')!;
    const open = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'idea', title: '草稿', content: '导出失败后如何处理草稿。' })!;
    const delivered = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'done', title: '已交付', content: '另一份已经交付的草稿。' })!;
    const decision: Decision = { action: 'proceed', summary: '先按这份证据处理。', rationale: '证据仍在。', citations: [{ sourceId: evidence.id, revision: evidence.revision, quote: evidence.content, locator: evidence.locator }], ruleIds: [] };
    store.save('tasks', { ...open, stage: 'plan', status: 'planning', decision });
    store.save('tasks', { ...delivered, stage: 'feedback', status: 'feedback', receiptId: 'receipt-done', decision });
    engine.ingest({ projectId: 'p', kind: 'reading', purpose: 'reference', externalId: 'evidence', revision: 'r2', title: '用户证据', content: '后来的证据改成保留到下次成功导出。' });
    expect(store.get('tasks', open.id)).toMatchObject({ status: 'deciding', stage: 'decide', version: open.version + 1, error: 'source_superseded' });
    expect(store.get('tasks', delivered.id)).toMatchObject({ status: 'cancelled', version: delivered.version, receiptId: 'receipt-done', error: 'delivery_kept' });
    const openPage = await (await app.request(`/tasks/${open.id}?project=p`)).text();
    expect(openPage).toContain(publicError('source_superseded'));
    expect(openPage).not.toContain('运行暂时不可用');
    const keptPage = await (await app.request(`/tasks/${delivered.id}?project=p`)).text();
    expect(keptPage).toContain('已经交付的结果仍保留');
    engine.withdraw(open.sourceId);
    expect(store.get('tasks', open.id)?.error).toBe('evidence_withdrawn');
    const withdrawn = await (await app.request(`/tasks/${open.id}?project=p`)).text();
    expect(withdrawn).toContain('可读内容已收回');
    expect(store.list('events').some(event => event.message === '证据已收回。')).toBe(true);
  } finally {
    await engine.shutdown();
    store.close();
  }
});
