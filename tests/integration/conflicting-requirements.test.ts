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

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'conflict-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: new Date().toISOString() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [{ runner: 'grok', roles: ['knowledge_extract', 'case_extract', 'decide', 'plan', 'execute'], domains: ['personal'], provider: 'fixture', model: 'fixture', admitted: true, costPerRunUsd: 0.01, independentReview: false }] };
  const worker: WorkerAdapter = { name: 'grok', async run(input: WorkerInput) {
    const citation = { sourceId: input.source.id, revision: input.source.revision, quote: input.source.content, locator: input.source.locator };
    if (input.role === 'knowledge_extract') return { output: { cards: [] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role === 'case_extract') return { output: { observations: [] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role === 'decide') return { output: { action: 'proceed', summary: '按资料直接改。', rationale: '模型没有停下来问。', citations: [citation], ruleIds: [], grounds: { statements: [{ citation, purpose: 'requirement', binding: 'task-request' }], facts: [], unresolved: [] } }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role === 'plan') return { output: { taskVersion: input.task.version, sourceRevision: input.task.sourceRevision, baselineSha: 'baseline', summary: 'Plan', paths: ['docs/PRD.md'], steps: ['Update'], tests: ['test'], stopConditions: ['Stop'] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    return { output: { taskVersion: input.task.version, planHash: 'unused', baselineSha: 'baseline', files: [{ path: 'docs/PRD.md', content: 'changed' }], tests: [{ command: 'test', passed: true, output: 'ok' }], summary: 'changed' }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
  } };
  const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  return { store, config, engine };
}

it('does not execute a source that both deletes and keeps the draft', async () => {
  const f = setup();
  const task = f.engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'conflict', title: '草稿期限', content: '评审同时要求导出失败即删草稿，以及保留七天。' })!;
  try {
    await f.engine.runUntilIdle();
    const saved = f.store.get('tasks', task.id)!;
    expect(saved).toMatchObject({ status: 'blocked', stage: 'decide', error: 'conflicting_requirements' });
    expect(saved.plan).toBeUndefined();
    expect(f.store.list('receipts')).toEqual([]);
    const page = await (await createApp({ store: f.store, config: f.config, engine: f.engine }).request(`/tasks/${task.id}?project=p`)).text();
    expect(page).toContain(publicError('conflicting_requirements'));
  } finally { await f.engine.shutdown(); }
});

it('still plans a source that only asks to keep the draft', async () => {
  const f = setup();
  const task = f.engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'keep', title: '草稿', content: '导出失败后保留草稿，以供恢复。' })!;
  try {
    for (let i = 0; i < 6 && f.store.get('tasks', task.id)?.stage !== 'execute'; i++) await f.engine.tick();
    expect(f.store.get('tasks', task.id)).toMatchObject({ stage: 'execute', decision: { action: 'proceed' } });
  } finally { await f.engine.shutdown(); }
});
