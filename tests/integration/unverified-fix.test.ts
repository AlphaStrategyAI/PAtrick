import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppConfig, Project, WorkerAdapter, WorkerInput } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { publicError } from '../../src/readiness.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function setup(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'fix-claim-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: new Date().toISOString() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [{ runner: 'grok', roles: ['knowledge_extract', 'case_extract', 'decide', 'plan', 'execute'], domains: ['personal'], provider: 'fixture', model: 'fixture', admitted: true, costPerRunUsd: 0.01, independentReview: false }] };
  const worker: WorkerAdapter = { name: 'grok', async run(input: WorkerInput) {
    const citation = { sourceId: input.source.id, revision: input.source.revision, quote: input.source.content, locator: input.source.locator };
    if (input.role === 'knowledge_extract') return { output: { cards: [{ title: '导出修复', body: '助手报告已经处理好。', quote: input.source.content, aliases: ['修好了'], verification: 'reported', kind: 'fact' }] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role === 'case_extract') return { output: { observations: [] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role === 'decide') return { output: { action: 'proceed', summary: '按助手的结论改。', rationale: '助手说已经修好。', citations: [citation], ruleIds: [], grounds: { statements: [{ citation, purpose: 'requirement', binding: 'task-request' }], facts: [], unresolved: [] } }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role === 'plan') return { output: { taskVersion: input.task.version, sourceRevision: input.task.sourceRevision, baselineSha: 'baseline', summary: 'Plan', paths: ['docs/PRD.md'], steps: ['Update'], tests: ['test'], stopConditions: ['Stop'] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    return { output: { taskVersion: input.task.version, planHash: 'unused', baselineSha: 'baseline', files: [{ path: 'docs/PRD.md', content: 'changed' }], tests: [{ command: 'test', passed: true, output: 'ok' }], summary: 'changed' }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
  } };
  const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  const task = engine.ingest({ projectId: 'p', kind: 'conversation', externalId: 'codex:session:turn', title: '导出修复', content, authorId: 'tool:codex' })!;
  return { store, config, engine, task };
}

it('does not execute an assistant claim that the problem is fixed', async () => {
  const f = setup('助手：导出失败的问题修好了。');
  try {
    await f.engine.runUntilIdle();
    expect(f.store.get('tasks', f.task.id)).toMatchObject({ status: 'blocked', stage: 'decide', error: 'unverified_fix' });
    expect(f.store.get('tasks', f.task.id)?.plan).toBeUndefined();
    const app = createApp({ store: f.store, config: f.config, engine: f.engine });
    expect(await (await app.request(`/tasks/${f.task.id}?project=p`)).text()).toContain(publicError('unverified_fix'));
    expect(await (await app.request('/knowledge?project=p')).text()).toContain('这是待核经验');
  } finally { await f.engine.shutdown(); }
});

it('still plans a source that does not claim the problem is already fixed', async () => {
  const f = setup('用户报告：导出失败后草稿消失。');
  try {
    for (let i = 0; i < 6 && f.store.get('tasks', f.task.id)?.stage !== 'execute'; i++) await f.engine.tick();
    expect(f.store.get('tasks', f.task.id)).toMatchObject({ stage: 'execute', decision: { action: 'proceed' } });
  } finally { await f.engine.shutdown(); }
});
