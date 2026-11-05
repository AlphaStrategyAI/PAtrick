import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import { digest, type Project, type WorkerInput } from '../../src/domain.js';
import { createRuntime } from '../../src/runtime.js';
import { recordDecisionSnapshot } from '../../src/standards.js';

const roots: string[] = [], runtimes: Awaited<ReturnType<typeof createRuntime>>[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(async () => { await Promise.all(runtimes.splice(0).map(r => r.close())); vi.useRealTimers(); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
function config(mode: 'test' | 'demo' = 'test') {
  const root = mkdtempSync(join(tmpdir(), 'outcome-runtime-')); roots.push(root);
  const config = readConfig({ PATRICK_MODE: mode, PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  const project: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'P', description: '', repository: 'a/b', repositoryProvider: 'github', prdPath: 'PRD.md', allowedPaths: ['PRD.md'], trustedChecks: [], trustedAppIds: [], ownerId: config.ownerId, autoMerge: false, budgetUsd: 1, reviewIntervalDays: 7, createdAt: new Date().toISOString() };
  config.projects = [project, { ...project, id: 'other', projectId: 'other', domain: 'work' }]; return config;
}
async function open(c: ReturnType<typeof config>) { const r = await createRuntime(c); runtimes.push(r); return r; }
function judgment(r: Awaited<ReturnType<typeof createRuntime>>, projectId = 'p') {
  const project = r.config.projects.find(p => p.id === projectId)!;
  const task = r.engine.ingest({ projectId, externalId: `idea-${projectId}`, title: 'Test judgment', content: 'Synthetic source', revision: 'v1', retention: 'permanent' })!;
  const input = { task, source: r.store.get('sources', task.sourceId)!, project, role: 'decide', cards: [], facts: [], rules: [] } as WorkerInput;
  r.store.save('attempts', { id: `attempt-${projectId}`, projectId, domain: project.domain, taskId: task.id, taskVersion: task.version, role: 'decide', runner: 'grok', model: 'local-test', provider: 'local-test', inputHash: digest(input), status: 'succeeded', costUsd: 0, startedAt: new Date().toISOString() });
  return recordDecisionSnapshot(r.store, task, input, { action: 'archive', summary: 'Synthetic judgment', rationale: 'Test fixture', citations: [], ruleIds: [] });
}
const reviews = (r: Awaited<ReturnType<typeof createRuntime>>) => r.store.list('actions').filter(a => a.kind === 'decision.review');
it('scans restored judgments on startup without duplicating rounds and honors withdrawal after restart', async () => {
  const c = config(), first = await open(c), snapshot = judgment(first);
  expect(reviews(first)).toHaveLength(0); await first.close();
  vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
  const second = await open(c);
  expect(reviews(second)).toHaveLength(1);
  expect(reviews(second)[0]?.payload.review).toMatchObject({ snapshotId: snapshot.id, checkedAt: '2026-01-10T00:00:00.000Z', status: 'observing', evidence: [] });
  await second.close();
  const third = await open(c); expect(reviews(third)).toHaveLength(1);
  third.engine.withdraw(snapshot.sourceId); await third.close();
  const fourth = await open(c);
  expect(reviews(fourth).flatMap(a => a.payload.review ? [a.payload.review] : [])).toEqual([]);
});
it('owns exactly one minute timer and clears it before closing Store, including repeated close', async () => {
  const r = await open(config()); judgment(r);
  expect(vi.getTimerCount()).toBe(1);
  vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
  vi.advanceTimersByTime(59999); expect(reviews(r)).toHaveLength(0);
  vi.advanceTimersByTime(1); expect(reviews(r)).toHaveLength(1);
  vi.advanceTimersByTime(60000); expect(reviews(r)).toHaveLength(1);
  const closeStore = r.store.close.bind(r.store);
  const close = vi.spyOn(r.store, 'close').mockImplementation(() => { expect(vi.getTimerCount()).toBe(0); closeStore(); });
  await Promise.all([r.close(), r.close()]); expect(close).toHaveBeenCalledTimes(1);
  expect(() => vi.advanceTimersByTime(120000)).not.toThrow(); expect(vi.getTimerCount()).toBe(0);
});
it('offers a local real-time scan scoped to one project and domain', async () => {
  const r = await open(config()); judgment(r); judgment(r, 'other');
  vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
  expect(r.reviewOutcomes({ projectId: 'p', domain: 'personal' })).toBe(1);
  expect(reviews(r)).toHaveLength(1); expect(reviews(r)[0]?.projectId).toBe('p');
  expect(r.reviewOutcomes({ projectId: 'p', domain: 'personal' })).toBe(0);
  expect(r.reviewOutcomes({ projectId: 'other', domain: 'personal' })).toBe(0);
});
it('starts review scheduling with the seeded demo ledger and preserves its judgments on restart', async () => {
  const c = config('demo'), first = await open(c);
  expect(first.store.list('actions').filter(a => a.kind === 'decision.snapshot').length).toBeGreaterThan(0);
  expect(reviews(first)).toHaveLength(0); expect(vi.getTimerCount()).toBe(1);
  await first.close(); vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
  const second = await open(c), count = reviews(second).length;
  expect(count).toBeGreaterThan(0); expect(reviews(second).every(a => (a.payload.review as { status: string }).status === 'observing')).toBe(true);
  await second.close(); const third = await open(c); expect(reviews(third)).toHaveLength(count);
});

it('filters startup, scheduled and explicit runtime scans using the current project owner', async () => {
  const c = config(); c.projects[1]!.ownerId = 'foreign-owner';
  const first = await open(c); judgment(first); judgment(first, 'other'); await first.close();
  vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
  const second = await open(c);
  expect(reviews(second).map(a => a.projectId)).toEqual(['p']);
  expect(second.reviewOutcomes({ projectId: 'other', domain: 'work' })).toBe(0);
  second.store.save('projects', { ...second.store.get('projects', 'p')!, ownerId: 'replacement-owner' });
  vi.setSystemTime(new Date('2026-01-20T00:00:00Z'));
  vi.advanceTimersByTime(60000);
  expect(reviews(second)).toHaveLength(1);
});
it('contains scheduled storage failures, retries next minute and never scans after close', async () => {
  const r = await open(config()); judgment(r);
  vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
  const list = r.store.list.bind(r.store), log = vi.spyOn(console, 'error').mockImplementation(() => {});
  let fail = true;
  const ledger = vi.spyOn(r.store, 'list').mockImplementation(table => { if (table === 'actions' && fail) throw Error('PRIVATE_EVIDENCE_FAILURE'); return list(table); });
  try {
    expect(() => vi.advanceTimersByTime(60000)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_EVIDENCE_FAILURE');
    expect(() => r.reviewOutcomes({ projectId: 'p', domain: 'personal' })).toThrow('PRIVATE_EVIDENCE_FAILURE');
    fail = false; expect(reviews(r)).toHaveLength(0);
    vi.advanceTimersByTime(60000); expect(reviews(r)).toHaveLength(1);
    await r.close(); ledger.mockClear();
    vi.advanceTimersByTime(120000); expect(ledger).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  } finally { ledger.mockRestore(); log.mockRestore(); }
});
