import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { digest, type Project, type WorkerInput } from '../../src/domain.js';
import { Store } from '../../src/store.js';
import { Workbench } from '../../src/orchestrator.js';
import { recordDecisionSnapshot } from '../../src/standards.js';
import { recordOutcomeEvidence } from '../../src/reviews.js';

const stores: Store[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.useRealTimers(); });
function setup() {
  const config = readConfig({ PATRICK_MODE: 'live', PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'P', description: '', repository: 'a/b', repositoryProvider: 'github', prdPath: 'PRD.md', allowedPaths: ['PRD.md'], trustedChecks: [], trustedAppIds: [], ownerId: config.ownerId, autoMerge: false, budgetUsd: 1, reviewIntervalDays: 7, createdAt: new Date().toISOString() };
  config.projects = [project, { ...project, id: 'other', projectId: 'other', domain: 'work' }];
  const store = new Store(':memory:'); stores.push(store);
  config.projects.forEach(p => store.save('projects', p));
  const engine = new Workbench({ store, config, workers: [], writer: { baseline: async () => '', deliver: async () => { throw Error('No remote proof'); } }, research: { research: async () => { throw Error('No research'); } } });
  function judgment(projectId = 'p') {
    const p = config.projects.find(p => p.id === projectId)!;
    const task = engine.ingest({ projectId, externalId: `idea-${projectId}`, revision: 'v1', title: 'Test judgment', content: 'Synthetic original source', retention: 'permanent' })!;
    const input = { task, source: store.get('sources', task.sourceId)!, project: p, role: 'decide', cards: [], rules: [] } as WorkerInput;
    store.save('attempts', { id: `attempt-${projectId}`, projectId, domain: p.domain, taskId: task.id, taskVersion: task.version, role: 'decide', runner: 'grok', model: 'local-test', provider: 'local-test', inputHash: digest(input), status: 'succeeded', costUsd: 0, startedAt: new Date().toISOString() });
    return recordDecisionSnapshot(store, task, input, { action: 'archive', summary: 'Synthetic judgment', rationale: 'Test fixture', citations: [], ruleIds: [] });
  }
  const snapshot = judgment(); judgment('other');
  vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
  const app = createApp({ store, config, engine });
  const headers = { Authorization: `Bearer ${config.authToken}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const post = (path: string, value: unknown) => app.request(path, { method: 'POST', headers, body: JSON.stringify(value) });
  const reference = (extra: Record<string, unknown> = {}) => ({ projectId: 'p', domain: 'personal', externalId: 'reference', revision: 'v1', title: 'Test reference', content: 'Synthetic correction', retention: 'permanent', ...extra });
  return { app, store, config, engine, snapshot, headers, post, reference };
}

describe('owner outcome review HTTP', () => {
  it('imports reference metadata without creating execution tasks and retries idempotently', async () => {
    const f = setup(), before = f.store.list('tasks').length;
    const response = await f.post('/api/reference-sources', f.reference());
    expect(response.status).toBe(200);
    const { source } = await response.json();
    expect(source).toMatchObject({ projectId: 'p', domain: 'personal', kind: 'reading', purpose: 'reference', authorId: f.config.ownerId, retention: 'permanent', revision: 'v1' });
    expect(source).not.toHaveProperty('content');
    expect(f.store.get('sources', source.id)?.content).toBe('Synthetic correction');
    expect((await (await f.post('/api/reference-sources', f.reference())).json()).source).toEqual(source);
    expect(f.store.list('tasks')).toHaveLength(before);
    const replacement = await (await f.post('/api/reference-sources', f.reference({ revision: 'v2', content: 'Revised synthetic correction' }))).json();
    expect(replacement.source.revision).toBe('v2');
    expect(f.store.get('sources', source.id)?.status).toBe('superseded');
  });
  it('preserves imported reference text exactly for later quotations', async () => {
    const f = setup(), content = '  Synthetic reference with whitespace.\n';
    const response = await f.post('/api/reference-sources', f.reference({ content }));
    expect(response.status).toBe(200);
    const { source } = await response.json();
    expect(f.store.get('sources', source.id)?.content).toBe(content);
  });
  it('retains owner authentication, session CSRF and body limits on new routes', async () => {
    const f = setup();
    for (const path of ['/api/reference-sources', `/api/judgments/${f.snapshot.id}/evidence`, '/api/reviews/run']) {
      expect((await f.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    }
    expect((await f.app.request('/api/reviews?project=p&domain=personal')).status).toBe(401);
    const login = await f.app.request('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' }, body: new URLSearchParams({ token: f.config.authToken }) });
    const cookie = login.headers.get('set-cookie')!;
    expect(login.status).toBe(303);
    expect((await f.app.request('/api/reference-sources', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(f.reference()) })).status).toBe(403);
    expect((await f.app.request('/api/reviews?project=p&domain=personal', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await f.post('/api/reference-sources', f.reference({ content: 'x'.repeat(1_100_001) }))).status).toBe(413);
  });
  it('rejects missing reference retention, wrong scope, forged authors and purpose conflicts', async () => {
    const f = setup();
    for (const field of ['retention', 'revision', 'domain']) {
      const value = f.reference(); delete value[field as keyof typeof value];
      expect((await f.post('/api/reference-sources', value)).status).toBe(400);
    }
    for (const extra of [{ projectId: 'missing' }, { domain: 'work' }]) expect((await f.post('/api/reference-sources', f.reference(extra))).status).toBe(404);
    expect((await f.post('/api/reference-sources', f.reference({ authorId: 'intruder' }))).status).toBe(400);
    f.engine.ingest({ projectId: 'p', kind: 'reading', externalId: 'reference', revision: 'v1', title: 'Task source', content: 'Synthetic correction' });
    const conflict = await f.post('/api/reference-sources', f.reference());
    expect(conflict.status).toBe(409); expect((await conflict.json()).code).toBe('purpose_conflict');
  });
  it('records quoted evidence using server owner identity and preserves retry identity', async () => {
    const f = setup();
    f.engine.ingest({ projectId: 'p', kind: 'reading', purpose: 'reference', externalId: 'reference', revision: 'v1', title: 'Test reference', content: 'Synthetic correction', authorId: f.config.ownerId });
    const source = f.store.list('sources').find(s => s.externalId === 'reference')!;
    const value = { projectId: 'p', domain: 'personal', kind: 'correction', sourceId: source.id, sourceRevision: source.revision, quote: 'Synthetic correction', observedAt: '2026-01-09T00:00:00.000Z' };
    const response = await f.post(`/api/judgments/${f.snapshot.id}/evidence`, value);
    expect(response.status).toBe(200); const { evidence } = await response.json();
    expect(evidence).toMatchObject({ snapshotId: f.snapshot.id, actorId: f.config.ownerId, authorId: f.config.ownerId, recordedAt: '2026-01-10T00:00:00.000Z' });
    expect((await (await f.post(`/api/judgments/${f.snapshot.id}/evidence`, value)).json()).evidence).toEqual(evidence);
    for (const extra of [{ actorId: 'intruder' }, { authorId: 'intruder' }, { at: '2099-01-01T00:00:00Z' }, { recordedAt: '2099-01-01T00:00:00Z' }]) expect((await f.post(`/api/judgments/${f.snapshot.id}/evidence`, { ...value, ...extra })).status).toBe(400);
    expect((await f.post(`/api/judgments/${f.snapshot.id}/evidence`, { ...value, domain: 'work' })).status).toBe(400);
    expect((await f.post(`/api/judgments/${f.snapshot.id}/evidence`, { ...value, observedAt: '2099-01-01T00:00:00Z' })).status).toBe(400);
  });
  it('rejects malformed numeric metric evidence and ephemeral evidence for a permanent judgment', async () => {
    const f = setup();
    const quote = JSON.stringify({ schemaVersion: 1, name: 'fixture metric', value: '12', unit: 'events', sampleSize: 10, periodStart: f.snapshot.recordedAt, periodEnd: '2026-01-09T00:00:00.000Z' });
    f.engine.ingest({ projectId: 'p', kind: 'reading', purpose: 'reference', externalId: 'reference', revision: 'v1', title: 'Test metric', content: quote });
    const source = f.store.list('sources').find(s => s.externalId === 'reference')!;
    expect((await f.post(`/api/judgments/${f.snapshot.id}/evidence`, { projectId: 'p', domain: 'personal', kind: 'metric', sourceId: source.id, sourceRevision: source.revision, quote, observedAt: '2026-01-09T00:00:00.000Z' })).status).toBe(400);
    const temp = await (await f.post('/api/reference-sources', f.reference({ externalId: 'temp', retention: 'ephemeral' }))).json();
    expect(temp.source.retention).toBe('ephemeral');
    expect((await f.post(`/api/judgments/${f.snapshot.id}/evidence`, { projectId: 'p', domain: 'personal', kind: 'correction', sourceId: temp.source.id, sourceRevision: temp.source.revision, quote: 'Synthetic correction', observedAt: '2026-01-09T00:00:00.000Z' })).status).toBe(409);
    expect(f.store.list('actions').filter(a => a.kind === 'decision.evidence')).toEqual([]);
  });
  it.each(['read', 'run'] as const)('rejects %s of populated foreign-owner reviews before ledger writes', async operation => {
    const f = setup(), project = f.store.get('projects', 'other')!;
    f.store.save('projects', { ...project, ownerId: 'foreign-owner' });
    const snapshot = f.store.list('actions').find(a => a.kind === 'decision.snapshot' && a.projectId === 'other')!;
    const source = f.store.list('sources').find(s => s.projectId === 'other')!;
    recordOutcomeEvidence(f.store, f.config, snapshot.id, { projectId: 'other', domain: 'work', kind: 'correction', sourceId: source.id, sourceRevision: source.revision, quote: source.content, observedAt: '2026-01-09T00:00:00.000Z' }, 'foreign-owner');
    const before = f.store.list('actions');
    const response = operation === 'read' ? await f.app.request('/api/reviews?project=other&domain=work', { headers: f.headers }) : await f.post('/api/reviews/run', { projectId: 'other', domain: 'work' });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(source.content);
    expect(f.store.list('actions')).toEqual(before);
  });
  it('keeps explicit scan failures visible without including raw error content', async () => {
    const f = setup(), original = f.store.list.bind(f.store);
    const failure = vi.spyOn(f.store, 'list').mockImplementation(table => { if (table === 'actions') throw Error('PRIVATE_EVIDENCE_FAILURE'); return original(table); });
    try {
      const response = await f.post('/api/reviews/run', { projectId: 'p', domain: 'personal' });
      expect(response.status).toBe(500); expect(await response.text()).not.toContain('PRIVATE_EVIDENCE_FAILURE');
    } finally { failure.mockRestore(); }
  });
  it('accepts an owner-triggered scoped review scan', async () => {
    const f = setup();
    expect((await f.post('/api/reviews/run', { projectId: 'p', domain: 'personal' })).status).toBe(200);
  });
  it('lists and scans only the requested valid scope with server time, keeping absent measurements observing', async () => {
    const f = setup(), path = '/api/reviews?project=p&domain=personal';
    const initial = await f.app.request(path, { headers: f.headers }); expect(initial.status).toBe(200);
    expect((await initial.json()).reviews).toMatchObject([{ snapshotId: f.snapshot.id, evidence: [] }]);
    const response = await f.post('/api/reviews/run', { projectId: 'p', domain: 'personal' }); expect(response.status).toBe(200);
    const { reviews } = await response.json();
    expect(reviews).toHaveLength(1); expect(reviews[0].latestReview).toMatchObject({ status: 'observing', checkedAt: '2026-01-10T00:00:00.000Z', evidence: [] });
    expect(reviews[0].latestReview.gaps).toContain('No current quoted measurement.');
    await f.post('/api/reviews/run', { projectId: 'p', domain: 'personal' });
    expect(f.store.list('actions').filter(a => a.kind === 'decision.review')).toHaveLength(1);
    for (const extra of [{ at: '2099-01-01T00:00:00Z' }, { now: '2099-01-01T00:00:00Z' }, { actorId: 'intruder' }]) expect((await f.post('/api/reviews/run', { projectId: 'p', domain: 'personal', ...extra })).status).toBe(400);
    for (const query of ['project=missing&domain=personal', 'project=p&domain=work', 'project=p', 'domain=personal']) expect((await f.app.request(`/api/reviews?${query}`, { headers: f.headers })).status).toBe(404);
    for (const scope of [{ projectId: 'missing', domain: 'personal' }, { projectId: 'p', domain: 'work' }]) expect((await f.post('/api/reviews/run', scope)).status).toBe(404);
    expect((await f.post('/api/reviews/run', {})).status).toBe(400);
  });
});

describe('project review interval HTTP', () => {
  const project = { name: 'Interval test', repository: 'owner/repo', prdPath: 'PRD.md', allowedPaths: ['PRD.md'] };
  it.each([1, 30, 365])('persists JSON review interval %s', async reviewIntervalDays => {
    const f = setup(), response = await f.post('/api/projects', { ...project, reviewIntervalDays }); expect(response.status).toBe(200);
    const data = await response.json(); expect(data.project.reviewIntervalDays).toBe(reviewIntervalDays); expect(f.store.get('projects', data.project.id)?.reviewIntervalDays).toBe(reviewIntervalDays);
  });
  it.each([0, 1.5, 366, '14', 'NaN', '', null, true, [], {}])('rejects invalid JSON review interval %j', async reviewIntervalDays => {
    const f = setup(); expect((await f.post('/api/projects', { ...project, reviewIntervalDays })).status).toBe(400);
  });
  it.each([['14', 14], ['', 7], ['   ', 7]])('accepts numeric or blank form interval %j', async (reviewIntervalDays, expected) => {
    const f = setup(), response = await f.app.request('/api/projects', { method: 'POST', headers: { Authorization: f.headers.Authorization, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...project, allowedPaths: 'PRD.md', reviewIntervalDays }) });
    expect(response.status).toBe(200); expect((await response.json()).project.reviewIntervalDays).toBe(expected);
  });
  it.each(['0', '1.5', '366', 'nope'])('rejects invalid form interval %j', async reviewIntervalDays => {
    const f = setup(); expect((await f.app.request('/api/projects', { method: 'POST', headers: { Authorization: f.headers.Authorization, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...project, allowedPaths: 'PRD.md', reviewIntervalDays }) })).status).toBe(400);
  });
  it('keeps the seven-day default when interval is omitted', async () => {
    const f = setup(); expect((await (await f.post('/api/projects', project)).json()).project.reviewIntervalDays).toBe(7);
  });
});
