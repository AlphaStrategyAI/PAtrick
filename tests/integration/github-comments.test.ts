import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { now, type AppConfig, type DeliveryReceipt, type Project } from '../../src/domain.js';
import { scanGithubComments } from '../../src/integrations/github-comments.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'github-comments-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: now() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [], githubToken: 'token' };
  const engine = new Workbench({ store, config, workers: [], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  const task = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'idea', title: '草稿期限', content: '把恢复期限写进 PRD。' })!;
  return { store, config, project, engine, task };
}

function comment(id: number, body: string, updated = '2026-11-08T00:00:00Z') {
  return { id, body, updated_at: updated, html_url: `https://github.com/owner/repo/pull/4#issuecomment-${id}`, user: { login: 'reviewer' } };
}

it('keeps a comment on a delivered pull request with that task', async () => {
  const f = setup();
  const receipt: DeliveryReceipt = { id: 'receipt-1', projectId: 'p', domain: 'personal', taskId: f.task.id, repository: 'owner/repo', path: 'docs/PRD.md', pullRequestUrl: 'https://github.com/owner/repo/pull/4', pullRequestNumber: 4, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40), contentHash: 'c'.repeat(64), verifiedAt: now(), checks: [] };
  f.store.save('receipts', receipt);
  f.store.save('tasks', { ...f.task, status: 'delivered', stage: 'feedback', receiptId: receipt.id });
  const fetcher: typeof fetch = async () => new Response(JSON.stringify([comment(9, '请补充恢复期限。'), comment(10, 'PAtrick action 123')]), { status: 200 });
  await scanGithubComments(f.store, f.config, f.project, f.engine, fetcher);
  await scanGithubComments(f.store, f.config, f.project, f.engine, fetcher);
  expect(f.store.list('tasks')).toEqual([expect.objectContaining({ id: f.task.id, status: 'delivered', version: f.task.version })]);
  expect(f.store.list('sources').filter(source => source.externalId.startsWith('github-comment:'))).toHaveLength(1);
  expect(f.store.list('events').map(event => event.message)).toContain('这条讨论有了新消息。原任务已经结束，不会另开一件。');
});

it('withdraws a pull request comment that the complete listing no longer contains', async () => {
  const f = setup();
  f.store.save('actions', { id: 'delivery-1', projectId: 'p', domain: 'personal', taskId: f.task.id, kind: 'repository_delivery', status: 'pending', payload: { pullRequestNumber: 8 }, updatedAt: now() });
  const page = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });
  await scanGithubComments(f.store, f.config, f.project, f.engine, page([comment(3, '这段评论稍后会被删除。')]));
  await expect(scanGithubComments(f.store, f.config, f.project, f.engine, page({ message: 'down' }, 503))).rejects.toMatchObject({ code: 'remote_unavailable' });
  expect(f.store.list('sources').some(source => source.status === 'active' && source.content === '这段评论稍后会被删除。')).toBe(true);
  await scanGithubComments(f.store, f.config, f.project, f.engine, page([]));
  expect(f.store.list('sources').filter(source => source.externalId.includes('github-comment:') && source.status === 'active')).toEqual([]);
  expect(f.store.get('tasks', f.task.id)?.description ?? '').not.toContain('这段评论稍后会被删除。');
  expect(f.store.get('tasks', f.task.id)?.error).toBe('evidence_withdrawn');
  expect(f.store.list('events').map(event => event.message)).toContain('来源已撤回。相关知识和规则已停用。');
});

it('continues the same unfinished task when a pull request comment is edited', async () => {
  const f = setup();
  f.store.save('actions', { id: 'delivery-1', projectId: 'p', domain: 'personal', taskId: f.task.id, kind: 'repository_delivery', status: 'pending', payload: { pullRequestNumber: 8 }, updatedAt: now() });
  const fetcher = (body: string, updated: string): typeof fetch => async () => new Response(JSON.stringify([comment(3, body, updated)]), { status: 200 });
  await scanGithubComments(f.store, f.config, f.project, f.engine, fetcher('检查还没过，先不要合并。', '2026-11-08T00:00:00Z'));
  const continued = f.store.get('tasks', f.task.id)!;
  await scanGithubComments(f.store, f.config, f.project, f.engine, fetcher('检查还没过。补充：只保留七天。', '2026-11-08T01:00:00Z'));
  const edited = f.store.get('tasks', f.task.id)!;
  expect(f.store.list('tasks').filter(task => task.status !== 'cancelled')).toEqual([expect.objectContaining({ id: f.task.id })]);
  expect(edited.status).not.toBe('cancelled');
  expect(edited.description).toBe('检查还没过。补充：只保留七天。');
  expect(edited.version).toBe(continued.version + 1);
  expect(f.store.list('events').map(event => event.message)).toContain('这条讨论有了新修订。原任务重新处理一次。');
  expect(f.store.list('sources').filter(source => source.externalId.includes('github-comment:') && source.status === 'active')).toHaveLength(1);
});

it('continues an open pull request task once and does not import when two tasks claim it', async () => {
  const f = setup();
  f.store.save('actions', { id: 'delivery-1', projectId: 'p', domain: 'personal', taskId: f.task.id, kind: 'repository_delivery', status: 'pending', payload: { pullRequestNumber: 8 }, updatedAt: now() });
  const fetcher: typeof fetch = async input => new Response(JSON.stringify(String(input).includes('/issues/8/') ? [comment(3, '检查还没过，先不要合并。')] : []), { status: 200 });
  await scanGithubComments(f.store, f.config, f.project, f.engine, fetcher);
  expect(f.store.get('tasks', f.task.id)).toMatchObject({ id: f.task.id, version: f.task.version + 1, status: 'queued' });
  await scanGithubComments(f.store, f.config, f.project, f.engine, fetcher);
  expect(f.store.get('tasks', f.task.id)?.version).toBe(f.task.version + 1);
  const other = f.engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'other', title: '另一件', content: '另一件任务。' })!;
  f.store.save('receipts', { id: 'r1', projectId: 'p', domain: 'personal', taskId: f.task.id, repository: 'owner/repo', path: 'docs/PRD.md', pullRequestUrl: 'https://github.com/owner/repo/pull/8', pullRequestNumber: 8, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40), contentHash: 'c'.repeat(64), verifiedAt: now(), checks: [] });
  f.store.save('receipts', { id: 'r2', projectId: 'p', domain: 'personal', taskId: other.id, repository: 'owner/repo', path: 'docs/PRD.md', pullRequestUrl: 'https://github.com/owner/repo/pull/8', pullRequestNumber: 8, headSha: 'd'.repeat(40), mergeSha: 'e'.repeat(40), contentHash: 'f'.repeat(64), verifiedAt: now(), checks: [] });
  const before = f.store.list('sources').length;
  const blocked: typeof fetch = async () => new Response(JSON.stringify([comment(11, '这条不该投递给任何一件。')]), { status: 200 });
  await scanGithubComments(f.store, f.config, f.project, f.engine, blocked);
  expect(f.store.list('sources')).toHaveLength(before);
});
