import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { configureDemo } from '../../src/demo.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, type Question, type Task } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

it('renders uncovered channels on the sources page without forward, tag, or export actions', async () => {
  const config = readConfig({ PATRICK_MODE: 'demo', PATRICK_HOST: '127.0.0.1', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  configureDemo(config);
  const store = new Store(':memory:');
  store.save('projects', { ...config.projects[0]!, ownerId: config.ownerId });
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  const app = createApp({ store, config, engine });
  try {
    const response = await app.request('/sources');
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const name of ['公众号', '个人微信', '第三方 Grok']) expect(html).toContain(name);
    expect(html).toContain('未覆盖');
    expect(html).toContain('不增加转发、贴标签或导出');
    expect(html).not.toContain('>转发<');
    expect(html).not.toContain('>贴标签<');
    expect(html).not.toContain('>导出<');
    for (const name of ['GitHub 远端分支', 'X 书签', '邮箱', 'Grok Bot']) expect(html).toContain(name);
    expect(html).toContain('未接入');
    expect(html).toContain('还没有接入');
  } finally { await engine.shutdown(); store.close(); }
});

it('shows bilingual research on the workbench question and lists uncovered channels there', async () => {
  const config = readConfig({ PATRICK_MODE: 'demo', PATRICK_HOST: '127.0.0.1', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  configureDemo(config);
  const store = new Store(':memory:');
  const project = { ...config.projects[0]!, ownerId: config.ownerId };
  store.save('projects', project);
  const at = now();
  const suggestion = { label: '保留', description: '保留草稿', rationale: '便于恢复', tradeoff: '多留一份', evidenceUrls: ['https://example.com/patrick-demo/zh'] };
  const task = { id: 'task', projectId: project.id, domain: project.domain, sourceId: 'source', sourceRevision: 'v1', title: '确认草稿', description: '需要选择', status: 'awaiting_answer', version: 1, createdAt: at, updatedAt: at, runAfter: at, attempts: 0, repairCount: 0, budgetUsd: project.budgetUsd, spentUsd: 0, stage: 'decide', questionId: 'question' } satisfies Task;
  const question = { id: 'question', projectId: project.id, domain: project.domain, taskId: task.id, taskVersion: 1, version: 1, ownerId: config.ownerId, title: '草稿保留多久？', context: '两种做法都可行', options: { A: suggestion, B: { ...suggestion, label: '删除', evidenceUrls: ['https://example.com/patrick-demo/en'] } }, research: { queries: [{ language: 'zh', query: '草稿恢复 实践', searchedAt: at, sources: [{ url: 'https://example.com/patrick-demo/zh', title: '中文资料', language: 'zh', publishedAt: '2026-11-03', accessedAt: at, excerpt: '中文原文', primary: true, canonicalUrl: 'https://example.com/patrick-demo/zh', conditions: '本产品' }] }, { language: 'en', query: 'draft recovery', searchedAt: at, sources: [{ url: 'https://example.com/patrick-demo/en', title: 'English source', language: 'en', publishedAt: '2026-11-03', accessedAt: at, excerpt: 'English original', primary: true, canonicalUrl: 'https://example.com/patrick-demo/en', conditions: 'this product' }] }], summary: '两种语言都查过。', gaps: [] }, status: 'open', createdAt: at } satisfies Question;
  store.save('tasks', task);
  store.save('questions', question);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  const app = createApp({ store, config, engine });
  try {
    const html = await (await app.request('/')).text();
    expect(html).toContain('中英文查证记录');
    expect(html).toContain('草稿恢复 实践');
    expect(html).toContain('draft recovery');
    expect(html).toContain('第三方 Grok');
    expect(html).toContain('未覆盖的来源');
  } finally { await engine.shutdown(); store.close(); }
});

it('stores a GitHub token and Feishu secret from settings without sending them back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-settings-'));
  const config = readConfig({ PATRICK_MODE: 'demo', PATRICK_HOST: '127.0.0.1', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  configureDemo(config);
  const store = new Store(':memory:');
  store.save('projects', { ...config.projects[0]!, ownerId: config.ownerId, sourceDir: '/tmp/ideas' });
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  const launched: string[] = [];
  const app = createApp({ store, config, engine, launchRunnerLogin: async runner => { launched.push(runner); } });
  const token = 'github-token-should-not-echo';
  const secret = 'feishu-secret-should-not-echo';
  try {
    const password = 'restic-password-should-not-echo';
    const saved = await app.request('/api/settings/connections', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ githubToken: token, resticPassword: password, resticRepository: '/tmp/patrick-restic', limaInstance: 'patrick-local', feishu: { appId: 'cli_app', appSecret: secret, ownerOpenId: 'ou_owner' } }) });
    expect(saved.status).toBe(200);
    const page = await (await app.request('/settings')).text();
    expect(page).not.toContain(token);
    expect(page).not.toContain(secret);
    expect(page).not.toContain(password);
    expect(page).toContain('patrick-local');
    expect(page).toContain('隔离、备份和网络');
    expect(page).toContain('已保存。留空则不修改。');
    expect(page).toContain('打开终端登录');
    const login = await app.request('/api/settings/runners/codex/login', { method: 'POST', headers: { Accept: 'application/json' } });
    expect(login.status).toBe(200);
    expect(launched).toEqual(['codex']);
    expect(JSON.stringify(await login.json())).not.toContain(token);
  } finally { await engine.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
