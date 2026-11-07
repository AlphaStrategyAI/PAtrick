import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { now, type Project } from '../../src/domain.js';
import { recordMaintenance } from '../../src/evaluation.js';
import { githubBranchCursor, scanGithubBranch } from '../../src/integrations/github-branch.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';

const base = 'a'.repeat(40);
const next = 'b'.repeat(40);
const own = 'c'.repeat(40);
const idea = '# 网页上的想法\n\n保留草稿。';

function project(): Project {
  return { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/product/PRD.md', allowedPaths: ['docs/product/PRD.md', 'docs/ideas/note.md'], trustedChecks: ['validate'], trustedAppIds: [1], ownerId: 'owner', autoMerge: false, budgetUsd: 0, createdAt: now(), executionRunner: 'grok', reviewIntervalDays: 7 };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-github-branch-'));
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  config.githubToken = 'fixture-token';
  const item = project();
  config.projects = [item];
  const store = new Store(':memory:');
  store.save('projects', item);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  return { store, config, item, engine };
}

function remote(routes: Record<string, unknown>): typeof fetch {
  return async input => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.github.com');
    const body = routes[url.pathname + url.search];
    if (!body) return new Response('missing', { status: 404 });
    return Response.json(body);
  };
}

it('records the current default-branch commit before importing later web edits', async () => {
  const { store, config, item, engine } = setup();
  const fetcher = remote({
    '/repos/owner/repo': { default_branch: 'main' },
    '/repos/owner/repo/commits/main': { sha: base },
  });
  try {
    expect(await scanGithubBranch(store, config, item, engine, fetcher)).toBe('baselined');
    expect(store.get('cursors', githubBranchCursor(item))?.value).toBe(base);
    expect(store.list('tasks')).toHaveLength(0);
    expect(await scanGithubBranch(store, config, item, engine, remote({
      '/repos/owner/repo': { default_branch: 'main' },
      '/repos/owner/repo/commits/main': { sha: next },
      [`/repos/owner/repo/compare/${base}...${next}`]: { status: 'ahead', ahead_by: 1, commits: [{ sha: next, commit: { message: 'Edit the idea on the web' } }] },
      [`/repos/owner/repo/commits/${next}`]: { sha: next, files: [{ filename: 'docs/ideas/note.md', status: 'modified' }, { filename: 'README', status: 'modified' }] },
      [`/repos/owner/repo/contents/docs/ideas/note.md?ref=${next}`]: { type: 'file', encoding: 'base64', content: Buffer.from(idea).toString('base64') },
    }))).toBe('advanced');
    expect(store.list('tasks')).toMatchObject([{ title: '网页上的想法', sourceRevision: next }]);
    expect(store.list('sources').filter(source => source.kind === 'github')).toMatchObject([{ externalId: 'github:main:docs/ideas/note.md', content: idea }]);
    expect(store.get('cursors', githubBranchCursor(item))?.value).toBe(next);
  } finally { await engine.shutdown(); store.close(); }
});

it('moves past this program’s own delivery without opening another task', async () => {
  const { store, config, item, engine } = setup();
  store.save('cursors', { id: githubBranchCursor(item), projectId: item.id, domain: item.domain, value: next, updatedAt: now() });
  try {
    expect(await scanGithubBranch(store, config, item, engine, remote({
      '/repos/owner/repo': { default_branch: 'main' },
      '/repos/owner/repo/commits/main': { sha: own },
      [`/repos/owner/repo/compare/${next}...${own}`]: { status: 'ahead', ahead_by: 1, commits: [{ sha: own, commit: { message: `docs: update\n\n${'PAtrick action '}delivery` } }] },
    }))).toBe('advanced');
    expect(store.list('tasks')).toHaveLength(0);
    expect(store.get('cursors', githubBranchCursor(item))?.value).toBe(own);
  } finally { await engine.shutdown(); store.close(); }
});

it('keeps the cursor when GitHub is unreachable or a new GitHub source is paused', async () => {
  const { store, config, item, engine } = setup();
  store.save('cursors', { id: githubBranchCursor(item), projectId: item.id, domain: item.domain, value: base, updatedAt: now() });
  const failing: typeof fetch = async () => { throw Error('offline'); };
  try {
    await expect(scanGithubBranch(store, config, item, engine, failing)).rejects.toMatchObject({ code: 'remote_unavailable' });
    expect(store.get('cursors', githubBranchCursor(item))?.value).toBe(base);
    recordMaintenance(store, item, { eventId: randomUUID(), minutes: 90, recordedAt: new Date(Date.now() - 10 * 86400000).toISOString() });
    recordMaintenance(store, item, { eventId: randomUUID(), minutes: 90, recordedAt: new Date(Date.now() - 2 * 86400000).toISOString() });
    await expect(scanGithubBranch(store, config, item, engine, remote({
      '/repos/owner/repo': { default_branch: 'main' },
      '/repos/owner/repo/commits/main': { sha: next },
      [`/repos/owner/repo/compare/${base}...${next}`]: { status: 'ahead', ahead_by: 1, commits: [{ sha: next, commit: { message: 'A web edit during the pause' } }] },
      [`/repos/owner/repo/commits/${next}`]: { sha: next, files: [{ filename: 'docs/ideas/note.md', status: 'modified' }] },
      [`/repos/owner/repo/contents/docs/ideas/note.md?ref=${next}`]: { type: 'file', encoding: 'base64', content: Buffer.from(idea).toString('base64') },
    }))).rejects.toMatchObject({ code: 'source_expansion_paused' });
    expect(store.get('cursors', githubBranchCursor(item))?.value).toBe(base);
    expect(store.list('sources').filter(source => source.kind === 'github')).toHaveLength(0);
  } finally { await engine.shutdown(); store.close(); }
});
