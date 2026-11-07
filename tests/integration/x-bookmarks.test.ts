import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { now, type Project } from '../../src/domain.js';
import { recordMaintenance } from '../../src/evaluation.js';
import { scanXBookmarks, xBookmarkCursor } from '../../src/integrations/x-bookmarks.js';
import { acceptBookmarkLearning, learningView } from '../../src/learning.js';
import { Workbench } from '../../src/orchestrator.js';
import { saveConnectionSecrets } from '../../src/setup-guide.js';
import { Store } from '../../src/store.js';

const text = '导出失败后草稿应该还能找回来。';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-x-bookmarks-'));
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  config.xToken = 'x-bookmark-token';
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/product/PRD.md', allowedPaths: ['docs/product/PRD.md'], trustedChecks: [], trustedAppIds: [], ownerId: config.ownerId, autoMerge: false, budgetUsd: 0, createdAt: now(), executionRunner: 'grok', reviewIntervalDays: 7 };
  config.projects = [project];
  const store = new Store(':memory:');
  store.save('projects', project);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  return { root, config, project, store, engine };
}

function remote(bookmarks: { id: string; text: string }[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.x.com');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer x-bookmark-token');
    if (url.pathname === '/2/users/me') return Response.json({ data: { id: '42', username: 'owner' } });
    if (url.pathname === '/2/users/42/bookmarks') return Response.json({ data: bookmarks, meta: { result_count: bookmarks.length } });
    return new Response('missing', { status: 404 });
  };
}

it('imports the newest bookmark page and accepts only a grounded learning note', async () => {
  const { config, project, store, engine } = setup();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.x.com');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer x-bookmark-token');
    if (url.pathname === '/2/users/me') return Response.json({ data: { id: '42', username: 'owner' } });
    if (url.pathname === '/2/users/42/bookmarks') return Response.json({ data: [{ id: '100', text }, { id: '90', text: '更早的书签也在这一页里，保留原句。' }], meta: { result_count: 2 } });
    return new Response('missing', { status: 404 });
  };
  try {
    expect(await scanXBookmarks(store, config, project, engine, fetcher)).toBe('imported');
    const sources = store.list('sources').filter(source => source.kind === 'reading');
    expect(sources.map(source => source.externalId).sort()).toEqual(['x-bookmark:100', 'x-bookmark:90']);
    expect(store.list('tasks').filter(task => task.kind !== 'reference_knowledge')).toHaveLength(0);
    expect(store.list('rules')).toHaveLength(0);
    expect(store.get('cursors', xBookmarkCursor(project))?.value).toBe('100');
    const source = sources.find(item => item.externalId === 'x-bookmark:100')!;
    const app = createApp({ store, config, engine });
    expect(await (await app.request('/sources')).text()).toContain('这本书签还没有核验过的解释、关联、反例和到期复核。');
    expect(() => acceptBookmarkLearning(store, source, { explanation: '模型认为应该保留草稿。', association: 'none', counterexample: '失败后立即删除也是一种选择。', reviewAt: new Date(Date.now() + 86400000).toISOString() })).toThrowError(expect.objectContaining({ code: 'learning_ungrounded' }));
    expect(learningView(store, source)?.state).toBe('pending');
    acceptBookmarkLearning(store, source, { explanation: `书签原句是：${text}`, association: 'none', counterexample: '失败后立即删除也是一种选择。', reviewAt: new Date(Date.now() + 86400000).toISOString() });
    expect(learningView(store, source)).toMatchObject({ state: 'checked', association: 'none' });
    expect(store.list('rules')).toHaveLength(0);
    expect(await (await app.request('/sources')).text()).toContain('已核验解释、关联、反例和到期复核。');
    expect(await scanXBookmarks(store, config, project, engine, fetcher)).toBe('idle');
    expect(store.list('sources').filter(source => source.kind === 'reading')).toHaveLength(2);
  } finally { await engine.shutdown(); store.close(); }
});

it('keeps the cursor when X is unreachable or a first bookmark is paused, and does not echo the token', async () => {
  const { root, config, project, store, engine } = setup();
  const failing: typeof fetch = async () => { throw Error('offline'); };
  try {
    await expect(scanXBookmarks(store, config, project, engine, failing)).rejects.toMatchObject({ code: 'remote_unavailable' });
    expect(store.get('cursors', xBookmarkCursor(project))).toBeUndefined();
    recordMaintenance(store, project, { eventId: randomUUID(), minutes: 90, recordedAt: new Date(Date.now() - 10 * 86400000).toISOString() });
    recordMaintenance(store, project, { eventId: randomUUID(), minutes: 90, recordedAt: new Date(Date.now() - 2 * 86400000).toISOString() });
    await expect(scanXBookmarks(store, config, project, engine, remote([{ id: '100', text }]))).rejects.toMatchObject({ code: 'source_expansion_paused' });
    expect(store.list('sources').filter(source => source.externalId.startsWith('x-bookmark:'))).toHaveLength(0);
    saveConnectionSecrets(config, { xToken: 'x-bookmark-token-secret' });
    const reloaded = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
    expect(reloaded.xToken).toBe('x-bookmark-token-secret');
    const page = await (await createApp({ store, config, engine }).request('/settings')).text();
    expect(page).toContain('知识学习');
    expect(page).not.toContain('x-bookmark-token-secret');
  } finally { await engine.shutdown(); store.close(); }
});
