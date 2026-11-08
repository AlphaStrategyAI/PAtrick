import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { now, type AppConfig, type Project, type ResearchRecord, type WorkerAdapter, type WorkerInput } from '../../src/domain.js';
import { FeishuChannel } from '../../src/integrations/feishu.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('keeps an existing owner standard separate from the two suggestions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decision-separation-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: now() };
  store.save('projects', project);
  const declaration = '我决定仅本产品保留草稿到下次成功导出';
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [{ runner: 'grok', roles: ['knowledge_extract', 'case_extract', 'decide'], domains: ['personal'], provider: 'fixture', model: 'fixture', admitted: true, costPerRunUsd: 0.01, independentReview: false }], feishu: { appId: 'app', appSecret: 'test', ownerOpenId: 'owner-open', chatId: 'owner-chat' } };
  const urls = ['https://zh.example.com/keep', 'https://en.example.com/delete'];
  const research: ResearchRecord = { queries: (['zh', 'en'] as const).map((language, index) => ({ language, query: language === 'zh' ? '草稿 保留' : 'draft retention', searchedAt: now(), sources: [{ language, url: urls[index]!, canonicalUrl: urls[index]!, title: language === 'zh' ? '保留' : 'Delete', publishedAt: '2026-01-01', accessedAt: now(), excerpt: 'The alternatives differ.', primary: true, conditions: 'Failed export' }] })), summary: '两种做法都有原文。', gaps: [] };
  const suggestion = (label: string, url: string) => ({ label, description: `${label}草稿`, rationale: '这是建议，不是已有标准。', tradeoff: '会放弃另一种做法。', evidenceUrls: [url] });
  const worker: WorkerAdapter = { name: 'grok', async run(input: WorkerInput) {
    const citation = { sourceId: input.source.id, revision: input.source.revision, quote: input.source.content, locator: input.source.locator };
    if (input.role !== 'decide') return { output: input.role === 'case_extract' ? { observations: [] } : { cards: [] }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    if (input.source.content === declaration) return { output: { action: 'archive', summary: '这是已记下的决定。', rationale: '不再执行。', citations: [citation], ruleIds: [], grounds: { statements: [], facts: [], unresolved: [] } }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
    return { output: { action: 'ask', summary: '两种做法都还可行。', rationale: '现有标准没有直接回答这件新任务。', citations: [citation], ruleIds: [], grounds: { statements: [{ citation, purpose: 'author-statement', binding: 'source-statement' }], facts: [], unresolved: [{ text: '还不知道用户是否需要恢复。', status: 'inference' }] }, question: { title: '这件新任务怎么处理草稿？', context: '需要你权衡。', A: suggestion('保留', urls[0]!), B: suggestion('删除', urls[1]!) } }, costUsd: 0.01, model: 'fixture', provider: 'fixture' };
  } };
  const engine = new Workbench({ store, config, workers: [worker], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { return research; } } });
  const channel = new FeishuChannel(store, config, engine, { im: { message: { async list() { return { code: 0, data: { items: [], has_more: false } }; }, async create() { throw new Error('unused'); } } } });
  try {
    await channel.receive({ sender: { sender_type: 'user', sender_id: { open_id: 'owner-open' } }, message: { message_id: 'native-1', chat_id: 'owner-chat', message_type: 'text', create_time: '1000', update_time: '1000', content: JSON.stringify({ text: declaration }) } });
    const task = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'next', title: '新的导出问题', content: '另一件导出失败后的草稿需要处理。' })!;
    await engine.runUntilIdle();
    const notice = store.list('outbox').find(message => message.taskId === task.id && message.text.includes('这件新任务怎么处理草稿'));
    expect(notice?.text).toContain(`你已有的标准：${declaration}`);
    expect(notice?.text).toContain('仍不确定：还不知道用户是否需要恢复。');
    expect(notice?.text).toContain('下面两条是建议，不是你的决定。');
    const page = await (await createApp({ store, config, engine }).request(`/tasks/${task.id}?project=p`)).text();
    expect(page).toContain('你已有的标准');
    expect(page).toContain('不是你的决定');
  } finally { await engine.shutdown(); }
});
