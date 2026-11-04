import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ingestSource, withdrawSource } from '../../src/intake.js';
import { recordDecisionSnapshot } from '../../src/standards.js';
import { outcomeReviewViews, recordOutcomeEvidence, runOutcomeReviews } from '../../src/reviews.js';
import { readConfig } from '../../src/config.js';
import { configureDemo, DemoWorker, demoResearch, demoWriter } from '../../src/demo.js';
import { Workbench } from '../../src/orchestrator.js';
import { createApp } from '../../src/app.js';
import { digest, stableId, WorkerUnavailable, type DecisionSnapshot, type SourceRevision, type WorkerInput, type WorkerAdapter } from '../../src/domain.js';
const roots: string[] = [], stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function setup(temporary = false) {
  const root = mkdtempSync(join(tmpdir(), 'outcome-cross-')); roots.push(root);
  const db = join(root, 'db'), vault = join(root, 'vault'), store = new Store(db, vault); stores.push(store);
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'synthetic-owner-token-at-least-32-characters' });
  configureDemo(config); const project = { ...config.projects[0]!, reviewIntervalDays: 1 }; config.projects = [project];
  const task = ingestSource(store, config, { projectId: project.id, externalId: 'subject', title: 'Subject', content: 'Original judgment', retention: temporary ? 'ephemeral' : 'permanent' })!;
  const input = { task, source: store.get('sources', task.sourceId)!, project, role: 'decide', cards: [], rules: [] } as WorkerInput;
  store.save('attempts', { id: 'deciding', projectId: project.id, domain: project.domain, taskId: task.id, taskVersion: task.version, role: 'decide', runner: 'grok', model: 'local', provider: 'local', inputHash: digest(input), status: 'succeeded', costUsd: 0, startedAt: new Date().toISOString() });
  const snapshot = recordDecisionSnapshot(store, task, input, { action: 'proceed', summary: 'Judgment', rationale: 'Reason', citations: [], ruleIds: [] });
  return { root, db, vault, store, config, project, task, snapshot };
}
function path(f: ReturnType<typeof setup>, s: SourceRevision) { return join(f.vault, encodeURIComponent(s.projectId), s.domain, 'sources', `${s.id}.md`); }
function edit(f: ReturnType<typeof setup>, s: SourceRevision, text: string, remove = false) {
  const original = readFileSync(path(f, s), 'utf8');
  writeFileSync(path(f, s), `${remove ? original.replace(/^---\n[\s\S]*?\n---\n/, '') : original.replace(/^patrick_entity: (.+)$/m, (_, raw) => { const row = JSON.parse(raw); delete row.parentSources; row.purpose = 'task'; return `patrick_entity: ${JSON.stringify(row)}`; })}\n${text}\n`);
  f.store.rebuildIndex();
}
function reference(f: ReturnType<typeof setup>) {
  ingestSource(f.store, f.config, { projectId: f.project.id, externalId: 'reference', kind: 'reading', purpose: 'reference', title: 'Original reference', content: 'prelude original metric fragment trailing context' });
  return f.store.list('sources').find(s => s.externalId === 'reference')!;
}
function quote(f: ReturnType<typeof setup>, s: SourceRevision) {
  return recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { projectId: f.project.id, domain: f.project.domain, kind: 'correction', sourceId: s.id, sourceRevision: s.revision, quote: 'original metric fragment', observedAt: f.snapshot.recordedAt }, f.config.ownerId, new Date(f.snapshot.reviewAt!));
}
it('withdraws partial copied evidence through historical and nested Vault edits across repeated restart', () => {
  const f = setup(), origin = reference(f); edit(f, origin, 'First annotation');
  const first = f.store.list('sources').find(s => s.kind === 'file')!;
  edit(f, first, 'Deeper annotation'); const deep = f.store.list('sources').find(s => s.kind === 'file' && s.externalId.endsWith(`${first.id}.md`))!;
  quote(f, deep); runOutcomeReviews(f.store, new Date(f.snapshot.reviewAt!));
  edit(f, origin, 'Second annotation');
  // Frontmatter is an editable projection, including complete removal.
  writeFileSync(path(f, first), readFileSync(path(f, first), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''));
  withdrawSource(f.store, origin.id);
  expect(f.store.list('sources').filter(s => s.kind === 'file').every(s => s.status === 'withdrawn' && !s.content)).toBe(true);
  expect(JSON.stringify(f.store.list('actions'))).not.toContain('original metric fragment');
  f.store.close();
  for (let round = 0; round < 2; round++) {
    const next = new Store(f.db, f.vault); stores.push(next);
    runOutcomeReviews(next, new Date(f.snapshot.reviewAt!));
    const view = outcomeReviewViews(next, f.project, new Date(f.snapshot.reviewAt!))[0]!;
    expect(view.evidence).toEqual([]); expect(view.latestReview?.evidence).toEqual([]);
    expect(next.list('tasks')).toHaveLength(1);
    expect(JSON.stringify(next.list('sources')) + JSON.stringify(next.list('actions'))).not.toContain('original metric fragment');
    for (const filename of readdirSync(f.vault, { recursive: true }).map(String).filter(p => p.endsWith('.md'))) expect(readFileSync(join(f.vault, filename), 'utf8')).not.toContain('original metric fragment');
    next.close();
  }
});
it('makes dependent copied text obsolete when its parent revision is superseded', () => {
  const f = setup(), origin = reference(f); edit(f, origin, 'Annotation');
  const child = f.store.list('sources').find(s => s.kind === 'file')!; quote(f, child); runOutcomeReviews(f.store, new Date(f.snapshot.reviewAt!));
  ingestSource(f.store, f.config, { projectId: f.project.id, kind: 'reading', purpose: 'reference', externalId: origin.externalId, title: 'Replacement', content: 'New corrected material' });
  expect(() => quote(f, child)).toThrow();
  expect(outcomeReviewViews(f.store, f.project, new Date(f.snapshot.reviewAt!))[0]?.evidence).toEqual([]);
});
it('scopes explicit and aggregate state and rejects foreign withdrawal without changing any dependent bytes', async () => {
  const f = setup(), origin = reference(f); quote(f, origin); runOutcomeReviews(f.store, new Date(f.snapshot.reviewAt!));
  const engine = new Workbench({ store: f.store, config: f.config, workers: [], writer: demoWriter, research: demoResearch });
  const app = createApp({ store: f.store, config: f.config, engine });
  const headers = { Authorization: `Bearer ${f.config.authToken}`, Accept: 'application/json' };
  expect((await app.request(`/api/state?project=${f.project.id}`, { headers })).status).toBe(200);
  const owned = { ...f.project, id: 'owned', projectId: 'owned', name: 'OWNED ACCESSIBLE PROJECT' }; f.store.save('projects', owned);
  f.store.save('projects', { ...f.project, ownerId: 'foreign-owner', name: 'PRIVATE FOREIGN PROJECT' });
  const before = JSON.stringify({ sources: f.store.list('sources'), actions: f.store.list('actions'), tasks: f.store.list('tasks') });
  expect((await app.request(`/api/state?project=${f.project.id}`, { headers })).status).toBe(403);
  const aggregate = await (await app.request('/api/state', { headers })).text();
  expect(aggregate).toContain('OWNED ACCESSIBLE PROJECT');
  expect((await app.request('/api/state?project=owned', { headers })).status).toBe(200);
  expect(aggregate).not.toContain('PRIVATE FOREIGN PROJECT'); expect(aggregate).not.toContain(origin.id); expect(aggregate).not.toContain('Original reference');
  expect((await app.request(`/api/sources/${origin.id}/withdraw`, { method: 'POST', headers })).status).toBe(403);
  expect(JSON.stringify({ sources: f.store.list('sources'), actions: f.store.list('actions'), tasks: f.store.list('tasks') })).toBe(before);
  expect((await app.request(`/api/tasks/${f.task.id}`, { headers })).status).toBe(403);
  expect((await app.request('/api/tasks', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: f.project.id, title: 'Injected', content: 'private mutation' }) })).status).toBe(403);
  expect((await app.request(`/api/tasks/${f.task.id}/cancel`, { method: 'POST', headers })).status).toBe(403);
  expect((await app.request(`/api/tasks/${f.task.id}/retry`, { method: 'POST', headers })).status).toBe(403);
  expect((await app.request(`/api/lookup?project=${f.project.id}&domain=${f.project.domain}&q=Original`, { headers })).status).toBe(403);
  expect((await app.request(`/api/reports/weekly?project=${f.project.id}`, { headers })).status).toBe(403);
  const forbiddenHtml = await app.request(`/api/sources/${origin.id}/withdraw`, { method: 'POST', headers: { ...headers, Accept: 'text/html' } });
  expect(forbiddenHtml.status).toBe(403); expect(await forbiddenHtml.text()).not.toContain('Original reference');
  expect(JSON.stringify({ sources: f.store.list('sources'), actions: f.store.list('actions'), tasks: f.store.list('tasks') })).toBe(before);
  f.store.save('projects', f.project);
  expect((await app.request(`/api/sources/${origin.id}/withdraw`, { method: 'POST', headers })).status).toBe(200);
  expect(f.store.get('sources', origin.id)?.status).toBe('withdrawn');
});
it('retains accepted failed planned tests after repair and delivery before the first due review', async () => {
  const f = setup(); f.store.save('tasks', { ...f.task, runAfter: '2099-01-01T00:00:00.000Z' });
  let checks = 0;
  const workers: WorkerAdapter[] = (['grok', 'dsh', 'codex'] as const).map(name => ({ name, async run(input) {
    const result = await new DemoWorker(name).run(input);
    if (input.role === 'check' && ++checks === 1) { const output = result.output as any; output.verdict = 'repair'; output.tests[0].passed = false; output.tests[0].output = 'FAILED_PLANNED_CHECK_SENTINEL'; }
    return result;
  } }));
  const engine = new Workbench({ store: f.store, config: f.config, workers, writer: demoWriter, research: demoResearch });
  const task = engine.ingest({ projectId: f.project.id, externalId: 'repair', title: 'Repair', content: 'Local example' })!;
  await engine.runUntilIdle(100); expect(f.store.get('tasks', task.id)?.status).toBe('delivered'); expect(checks).toBe(2);
  const snapshot = f.store.list('actions').find(a => a.taskId === task.id && a.kind === 'decision.snapshot')!.payload.snapshot as DecisionSnapshot;
  const at = new Date(snapshot.reviewAt!); runOutcomeReviews(f.store, at);
  const review = outcomeReviewViews(f.store, f.project, at).find(v => v.taskId === task.id)!.latestReview!;
  expect(review.failedTests).toEqual([expect.objectContaining({ passed: false, output: 'FAILED_PLANNED_CHECK_SENTINEL' })]);
  expect(review.status).toBe('observing'); expect(runOutcomeReviews(f.store, at)).toBe(0);
  const ledger = JSON.stringify(f.store.list('actions')); f.store.close(); const next = new Store(f.db, f.vault); stores.push(next);
  expect(runOutcomeReviews(next, at)).toBe(0); expect(JSON.stringify(next.list('actions'))).toBe(ledger);
  expect(outcomeReviewViews(next, f.project, at).find(v => v.taskId === f.task.id)?.latestReview?.failedTests).toEqual([]);
  withdrawSource(next, task.sourceId); expect(JSON.stringify(next.list('actions'))).not.toContain('FAILED_PLANNED_CHECK_SENTINEL');
});

it.each(['withdrawn', 'superseded'] as const)('backfills legacy Vault dependencies from host paths with a %s parent despite forged frontmatter', status => {
  const f = setup(), origin = reference(f); edit(f, origin, 'Legacy annotation');
  const child = f.store.list('sources').find(s => s.kind === 'file')!; quote(f, child); runOutcomeReviews(f.store, new Date(f.snapshot.reviewAt!));
  // Simulate a ledger predating the additive provenance field, plus a stale active child.
  f.store.save('sources', { ...child, parentSources: undefined });
  f.store.save('sources', { ...origin, status });
  const text = readFileSync(path(f, child), 'utf8').replace(/^patrick_entity: (.+)$/m, (_, raw) => {
    const row = JSON.parse(raw); row.parentSources = [{ id: f.task.sourceId, revision: f.task.sourceRevision }]; return `patrick_entity: ${JSON.stringify(row)}`;
  });
  writeFileSync(path(f, child), text); f.store.close();
  const next = new Store(f.db, f.vault); stores.push(next);
  const restored = next.get('sources', child.id)!;
  expect(restored.parentSources).toEqual([{ id: origin.id, revision: origin.revision }]);
  const at = new Date(f.snapshot.reviewAt!);
  expect(outcomeReviewViews(next, f.project, at)[0]?.evidence).toEqual([]);
  expect(() => recordOutcomeEvidence(next, f.config, f.snapshot.id, { projectId: f.project.id, domain: f.project.domain, kind: 'correction', sourceId: child.id, sourceRevision: child.revision, quote: 'original metric fragment', observedAt: f.snapshot.recordedAt }, f.config.ownerId, at)).toThrow();
  if (status === 'withdrawn') expect(JSON.stringify(next.list('actions')) + JSON.stringify(next.list('sources'))).not.toContain('original metric fragment');
});
function demoEngine(f: ReturnType<typeof setup>, change: (input: WorkerInput, output: any) => void) {
  f.store.save('tasks', { ...f.task, runAfter: '2099-01-01T00:00:00.000Z' });
  const workers: WorkerAdapter[] = (['grok', 'dsh', 'codex'] as const).map(name => ({ name, async run(input) {
    const result = await new DemoWorker(name).run(input); change(input, result.output); return result;
  } }));
  return new Workbench({ store: f.store, config: f.config, workers, writer: demoWriter, research: demoResearch });
}
it('records accepted execution failures while ignoring unplanned results and isolates later judgment versions', async () => {
  const f = setup(); let executions = 0;
  const engine = demoEngine(f, (input, output) => {
    if (input.role === 'execute' && ++executions === 1) { output.tests[0].passed = false; output.tests[0].output = 'FAILED_EXECUTION_SENTINEL'; output.tests.push({ command: 'unplanned', passed: false, output: 'UNPLANNED_SENTINEL' }); }
  });
  const original = engine.ingest({ projectId: f.project.id, externalId: 'execution-failure', title: 'Execution failure', content: 'Local example' })!;
  await engine.runUntilIdle(100); const task = f.store.get('tasks', original.id)!; expect(task.status).toBe('delivered');
  const snapshot = f.store.list('actions').find(a => a.taskId === task.id && a.kind === 'decision.snapshot')!.payload.snapshot as DecisionSnapshot;
  const at = new Date(snapshot.reviewAt!); runOutcomeReviews(f.store, at);
  const review = outcomeReviewViews(f.store, f.project, at).find(v => v.snapshotId === snapshot.id)!.latestReview!;
  expect(review.failedTests.map(t => t.output)).toEqual(['FAILED_EXECUTION_SENTINEL']);
  const observations = f.store.list('actions').filter(a => a.kind === 'decision.tests'); expect(observations).toHaveLength(1);
  expect(observations[0]?.payload.testObservation).toMatchObject({ snapshotId: snapshot.id, taskVersion: 1, stage: 'execute', attemptId: expect.any(String) });
  expect(JSON.stringify(observations)).not.toContain('UNPLANNED_SENTINEL');
  const later = { ...task, version: 2, decisionSnapshotId: undefined, plan: undefined, artifact: undefined, review: undefined };
  f.store.save('tasks', later);
  const input = { task: later, source: f.store.get('sources', later.sourceId)!, project: f.project, role: 'decide', cards: [], rules: [] } as WorkerInput;
  f.store.save('attempts', { id: 'later-deciding', projectId: task.projectId, domain: task.domain, taskId: task.id, taskVersion: 2, role: 'decide', runner: 'grok', model: 'local', provider: 'local', inputHash: digest(input), status: 'succeeded', costUsd: 0, startedAt: new Date().toISOString() });
  const second = recordDecisionSnapshot(f.store, later, input, { action: 'proceed', summary: 'Later judgment', rationale: 'New version', citations: [], ruleIds: [] });
  f.store.save('tasks', { ...later, decisionSnapshotId: second.id });
  const secondDue = new Date(second.reviewAt!); runOutcomeReviews(f.store, secondDue);
  expect(outcomeReviewViews(f.store, f.project, secondDue).find(v => v.snapshotId === second.id)?.latestReview?.failedTests).toEqual([]);
  expect(outcomeReviewViews(f.store, f.project, secondDue).find(v => v.snapshotId === snapshot.id)?.latestReview?.failedTests.map(t => t.output)).toEqual(['FAILED_EXECUTION_SENTINEL']);
});
it('does not turn unavailable check transports into failed product tests', async () => {
  const f = setup(), engine = demoEngine(f, (input) => { if (input.role === 'check') throw new WorkerUnavailable('CONNECTION_FAILURE_SENTINEL'); });
  const task = engine.ingest({ projectId: f.project.id, externalId: 'transport', title: 'Transport', content: 'Local example' })!;
  await engine.runUntilIdle(100); expect(f.store.get('tasks', task.id)?.status).toBe('blocked');
  const snapshot = f.store.list('actions').find(a => a.taskId === task.id && a.kind === 'decision.snapshot')!.payload.snapshot as DecisionSnapshot;
  const at = new Date(snapshot.reviewAt!); runOutcomeReviews(f.store, at);
  expect(f.store.list('actions').filter(a => a.kind === 'decision.tests')).toEqual([]);
  const review = outcomeReviewViews(f.store, f.project, at).find(v => v.snapshotId === snapshot.id)?.latestReview;
  expect(review?.failedTests).toEqual([]); expect(review?.status).toBe('observing');
});
it('keeps failed-test history of temporary tasks out of SQLite and Vault across restart', async () => {
  const f = setup(); let checks = 0;
  const engine = demoEngine(f, (input, output) => { if (input.role === 'check' && ++checks === 1) { output.verdict = 'repair'; output.tests[0].passed = false; output.tests[0].output = 'TEMPORARY_FAILED_TEST_SECRET'; } });
  const task = engine.ingest({ projectId: f.project.id, externalId: 'temporary-failure', title: 'Temporary failure', content: 'Local temporary example', retention: 'ephemeral' })!;
  await engine.runUntilIdle(100); expect(f.store.get('tasks', task.id)?.status).toBe('delivered');
  const snapshot = f.store.list('actions').find(a => a.taskId === task.id && a.kind === 'decision.snapshot')!.payload.snapshot as DecisionSnapshot;
  const at = new Date(snapshot.reviewAt!); runOutcomeReviews(f.store, at);
  expect(outcomeReviewViews(f.store, f.project, at).find(v => v.taskId === task.id)?.latestReview?.failedTests[0]?.output).toBe('TEMPORARY_FAILED_TEST_SECRET');
  f.store.close();
  for (const filename of readdirSync(f.root, { recursive: true }).map(String).filter(p => p.endsWith('.md') || p === 'db' || p.endsWith('-wal'))) expect(readFileSync(join(f.root, filename)).includes(Buffer.from('TEMPORARY_FAILED_TEST_SECRET'))).toBe(false);
  const next = new Store(f.db, f.vault); stores.push(next);
  expect(outcomeReviewViews(next, f.project, at).some(v => v.taskId === task.id)).toBe(false);
  expect(JSON.stringify(next.list('actions'))).not.toContain('TEMPORARY_FAILED_TEST_SECRET');
});
it('withdraws copies of case projections when the owner-answer source is withdrawn', async () => {
  const { recordOwnerDecision } = await import('../../src/standards.js');
  const f = setup(), option = { label: 'Keep', description: 'prelude original metric fragment trailing context', rationale: 'Recovery', tradeoff: 'Storage', evidenceUrls: [] };
  const question = { id: 'projection-question', projectId: f.project.id, domain: f.project.domain, taskId: f.task.id, taskVersion: 1, version: 1, ownerId: f.config.ownerId, title: 'Keep?', context: 'Choice', options: { A: option, B: { ...option, label: 'Delete' } }, research: { queries: [], summary: '', gaps: [] }, status: 'answered' as const, createdAt: f.snapshot.recordedAt, decisionSnapshotId: f.snapshot.id, answer: { choice: 'A' as const, text: option.description, actorId: f.config.ownerId, eventId: 'projection-answer' } };
  f.store.save('questions', question);
  const decisionCase = recordOwnerDecision(f.store, f.task, question, { questionId: question.id, taskVersion: 1, questionVersion: 1, choice: 'A', actorId: f.config.ownerId, eventId: 'projection-answer' });
  f.store.save('questions', { ...question, answer: { ...question.answer, text: decisionCase.originalWords } });
  const casePath = join(f.vault, f.project.id, f.project.domain, 'cases', `${decisionCase.id}.md`);
  writeFileSync(casePath, `${readFileSync(casePath, 'utf8')}\nIndependent case annotation.\n`); f.store.rebuildIndex();
  const child = f.store.list('sources').find(s => s.externalId.endsWith(`/cases/${decisionCase.id}.md`))!;
  expect(child).toBeDefined();
  withdrawSource(f.store, decisionCase.sourceId);
  expect(f.store.get('sources', child.id)).toMatchObject({ status: 'withdrawn', content: '' });
});
it('does not recover readable orphan Vault copies from a newer projection than the trusted ledger', async () => {
  const f = setup(), origin = reference(f), olderDb = join(f.root, 'older-db');
  await f.store.backup(olderDb);
  edit(f, origin, 'Newer Vault-only annotation');
  const child = f.store.list('sources').find(s => s.kind === 'file')!;
  // The older host ledger cannot authenticate any ancestry embedded in the newer child projection.
  f.store.close(); const older = new Store(olderDb); stores.push(older); withdrawSource(older, origin.id); older.close();
  const restored = new Store(olderDb, f.vault); stores.push(restored);
  expect(restored.get('sources', child.id)?.content ?? '').not.toContain('original metric fragment');
  expect(restored.get('sources', child.id)?.status).not.toBe('active');
  expect(restored.list('tasks')).toHaveLength(1);
});
it('retains failed checks after a baseline replan changes execution version under the original judgment', async () => {
  const f = setup(); f.store.save('tasks', { ...f.task, runAfter: '2099-01-01T00:00:00.000Z' });
  let baselines = 0, checks = 0;
  const workers: WorkerAdapter[] = (['grok', 'dsh', 'codex'] as const).map(name => ({ name, async run(input) {
    const result = await new DemoWorker(name).run(input);
    if (input.role === 'check' && ++checks === 1) { const output = result.output as any; output.verdict = 'repair'; output.tests[0].passed = false; output.tests[0].output = 'REPLANNED_CHECK_FAILURE'; }
    return result;
  } }));
  const engine = new Workbench({ store: f.store, config: f.config, workers, writer: { ...demoWriter, baseline: async () => ++baselines === 1 ? 'first-baseline' : 'second-baseline' }, research: demoResearch });
  const task = engine.ingest({ projectId: f.project.id, externalId: 'replan-failure', title: 'Replan', content: 'Local example' })!;
  await engine.runUntilIdle(100);
  expect(f.store.get('tasks', task.id)).toMatchObject({ status: 'delivered', version: 2 });
  const snapshot = f.store.list('actions').find(a => a.taskId === task.id && a.kind === 'decision.snapshot')!.payload.snapshot as DecisionSnapshot;
  expect(snapshot.taskVersion).toBe(1);
  const at = new Date(snapshot.reviewAt!); runOutcomeReviews(f.store, at);
  expect(outcomeReviewViews(f.store, f.project, at).find(v => v.snapshotId === snapshot.id)?.latestReview?.failedTests.map(t => t.output)).toEqual(['REPLANNED_CHECK_FAILURE']);
});

it.each(['kind', 'externalId', 'revision'] as const)('rejects a missing-row Vault copy whose editable %s disagrees with its host identity', async field => {
  const f = setup(), origin = reference(f), olderDb = join(f.root, 'identity-older-db');
  await f.store.backup(olderDb); edit(f, origin, 'Newer annotated copy');
  const child = f.store.list('sources').find(s => s.kind === 'file')!;
  writeFileSync(path(f, child), readFileSync(path(f, child), 'utf8').replace(/^patrick_entity: (.+)$/m, (_, raw) => {
    const row = JSON.parse(raw); row[field] = field === 'kind' ? 'reading' : field === 'externalId' ? 'independent-reference' : 'forged-revision';
    return `patrick_entity: ${JSON.stringify(row)}`;
  }));
  f.store.close(); const older = new Store(olderDb); stores.push(older); withdrawSource(older, origin.id); older.close();
  for (let restart = 0; restart < 2; restart++) {
    const recovered = new Store(olderDb, f.vault); stores.push(recovered);
    expect(recovered.get('sources', origin.id)?.status).toBe('withdrawn');
    expect(recovered.get('sources', child.id)).toMatchObject({ status: 'withdrawn', content: '' });
    expect(readFileSync(path(f, child), 'utf8')).not.toContain('original metric fragment');
    const at = new Date(f.snapshot.reviewAt!);
    expect(() => recordOutcomeEvidence(recovered, f.config, f.snapshot.id, { projectId: f.project.id, domain: f.project.domain, kind: 'correction', sourceId: child.id, sourceRevision: child.revision, quote: 'original metric fragment', observedAt: f.snapshot.recordedAt }, f.config.ownerId, at)).toThrow();
    recovered.rebuildIndex(); recovered.rebuildIndex(); runOutcomeReviews(recovered, at);
    expect(outcomeReviewViews(recovered, f.project, at)[0]?.evidence).toEqual([]);
    expect(JSON.stringify(recovered.list('sources')) + JSON.stringify(recovered.list('actions'))).not.toContain('original metric fragment');
    expect(recovered.list('tasks')).toHaveLength(1); recovered.close();
  }
});
it.each([true, false])('recovers a missing owner-answer identity only with independent accepted-question binding (bound=%s)', async bound => {
  const { recordOwnerDecision } = await import('../../src/standards.js');
  const f = setup(), option = { label: 'Keep', description: 'OWNER_ANSWER_RECOVERY_SENTINEL', rationale: 'Recovery', tradeoff: 'Storage', evidenceUrls: [] };
  const question = { id: 'bound-owner-answer', projectId: f.project.id, domain: f.project.domain, taskId: f.task.id, taskVersion: 1, version: 1, ownerId: f.config.ownerId, title: 'Keep?', context: 'Choice', options: { A: option, B: { ...option, label: 'Delete' } }, research: { queries: [], summary: '', gaps: [] }, status: 'answered' as const, createdAt: f.snapshot.recordedAt, decisionSnapshotId: f.snapshot.id };
  const decisionCase = recordOwnerDecision(f.store, f.task, question, { questionId: question.id, taskVersion: 1, questionVersion: 1, choice: 'A', actorId: f.config.ownerId, eventId: 'bound-answer-event' });
  if (bound) f.store.save('questions', { ...question, answer: { choice: 'A', text: decisionCase.originalWords, actorId: f.config.ownerId, eventId: 'bound-answer-event' } });
  const source = f.store.get('sources', decisionCase.sourceId)!, projection = readFileSync(path(f, source), 'utf8');
  f.store.close(); const ledger = new Store(f.db); stores.push(ledger); ledger.delete('sources', source.id); ledger.close(); writeFileSync(path(f, source), projection);
  const next = new Store(f.db, f.vault); stores.push(next);
  if (bound) expect(next.get('sources', source.id)).toMatchObject({ status: 'active', kind: 'conversation', externalId: `answer:${question.id}`, revision: source.revision, content: decisionCase.originalWords });
  else { expect(next.get('sources', source.id)).toMatchObject({ status: 'withdrawn', content: '' }); expect(readFileSync(path(f, source), 'utf8')).not.toContain('OWNER_ANSWER_RECOVERY_SENTINEL'); }
});

it.each([true, false])('preserves accepted answers when both source rows need recovery (answer sorts first=%s)', answerFirst => {
  const f = setup(), engine = new Workbench({ store: f.store, config: f.config, workers: [], writer: demoWriter, research: demoResearch });
  const questionId = Array.from({ length: 1000 }, (_, index) => `recovery-order-${index}`).find(id => (stableId('owner-answer', id) < f.task.sourceId) === answerFirst)!;
  expect(questionId).toBeDefined();
  const option = { label: 'Keep', description: 'ACCEPTED_RECOVERY_ORDER_SENTINEL', rationale: 'Recovery', tradeoff: 'Storage', evidenceUrls: [] };
  const question = { id: questionId, projectId: f.project.id, domain: f.project.domain, taskId: f.task.id, taskVersion: 1, version: 1, ownerId: f.config.ownerId, title: 'Keep?', context: 'Choice', options: { A: option, B: { ...option, label: 'Delete' } }, research: { queries: [], summary: '', gaps: [] }, status: 'open' as const, createdAt: f.snapshot.recordedAt, decisionSnapshotId: f.snapshot.id };
  f.store.save('questions', question);
  f.store.save('tasks', { ...f.task, status: 'awaiting_answer', stage: 'decide', questionId, decisionSnapshotId: f.snapshot.id });
  engine.answer({ questionId, taskVersion: 1, questionVersion: 1, choice: 'A', actorId: f.config.ownerId, eventId: `accepted-order-${answerFirst}` });
  const accepted = f.store.get('questions', questionId)!, decisionCase = f.store.list('cases').find(c => c.questionId === questionId)!;
  const answerSource = f.store.get('sources', stableId('owner-answer', questionId))!;
  expect(accepted.status).toBe('answered'); expect(answerSource.content).toContain('ACCEPTED_RECOVERY_ORDER_SENTINEL');
  const filenames = readdirSync(join(f.vault, f.project.id, f.project.domain, 'sources'));
  expect(filenames.indexOf(`${answerSource.id}.md`) < filenames.indexOf(`${f.task.sourceId}.md`)).toBe(answerFirst);
  f.store.close(); const ledger = new Store(f.db); stores.push(ledger); ledger.delete('sources', answerSource.id); ledger.delete('sources', f.task.sourceId); ledger.close();
  for (let restart = 0; restart < 2; restart++) {
    const recovered = new Store(f.db, f.vault); stores.push(recovered);
    recovered.rebuildIndex(); recovered.rebuildIndex();
    expect(recovered.get('sources', f.task.sourceId)).toMatchObject({ status: 'active', content: 'Original judgment' });
    expect(recovered.get('sources', answerSource.id)).toMatchObject({ status: 'active', content: answerSource.content });
    expect(recovered.get('questions', questionId)).toEqual(accepted);
    expect(recovered.get('cases', decisionCase.id)).toEqual(decisionCase);
    expect(readFileSync(path(f, answerSource), 'utf8')).toContain('ACCEPTED_RECOVERY_ORDER_SENTINEL');
    expect(recovered.list('tasks')).toHaveLength(1); recovered.close();
  }
});
