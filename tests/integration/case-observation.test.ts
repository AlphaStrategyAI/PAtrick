import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { now, type AppConfig, type DecisionCase, type Project, type SourceRevision, type Task, type WorkerAdapter, type WorkerInput } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { applicableRules } from '../../src/standards.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const kept = '仅本产品保留到下次成功导出';
const opposed = '失败后仍要保留记录';

function harness(run: WorkerAdapter['run']) {
  const root = mkdtempSync(join(tmpdir(), 'case-observation-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: now() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [{ runner: 'grok', roles: ['case_extract'], domains: ['personal'], provider: 'fixture', model: 'fixture', admitted: true, costPerRunUsd: 0.01, independentReview: false }] };
  const source = (id: string, content: string): SourceRevision => ({ id, projectId: 'p', domain: 'personal', kind: 'conversation', externalId: id, revision: id, title: id, content, locator: id, authorId: 'owner', retention: 'permanent', status: 'active', createdAt: '2026-11-01T00:00:00.000Z' });
  store.save('sources', source('keep-source', kept));
  store.save('sources', source('mirror-source', kept));
  store.save('sources', source('oppose-source', opposed));
  const task: Task = { id: 'task', projectId: 'p', domain: 'personal', sourceId: 'keep-source', sourceRevision: 'keep-source', title: '草稿', description: kept, status: 'delivered', version: 1, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', runAfter: '2026-11-01T00:00:00.000Z', attempts: 1, repairCount: 0, budgetUsd: 1, spentUsd: 0, stage: 'feedback' };
  store.save('tasks', task);
  const decision = (id: string, sourceId: string, words: string, createdAt: string): DecisionCase => ({ id, projectId: 'p', domain: 'personal', taskId: task.id, questionId: id, decisionId: id, actorId: 'owner', choice: 'C', originalWords: words, rationale: '当时的原话', alternatives: [], ruleIds: [], sourceId, status: 'active', createdAt });
  store.save('cases', decision('keep', 'keep-source', kept, '2026-11-02T00:00:00.000Z'));
  store.save('cases', decision('mirror', 'mirror-source', kept, '2026-11-03T00:00:00.000Z'));
  store.save('cases', decision('oppose', 'oppose-source', opposed, '2026-11-04T00:00:00.000Z'));
  const worker: WorkerAdapter = { name: 'grok', run };
  const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  return { store, config, engine };
}

it('records one observation from a new case and its mirror, including an opposing case', async () => {
  const seen: string[][] = [];
  let title = '两次都提到保留';
  const { store, config, engine } = harness(async (input: WorkerInput) => {
    seen.push(input.caseBatch?.cases.map(item => item.id) ?? []);
    return { output: { caseObservations: [{ title, statement: '这些案例都在讨论保留。', quote: '保留', conditions: '本产品的导出失败', exceptions: '不是本人的原则', supports: ['keep'], opposes: ['oppose'] }] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
  });
  await engine.tick();
  expect(seen).toEqual([['keep', 'oppose']]);
  const rules = store.list('rules');
  expect(rules.map(rule => rule.kind)).toEqual(['observation']);
  expect(rules[0]?.caseIds).toEqual(['keep', 'oppose']);
  expect(applicableRules(store, store.get('tasks', 'task')!, config)).toEqual([]);
  expect(store.list('events').some(event => event.message === '从本域案例记下一条观察。它不是你的原则。')).toBe(true);
  const page = await (await createApp({ store, config, engine }).request('/standards?project=p&kind=observation')).text();
  expect(page).toContain('支持 1 个原始案例，反对 1 个。这是观察，不是原则。');
  await engine.tick();
  expect(seen).toHaveLength(1);
  title = '结果记下之后的观察';
  store.save('cases', { ...store.get('cases', 'keep')!, outcome: '草稿找回了。' });
  await engine.tick();
  expect(seen).toHaveLength(2);
  expect(store.list('rules').filter(rule => rule.kind === 'principle')).toEqual([]);
  expect(store.list('rules')).toHaveLength(2);
});

it('does not keep an observation whose quotation is absent from the cited case', async () => {
  const { store, engine } = harness(async () => ({ output: { caseObservations: [{ title: '没有原文', statement: '这句不在案例里。', quote: '这句话没有出现', conditions: '本产品', exceptions: '不是原则', supports: ['keep'], opposes: [] }] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' }));
  await engine.tick();
  expect(store.list('rules')).toEqual([]);
  await engine.tick();
  expect(store.list('actions').some(action => action.kind === 'decision.case-observation-batch' && action.status === 'completed')).toBe(true);
});

it('waits before asking again when the idle extraction fails', async () => {
  let calls = 0;
  const { engine } = harness(async () => { calls += 1; throw new Error('worker down'); });
  await engine.tick();
  await engine.tick();
  expect(calls).toBe(1);
});
