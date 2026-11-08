import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { DomainError, now, type AppConfig, type Project, type ResearchRecord, type WorkerAdapter, type WorkerInput } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { publishObservations } from '../../src/standards.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const statement = '失败后保留七天再删除。';

it('shows a quoted external method beside the suggestions and refuses to treat it as a principle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'external-reference-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: now() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [{ runner: 'grok', roles: ['knowledge_extract', 'case_extract', 'decide'], domains: ['personal'], provider: 'fixture', model: 'fixture', admitted: true, costPerRunUsd: 0.01, independentReview: false }] };
  const urls = ['https://zh.example.com/keep', 'https://en.example.com/delete'];
  const research: ResearchRecord = { queries: (['zh', 'en'] as const).map((language, index) => ({ language, query: language === 'zh' ? '草稿 保留' : 'draft retention', searchedAt: now(), sources: [{ language, url: urls[index]!, canonicalUrl: urls[index]!, title: language === 'zh' ? '保留' : 'Delete', publishedAt: '2026-01-01', accessedAt: now(), excerpt: 'The alternatives differ.', primary: true, conditions: 'Failed export' }] })), summary: '两种做法都有原文。', gaps: [] };
  const suggestion = (label: string, url: string) => ({ label, description: `${label}草稿`, rationale: '这是建议，不是已有标准。', tradeoff: '会放弃另一种做法。', evidenceUrls: [url] });
  let externalId = '';
  const seenRuleKinds: string[] = [];
  const worker: WorkerAdapter = { name: 'grok', async run(input: WorkerInput) {
    const citation = { sourceId: input.source.id, revision: input.source.revision, quote: input.source.content, locator: input.source.locator };
    if (input.role === 'knowledge_extract') return { output: { cards: [{ title: '投诉', body: '已有投诉记录。', quote: input.source.content, aliases: [], verification: 'reported', kind: 'fact' }] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role === 'case_extract') return { output: { observations: [], externalReferences: [{ title: '行业保留七日', statement, quote: input.source.content, conditions: '公开产品的失败导出', exceptions: '不含本人的明确决定' }] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role !== 'decide') return { output: {}, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    seenRuleKinds.push(...input.rules.map(rule => rule.kind));
    return { output: { action: 'ask', summary: '两种做法都还可行。', rationale: '外部方法不能代替你的决定。', citations: [citation], ruleIds: input.source.content.includes('引用外部') && externalId ? [externalId] : [], grounds: { statements: [{ citation, purpose: 'author-statement', binding: 'source-statement' }], facts: [], unresolved: [] }, question: { title: '草稿怎么处理？', context: '两种做法都还可行。', A: suggestion('保留', urls[0]!), B: suggestion('删除', urls[1]!) } }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
  } };
  const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { return research; } } });
  try {
    const task = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'draft', title: '导出失败', content: '导出失败后，已有用户投诉记录需要处理。' })!;
    await engine.runUntilIdle();
    const external = store.list('rules').filter(rule => rule.kind === 'external');
    expect(external.map(rule => rule.statement)).toEqual([statement]);
    expect(store.list('rules').some(rule => rule.kind === 'principle')).toBe(false);
    externalId = external[0]!.id;
    const notice = store.list('outbox').find(message => message.taskId === task.id && message.text.includes('草稿怎么处理'));
    expect(notice?.text).toContain(`可对照的外部方法：${statement}`);
    expect(notice?.text).toContain('这不是你的原则。');
    expect(notice?.text).not.toContain('你已有的标准');
    expect(seenRuleKinds).not.toContain('external');
    const page = await (await createApp({ store, config, engine }).request(`/tasks/${task.id}?project=p`)).text();
    expect(page).toContain('可对照的外部方法');
    expect(page).toContain('这不是你的原则');
    const standards = await (await createApp({ store, config, engine }).request('/standards?project=p&kind=external')).text();
    expect(standards).toContain('外部参考');
    expect(standards).toContain('行业保留七日');

    const cited = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'cite', title: '再判断', content: '引用外部方法后再决定草稿。' })!;
    await engine.runUntilIdle();
    expect(store.get('tasks', cited.id)).toMatchObject({ status: 'blocked', error: 'invalid_rule' });
    expect(store.list('questions').some(question => question.taskId === cited.id)).toBe(false);
    const blocked = await (await createApp({ store, config, engine }).request(`/tasks/${cited.id}?project=p`)).text();
    expect(blocked).toContain('这次判断引用了当前不能使用的规则');
  } finally { await engine.shutdown(); }
});

it('rejects an external method whose quotation is not in the source', () => {
  const root = mkdtempSync(join(tmpdir(), 'external-quote-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: now() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [] };
  const engine = new Workbench({ store, config, workers: [], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  const task = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'draft', title: '导出失败', content: '导出失败后，已有用户投诉记录需要处理。' })!;
  const source = store.get('sources', task.sourceId)!;
  const candidate = { title: '行业保留七日', statement, quote: '这句话不在原文里', conditions: '公开产品', exceptions: '不含本人决定' };
  expect(() => publishObservations(store, source, { observations: [], externalReferences: [candidate] })).toThrow(DomainError);
  expect(store.list('rules')).toEqual([]);
  const saved = publishObservations(store, source, { observations: [], externalReferences: [{ ...candidate, quote: source.content }] });
  expect(publishObservations(store, source, { observations: [], externalReferences: [{ ...candidate, quote: source.content }] }).map(rule => rule.id)).toEqual(saved.map(rule => rule.id));
  expect(store.list('rules').filter(rule => rule.kind === 'external')).toHaveLength(1);
});
