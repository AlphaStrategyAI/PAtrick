import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { AppConfig, Project, ResearchRecord, WorkerAdapter, WorkerInput } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('states the remaining evidence gap on the decision card when one language has no original', async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-gap-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: new Date().toISOString() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [{ runner: 'grok', roles: ['knowledge_extract', 'case_extract', 'decide'], domains: ['personal'], provider: 'fixture', model: 'fixture', admitted: true, costPerRunUsd: 0.01, independentReview: false }] };
  const urls = ['https://en.example.com/keep', 'https://en.example.com/delete'];
  const research: ResearchRecord = { queries: [
    { language: 'zh', query: '导出失败 草稿 一手资料', searchedAt: new Date().toISOString(), sources: [] },
    { language: 'en', query: 'failed export draft primary source', searchedAt: new Date().toISOString(), sources: urls.map((url, index) => ({ language: 'en' as const, url, canonicalUrl: url, title: index ? 'Delete' : 'Keep', publishedAt: '2026-01-01', accessedAt: new Date().toISOString(), excerpt: 'Two English originals remain.', primary: true, conditions: 'Failed export' })) },
  ], summary: '英文有两份原文，中文没有。', gaps: ['中文换词之后仍没有可靠原文。'] };
  const suggestion = (label: string, url: string) => ({ label, description: label, rationale: '英文原文支持这个做法。', tradeoff: '另一种做法会被放弃。', evidenceUrls: [url] });
  const worker: WorkerAdapter = { name: 'grok', async run(input: WorkerInput) {
    const citation = { sourceId: input.source.id, revision: input.source.revision, quote: input.source.content, locator: input.source.locator };
    if (input.role === 'knowledge_extract') return { output: { cards: [] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.role === 'case_extract') return { output: { observations: [] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    return { output: { action: 'ask', summary: '两种做法都还可行。', rationale: '中文原文不足，仍要你选择。', citations: [citation], ruleIds: [], grounds: { statements: [{ citation, purpose: 'author-statement', binding: 'source-statement' }], facts: [], unresolved: [] }, question: { title: '导出失败后怎么处理草稿？', context: '需要你权衡恢复机会和留存成本。', A: suggestion('保留', urls[0]!), B: suggestion('删除', urls[1]!) } }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
  } };
  const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { return research; } } });
  const task = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'gap', title: '导出失败', content: '导出失败后的草稿需要一个处理办法。' })!;
  try {
    await engine.runUntilIdle();
    const question = store.list('questions').find(item => item.taskId === task.id);
    const notice = store.list('outbox').find(message => message.taskId === task.id);
    expect(question?.context).toContain('查证仍有缺口。下面两个建议可以参考，但不是完整结论。');
    expect(question?.context).toContain('中文没有打开到可靠原文。');
    expect(notice?.text).toContain('不是完整结论');
    expect(notice?.text).toContain('中文没有打开到可靠原文。');
    const page = await (await createApp({ store, config, engine }).request(`/tasks/${task.id}?project=p`)).text();
    expect(page).toContain('不是完整结论');
  } finally { await engine.shutdown(); }
});
