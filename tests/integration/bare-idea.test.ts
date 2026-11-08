import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppConfig, Project, WorkerAdapter, WorkerInput } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function setup(binding: 'source-statement' | 'task-request') {
  const root = mkdtempSync(join(tmpdir(), 'bare-idea-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: new Date().toISOString() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [{ runner: 'grok', roles: ['knowledge_extract', 'case_extract', 'decide', 'plan'], domains: ['personal'], provider: 'fixture', model: 'fixture', admitted: true, costPerRunUsd: 0.01, independentReview: false }] };
  const worker: WorkerAdapter = { name: 'grok', async run(input: WorkerInput) {
    const citation = { sourceId: input.source.id, revision: input.source.revision, quote: input.source.content, locator: input.source.locator };
    if (input.role === 'knowledge_extract') return { output: { cards: [] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role === 'case_extract') return { output: { observations: [] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role === 'decide') return { output: { action: 'proceed', summary: '按这个想法改产品。', rationale: '模型把想法当成了执行要求。', citations: [citation], ruleIds: [], grounds: { statements: [{ citation, purpose: binding === 'task-request' ? 'requirement' : 'author-statement', binding }], facts: [], unresolved: [] } }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    return { output: { taskVersion: input.task.version, sourceRevision: input.task.sourceRevision, baselineSha: 'baseline', summary: 'Plan', paths: ['docs/PRD.md'], steps: ['Update'], tests: ['test'], stopConditions: ['Stop'] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
  } };
  const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  return { store, config, engine, project };
}

it('archives a bare idea instead of executing it', async () => {
  const f = setup('source-statement');
  const task = f.engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'idea', title: '首次引导', content: '想法：第一次打开时给一个可跳过的引导。' })!;
  try {
    await f.engine.runUntilIdle();
    const saved = f.store.get('tasks', task.id)!;
    expect(saved).toMatchObject({ status: 'archived', stage: 'decide' });
    expect(saved.decision).toMatchObject({ action: 'archive', summary: '这是待验证假设。还没有用户或竞品证据，先保留原文。' });
    expect(saved.plan).toBeUndefined();
    expect(f.store.list('receipts')).toEqual([]);
    expect(f.store.list('events').some(event => event.taskId === task.id && event.message === saved.decision?.summary)).toBe(true);
    const page = await (await createApp({ store: f.store, config: f.config, engine: f.engine }).request('/?project=p')).text();
    expect(page).toContain('这是待验证假设');
    expect(page).toContain('作为待验证想法保留');
  } finally { await f.engine.shutdown(); }
});

it('still plans a requirement stated by the current source', async () => {
  const f = setup('task-request');
  const task = f.engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'report', title: '草稿', content: '用户报告：导出失败后草稿消失。' })!;
  try {
    for (let i = 0; i < 6 && f.store.get('tasks', task.id)?.stage !== 'execute'; i++) await f.engine.tick();
    expect(f.store.get('tasks', task.id)?.stage).toBe('execute');
    expect(f.store.get('tasks', task.id)?.decision).toMatchObject({ action: 'proceed', summary: '按这个想法改产品。' });
  } finally { await f.engine.shutdown(); }
});
