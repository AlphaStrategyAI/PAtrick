import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { now, type AppConfig, type DeliveryReceipt, type Project } from '../../src/domain.js';
import { scanGitlabNotes } from '../../src/integrations/gitlab-notes.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gitlab-notes-'));
  roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault'));
  stores.push(store);
  const project: Project = { id: 'p', projectId: 'p', domain: 'company', name: '内部', description: '', repository: 'group/product', repositoryProvider: 'gitlab', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [7], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: now() };
  store.save('projects', project);
  const config: AppConfig = { mode: 'test', host: '127.0.0.1', port: 0, dataDir: root, vaultDir: join(root, 'vault'), ownerId: 'owner', authToken: 'test', sessionSecret: 'test', projects: [project], workers: {}, scanIntervalMs: 1000, runnerPolicies: [], gitlabUrl: 'https://gitlab.company.test', gitlabToken: 'token' };
  const engine = new Workbench({ store, config, workers: [], writer: { async baseline() { return 'baseline'; }, async deliver() { throw new Error('unused'); } }, research: { async research() { throw new Error('unused'); } } });
  const task = engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'idea', title: '内部期限', content: '把恢复期限写进内部 PRD。' })!;
  return { store, config, project, engine, task };
}

function note(id: number, body: string, system = false) {
  return { id, body, system, updated_at: '2026-11-08T00:00:00.000Z', author: { username: 'reviewer' } };
}

it('keeps a note on a merged request with that task and skips system notes', async () => {
  const f = setup();
  const receipt: DeliveryReceipt = { id: 'receipt-1', projectId: 'p', domain: 'company', taskId: f.task.id, repository: 'group/product', path: 'docs/PRD.md', pullRequestUrl: 'https://gitlab.company.test/group/product/-/merge_requests/4', pullRequestNumber: 4, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40), contentHash: 'c'.repeat(64), verifiedAt: now(), checks: [] };
  f.store.save('receipts', receipt);
  f.store.save('tasks', { ...f.task, status: 'delivered', stage: 'feedback', receiptId: receipt.id });
  const fetcher: typeof fetch = async () => new Response(JSON.stringify([note(9, '请补充恢复期限。'), note(10, 'changed the description', true), note(11, 'PAtrick action 123')]), { status: 200 });
  await scanGitlabNotes(f.store, f.config, f.project, f.engine, fetcher);
  await scanGitlabNotes(f.store, f.config, f.project, f.engine, fetcher);
  expect(f.store.list('tasks')).toEqual([expect.objectContaining({ id: f.task.id, status: 'delivered', version: f.task.version })]);
  expect(f.store.list('sources').filter(source => source.kind === 'gitlab')).toHaveLength(1);
  expect(f.store.list('events').map(event => event.message)).toContain('这条讨论有了新消息。原任务已经结束，不会另开一件。');
});

it('continues an open merge request once and leaves an ambiguous request alone', async () => {
  const f = setup();
  f.store.save('actions', { id: 'delivery-1', projectId: 'p', domain: 'company', taskId: f.task.id, kind: 'repository_delivery', status: 'pending', payload: { pullRequestNumber: 8 }, updatedAt: now() });
  const fetcher: typeof fetch = async input => new Response(JSON.stringify(String(input).includes('/merge_requests/8/') ? [note(3, '检查还没过，先不要合并。')] : []), { status: 200 });
  await scanGitlabNotes(f.store, f.config, f.project, f.engine, fetcher);
  expect(f.store.get('tasks', f.task.id)).toMatchObject({ id: f.task.id, version: f.task.version + 1, status: 'queued' });
  await scanGitlabNotes(f.store, f.config, f.project, f.engine, fetcher);
  expect(f.store.get('tasks', f.task.id)?.version).toBe(f.task.version + 1);
  const other = f.engine.ingest({ projectId: 'p', kind: 'manual', externalId: 'other', title: '另一件', content: '另一件任务。' })!;
  f.store.save('receipts', { id: 'r1', projectId: 'p', domain: 'company', taskId: f.task.id, repository: 'group/product', path: 'docs/PRD.md', pullRequestUrl: 'https://gitlab.company.test/group/product/-/merge_requests/8', pullRequestNumber: 8, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40), contentHash: 'c'.repeat(64), verifiedAt: now(), checks: [] });
  f.store.save('receipts', { id: 'r2', projectId: 'p', domain: 'company', taskId: other.id, repository: 'group/product', path: 'docs/PRD.md', pullRequestUrl: 'https://gitlab.company.test/group/product/-/merge_requests/8', pullRequestNumber: 8, headSha: 'd'.repeat(40), mergeSha: 'e'.repeat(40), contentHash: 'f'.repeat(64), verifiedAt: now(), checks: [] });
  const before = f.store.list('sources').length;
  const blocked: typeof fetch = async () => new Response(JSON.stringify([note(12, '这条不该投递。')]), { status: 200 });
  await scanGitlabNotes(f.store, f.config, f.project, f.engine, blocked);
  expect(f.store.list('sources')).toHaveLength(before);
});
