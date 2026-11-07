import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { now, type Project, type Task } from '../../src/domain.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

it('starts one release follow-up from the task page and keeps the same task on a second request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-follow-up-'));
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/product/PRD.md', allowedPaths: ['docs/product/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: config.ownerId, autoMerge: true, budgetUsd: 0, createdAt: now(), executionRunner: 'grok', reviewIntervalDays: 7 };
  config.projects = [project];
  const store = new Store(':memory:');
  const at = now();
  const source = { id: 'source', projectId: 'p', domain: 'personal', kind: 'manual' as const, externalId: 'evidence', revision: 'v1', title: '发布后的问题', content: '导出失败后保留草稿，以供恢复。', locator: 'note', authorId: config.ownerId, retention: 'permanent' as const, status: 'active' as const, createdAt: at };
  const task = { id: 'task', projectId: 'p', domain: 'personal', sourceId: source.id, sourceRevision: source.revision, title: '补入 PRD', description: source.content, status: 'delivered' as const, version: 1, createdAt: at, updatedAt: at, runAfter: at, attempts: 1, repairCount: 0, budgetUsd: 0, spentUsd: 0, stage: 'feedback' as const, receiptId: 'receipt' } satisfies Task;
  const receipt = { id: 'receipt', projectId: 'p', domain: 'personal', taskId: task.id, repository: project.repository, path: project.prdPath, pullRequestUrl: 'https://github.com/owner/repo/pull/4', pullRequestNumber: 4, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40), contentHash: 'c'.repeat(64), verifiedAt: at, checks: [{ name: 'validate', conclusion: 'success', headSha: 'a'.repeat(40), appId: 7, url: 'https://github.com/owner/repo/actions/1' }] };
  store.save('projects', project);
  store.save('sources', source);
  store.save('tasks', task);
  store.save('receipts', receipt);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  const app = createApp({ store, config, engine });
  try {
    const before = await (await app.request('/tasks/task')).text();
    expect(before).toContain('还没有按这次合并再派规划、执行和检查。');
    expect(before).toContain('按这次合并再派');
    const first = await app.request('/api/receipts/receipt/follow-up', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ sourceId: source.id }) });
    const started = await first.json() as { taskId: string };
    const second = await app.request('/api/receipts/receipt/follow-up', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ sourceId: source.id }) });
    expect(await second.json()).toMatchObject({ taskId: started.taskId });
    const after = await (await app.request('/tasks/task')).text();
    expect(after).toContain('已按这次合并再派规划、执行和检查。');
    expect(after).toContain(`href="/tasks/${started.taskId}"`);
    expect(after).toContain('查看再派的任务');
    expect(after).not.toContain('按这次合并再派</button>');
    expect(store.list('tasks').filter(item => item.id !== task.id && item.id !== started.taskId)).toHaveLength(0);
    expect(store.list('actions').find(action => action.kind === 'operations.follow-up')?.payload).toMatchObject({ errorRate: null, rollback: null, taskId: started.taskId });
  } finally { await engine.shutdown(); store.close(); }
});
