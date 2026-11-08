import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { now, type Project } from '../../src/domain.js';
import { recordMaintenance } from '../../src/evaluation.js';
import { gmailCursor, scanGmail } from '../../src/integrations/gmail.js';
import { Workbench } from '../../src/orchestrator.js';
import { saveConnectionSecrets } from '../../src/setup-guide.js';
import { Store } from '../../src/store.js';

const mail = '邮件里写着：导出失败后草稿应该还能找回来。';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-gmail-'));
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  config.gmailToken = 'gmail-token';
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/product/PRD.md', allowedPaths: ['docs/product/PRD.md'], trustedChecks: [], trustedAppIds: [], ownerId: config.ownerId, autoMerge: false, budgetUsd: 0, createdAt: now(), executionRunner: 'grok', reviewIntervalDays: 7 };
  config.projects = [project];
  const store = new Store(':memory:');
  store.save('projects', project);
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  return { root, config, project, store, engine };
}

function remote(routes: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://gmail.googleapis.com');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer gmail-token');
    const body = routes[url.pathname + url.search];
    if (!body) return new Response('missing', { status: 404 });
    return Response.json(body);
  };
}

it('records the current Gmail history id before importing a later message', async () => {
  const { config, project, store, engine } = setup();
  const encoded = Buffer.from(mail).toString('base64url');
  try {
    expect(await scanGmail(store, config, project, engine, remote({ '/gmail/v1/users/me/profile': { emailAddress: 'owner@example.com', historyId: '10' } }))).toBe('baselined');
    expect(store.get('cursors', gmailCursor(project))?.value).toBe('10');
    expect(store.list('sources').filter(source => source.kind === 'email')).toHaveLength(0);
    expect(await scanGmail(store, config, project, engine, remote({
      '/gmail/v1/users/me/profile': { emailAddress: 'owner@example.com', historyId: '11' },
      '/gmail/v1/users/me/history?startHistoryId=10&historyTypes=messageAdded&historyTypes=messageDeleted&maxResults=20': { historyId: '11', history: [{ id: '11', messagesAdded: [{ message: { id: 'm1' } }] }] },
      '/gmail/v1/users/me/messages/m1?format=full': { id: 'm1', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '草稿恢复' }], body: { data: encoded } } },
    }))).toBe('imported');
    expect(store.list('sources').filter(source => source.kind === 'email')).toMatchObject([{ externalId: 'gmail:m1', title: '草稿恢复', content: mail, purpose: 'reference' }]);
    expect(store.list('tasks').filter(task => task.kind !== 'reference_knowledge')).toHaveLength(0);
    expect(store.get('cursors', gmailCursor(project))?.value).toBe('11');
  } finally { await engine.shutdown(); store.close(); }
});

it('withdraws a saved message when Gmail history says it was deleted', async () => {
  const { config, project, store, engine } = setup();
  const encoded = Buffer.from(mail).toString('base64url');
  const history = (start: string) => `/gmail/v1/users/me/history?startHistoryId=${start}&historyTypes=messageAdded&historyTypes=messageDeleted&maxResults=20`;
  try {
    await scanGmail(store, config, project, engine, remote({ '/gmail/v1/users/me/profile': { emailAddress: 'owner@example.com', historyId: '10' } }));
    await scanGmail(store, config, project, engine, remote({
      '/gmail/v1/users/me/profile': { emailAddress: 'owner@example.com', historyId: '11' },
      [history('10')]: { historyId: '11', history: [{ id: '11', messagesAdded: [{ message: { id: 'm1' } }] }] },
      '/gmail/v1/users/me/messages/m1?format=full': { id: 'm1', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '草稿恢复' }], body: { data: encoded } } },
    }));
    const failing: typeof fetch = async () => { throw Error('offline'); };
    await expect(scanGmail(store, config, project, engine, failing)).rejects.toMatchObject({ code: 'remote_unavailable' });
    expect(store.list('sources').find(source => source.kind === 'email' && source.status === 'active')?.content).toBe(mail);
    await scanGmail(store, config, project, engine, remote({
      '/gmail/v1/users/me/profile': { emailAddress: 'owner@example.com', historyId: '12' },
      [history('11')]: { historyId: '12', history: [{ id: '12', messagesDeleted: [{ message: { id: 'm1' } }] }] },
    }));
    expect(store.list('sources').filter(source => source.kind === 'email' && source.status === 'active')).toEqual([]);
    expect(store.list('sources').some(source => source.kind === 'email' && source.status === 'withdrawn' && !source.content.includes('草稿应该还能找回来'))).toBe(true);
    expect(store.get('cursors', gmailCursor(project))?.value).toBe('12');
  } finally { await engine.shutdown(); store.close(); }
});

it('keeps the history cursor when Gmail is unreachable or the first message is paused, and hides the token', async () => {
  const { root, config, project, store, engine } = setup();
  store.save('cursors', { id: gmailCursor(project), projectId: project.id, domain: project.domain, value: '10', updatedAt: now() });
  const failing: typeof fetch = async () => { throw Error('offline'); };
  try {
    await expect(scanGmail(store, config, project, engine, failing)).rejects.toMatchObject({ code: 'remote_unavailable' });
    expect(store.get('cursors', gmailCursor(project))?.value).toBe('10');
    recordMaintenance(store, project, { eventId: randomUUID(), minutes: 90, recordedAt: new Date(Date.now() - 10 * 86400000).toISOString() });
    recordMaintenance(store, project, { eventId: randomUUID(), minutes: 90, recordedAt: new Date(Date.now() - 2 * 86400000).toISOString() });
    await expect(scanGmail(store, config, project, engine, remote({
      '/gmail/v1/users/me/profile': { emailAddress: 'owner@example.com', historyId: '11' },
      '/gmail/v1/users/me/history?startHistoryId=10&historyTypes=messageAdded&historyTypes=messageDeleted&maxResults=20': { historyId: '11', history: [{ id: '11', messagesAdded: [{ message: { id: 'm1' } }] }] },
      '/gmail/v1/users/me/messages/m1?format=full': { id: 'm1', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '草稿恢复' }], body: { data: Buffer.from(mail).toString('base64url') } } },
    }))).rejects.toMatchObject({ code: 'source_expansion_paused' });
    expect(store.get('cursors', gmailCursor(project))?.value).toBe('10');
    expect(store.list('sources').filter(source => source.kind === 'email')).toHaveLength(0);
    saveConnectionSecrets(config, { gmailToken: 'gmail-token-secret' });
    const reloaded = readConfig({ PATRICK_MODE: 'test', PATRICK_HOST: '127.0.0.1', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
    expect(reloaded.gmailToken).toBe('gmail-token-secret');
    const page = await (await createApp({ store, config, engine }).request('/settings')).text();
    expect(page).toContain('Gmail 增量令牌');
    expect(page).not.toContain('gmail-token-secret');
  } finally { await engine.shutdown(); store.close(); }
});
