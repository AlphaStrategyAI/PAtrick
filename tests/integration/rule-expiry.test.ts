import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { expireDueRules } from '../../src/cases.js';
import { readConfig } from '../../src/config.js';
import { now, type DecisionCase, type Project, type Question, type Rule } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { publicError } from '../../src/readiness.js';
import { createRuntime } from '../../src/runtime.js';
import { applicableRules } from '../../src/standards.js';
import { Store } from '../../src/store.js';

const stores: Store[] = [];
const roots: string[] = [];
const runtimes: Awaited<ReturnType<typeof createRuntime>>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  stores.splice(0).forEach(store => store.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function setup() {
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_OWNER_ID: 'owner', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '我的项目', description: '', repository: 'a/b', repositoryProvider: 'github', prdPath: 'PRD.md', allowedPaths: ['PRD.md'], trustedChecks: ['test'], trustedAppIds: [1], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: now() };
  config.projects = [project];
  config.host = '127.0.0.1';
  const store = new Store(':memory:');
  stores.push(store);
  store.save('projects', project);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('unused'); } }, research: { research: async () => { throw Error('unused'); } } });
  const ingest = (externalId: string) => engine.ingest({ projectId: 'p', externalId, title: '导出', content: '仅本产品保留到下次成功导出。' })!;
  return { config, store, project, engine, ingest };
}

function rule(project: Project, sourceId: string, revision: string, locator: string, id: string, reviewAt: string): Rule {
  return { id, projectId: project.id, domain: project.domain, title: '保留草稿', statement: '仅本产品保留到下次成功导出。', conditions: '仅本产品', exceptions: '敏感草稿另计', version: 1, kind: 'principle', status: 'active', caseIds: id === 'current' ? ['case-current'] : [], citations: [{ sourceId, revision, quote: '仅本产品保留到下次成功导出。', locator }], createdAt: '2026-01-01T00:00:00.000Z', reviewAt };
}

it('pauses an expired rule, keeps its wording, and rejudges unfinished work once', async () => {
  const f = setup();
  const sourceTask = f.ingest('source');
  const source = f.store.get('sources', sourceTask.sourceId)!;
  const open = f.ingest('open');
  const done = f.ingest('done');
  const waiting = f.ingest('waiting');
  const suggestion = (label: string) => ({ label, description: label, rationale: '依据', tradeoff: '代价', evidenceUrls: ['https://example.com'] });
  const question: Question = { id: 'q-open', projectId: 'p', domain: 'personal', taskId: open.id, taskVersion: open.version, version: 1, ownerId: 'owner', title: '保留吗', context: '选择', options: { A: suggestion('保留'), B: suggestion('删除') }, research: { queries: [], summary: '', gaps: [] }, status: 'open', createdAt: now() };
  f.store.save('questions', question);
  f.store.save('tasks', { ...open, stage: 'plan', status: 'planning', questionId: question.id });
  f.store.save('tasks', { ...done, stage: 'feedback', status: 'delivered', receiptId: 'receipt-done' });
  const decision: DecisionCase = { id: 'case-current', projectId: 'p', domain: 'personal', taskId: waiting.id, questionId: 'q-current', decisionId: 'decision-current', actorId: 'owner', choice: 'C', originalWords: '仅本产品保留到下次成功导出。', rationale: '当时的原话', alternatives: [], ruleIds: ['current'], sourceId: source.id, status: 'active', createdAt: now() };
  f.store.save('cases', decision);
  const current = rule(f.project, source.id, source.revision, source.locator, 'current', '2099-01-01T00:00:00.000Z');
  const due = rule(f.project, source.id, source.revision, source.locator, 'due', '2020-01-01T00:00:00.000Z');
  const elsewhere: Rule = { ...due, id: 'elsewhere', projectId: 'other', domain: 'work' };
  f.store.save('rules', current);
  f.store.save('rules', due);
  f.store.save('rules', elsewhere);
  expect(applicableRules(f.store, waiting, f.config).map(item => item.id)).toEqual(['current']);
  expect(expireDueRules(f.store, f.project, new Date('2026-11-08T00:00:00.000Z'))).toBe(1);
  expect(f.store.get('rules', 'due')).toMatchObject({ status: 'suspended', statement: due.statement, citations: due.citations });
  expect(f.store.get('rules', 'current')?.status).toBe('active');
  expect(f.store.get('rules', 'elsewhere')?.status).toBe('active');
  expect(applicableRules(f.store, f.store.get('tasks', waiting.id)!, f.config).map(item => item.id)).toEqual(['current']);
  expect(f.store.get('tasks', open.id)).toMatchObject({ version: open.version + 1, status: 'deciding', stage: 'decide', error: 'rule_expired' });
  expect(f.store.get('questions', question.id)?.status).toBe('stale');
  expect(f.store.get('tasks', done.id)).toMatchObject({ version: done.version, status: 'delivered' });
  expect(f.store.get('tasks', waiting.id)?.version).toBe(waiting.version);
  expect(publicError('rule_expired')).toContain('原文仍保留');
  expect(expireDueRules(f.store, f.project, new Date('2026-11-08T00:00:00.000Z'))).toBe(0);
  expect(f.store.get('tasks', open.id)?.version).toBe(open.version + 1);
  const app = createApp({ store: f.store, config: f.config, engine: f.engine });
  const html = await (await app.request('/standards?project=p')).text();
  expect(html).toContain(due.statement);
  expect(html).toContain('已到复核期，暂停自动引用。原文仍保留。');
  expect(html).toContain('已暂停');
});

it('expires a due rule when the scheduled review scan runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rule-expiry-'));
  roots.push(root);
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '我的项目', description: '', repository: 'a/b', repositoryProvider: 'github', prdPath: 'PRD.md', allowedPaths: ['PRD.md'], trustedChecks: [], trustedAppIds: [], ownerId: config.ownerId, autoMerge: false, budgetUsd: 1, createdAt: now() };
  config.projects = [project];
  const runtime = await createRuntime(config);
  runtimes.push(runtime);
  const saved: Rule = { id: 'scheduled', projectId: 'p', domain: 'personal', title: '保留草稿', statement: '到期后仍保留这句原文。', conditions: '仅本产品', exceptions: '无', version: 1, kind: 'principle', status: 'active', caseIds: [], citations: [], createdAt: now(), reviewAt: '2020-01-01T00:00:00.000Z' };
  runtime.store.save('rules', saved);
  expect(runtime.reviewOutcomes({ projectId: 'p', domain: 'personal' })).toBe(0);
  expect(runtime.store.get('rules', 'scheduled')).toMatchObject({ status: 'suspended', statement: saved.statement });
});
