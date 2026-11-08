import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { now, type AppConfig, type Project, type ResearchRecord } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('keeps an under-evidenced question for another search instead of asking the owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-retry-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: now() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [] };
  const source = (url: string): ResearchRecord['queries'][number]['sources'][number] => ({ language: 'en', url, canonicalUrl: url, title: 'Original', publishedAt: '2026-01-01', accessedAt: now(), excerpt: 'Two approaches remain available.', primary: true, conditions: 'Failed export' });
  const thin: ResearchRecord = { queries: [{ language: 'zh', query: '草稿', searchedAt: now(), sources: [] }, { language: 'en', query: 'draft', searchedAt: now(), sources: [source('https://en.example.com/one')] }], summary: '还不够。', gaps: [] };
  const ready: ResearchRecord = { queries: (['zh', 'en'] as const).map((language, index) => ({ language, query: language === 'zh' ? '草稿 保留' : 'draft retention', searchedAt: now(), sources: [{ ...source(index ? 'https://en.example.com/two' : 'https://zh.example.com/one'), language }] })), summary: '两种语言都有原文。', gaps: [] };
  let calls = 0;
  const engine = new Workbench({ store, config, workers: [], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { calls += 1; return calls === 1 ? thin : ready; } } });
  const created = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'gap', title: '导出失败', content: '导出失败后的草稿需要一个处理办法。' })!;
  const suggestion = { label: '保留', description: '保留草稿', rationale: '可以恢复', tradeoff: '要保存', evidenceUrls: ['https://zh.example.com/one'] };
  store.save('tasks', { ...created, stage: 'research', status: 'researching', decision: { action: 'ask', summary: '需要选择', rationale: '两种做法', citations: [], ruleIds: [], question: { title: '怎么处理草稿？', context: '需要权衡。', A: suggestion, B: { ...suggestion, label: '删除', description: '删除草稿', evidenceUrls: ['https://en.example.com/two'] } } } });
  try {
    await engine.tick();
    expect(calls).toBe(1);
    expect(store.get('tasks', created.id)).toMatchObject({ status: 'retrying', stage: 'research', error: 'insufficient_research' });
    expect(store.list('questions')).toEqual([]);
    const waiting = await (await createApp({ store, config, engine }).request(`/tasks/${created.id}?project=p`)).text();
    expect(waiting).toContain('到点会再查');
    expect(waiting).toContain('这不需要你回答');
    await engine.tick();
    expect(calls).toBe(1);
    store.save('tasks', { ...store.get('tasks', created.id)!, runAfter: new Date(0).toISOString() });
    await engine.tick();
    expect(calls).toBe(2);
    expect(store.get('tasks', created.id)?.stage).toBe('decide');
    expect(store.get('tasks', created.id)?.error).toBeUndefined();
  } finally { await engine.shutdown(); }
});
