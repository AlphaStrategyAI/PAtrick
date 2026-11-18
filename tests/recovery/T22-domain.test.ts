import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createRecoveryRuntimeGate, openDatabase, type SqliteDatabase } from '@patrick/storage';
import { acknowledgeConsultationOutbox, admittedConsultation, createConsultationApi } from '../../packages/domain/src/consultations.js';
import { recordKnowledge, reindexKnowledge, withdrawEvidence } from '../../packages/domain/src/evidence.js';
import { createStandardsApi, type StandardRule } from '../../packages/domain/src/standards.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { createWorkControlApi, createStopFixture } from '../../packages/domain/src/work-control.js';
import { claimContinuation, confirmCollectedEvidence, recordCollectionRound, emitStage, dispatchDelivery } from '../../packages/domain/src/work-continuation.js';
import { createEffectRepository } from '../../packages/domain/src/effects.js';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';

// Test-only bypass for legacy state-machine assertions; this is not an admitted production reader.
vi.mock('../../packages/integrations/sources/directory-capability.js', async (load) => {
  const actual = await load<typeof import('../../packages/integrations/sources/directory-capability.js')>();
  return { ...actual, assertDirectoryReaderAvailable: () => {} };
});

const at = '2026-11-16T12:00:00.000Z';
const now = () => new Date(at);
const principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1,
  domains: ['personal', 'other'], operations: ['owner', 'publish_pr', 'standards.write'] };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t22-domain-'));
  const path = join(root, 'state.sqlite');
  const db = openDatabase(path);
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(at);
  for (const domain of principal.domains) for (const permission of principal.operations) {
    db.prepare('INSERT INTO caller_scopes VALUES (?,?,?,?,NULL)').run('owner', 'web', domain, permission);
  }
  return { root, path, db };
}
function admit(db: SqliteDatabase, domain = 'personal') {
  db.prepare(`INSERT INTO recovery_domain_gates VALUES (?, 'epoch-a', 'open', 'activation', 'witness', NULL, NULL, ?)
    ON CONFLICT(data_domain) DO UPDATE SET status='open',writer_epoch='epoch-a'`).run(domain, at);
  const gate = createRecoveryRuntimeGate(db);
  gate.admit({ domain, writerEpoch: 'epoch-a', activationId: 'activation', witnessRevision: 'witness' });
  return gate;
}
function count(db: SqliteDatabase, table: string) {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
const request = { client_request_id: 'request', text: 'question', data_domain: 'personal', parent_work_id: null };
function knowledge(db: SqliteDatabase) {
  recordKnowledge(db, { accountId: 'owner', domain: 'personal', knowledgeId: 'knowledge', body: 'body', alias: 'alias',
    documentId: 'document', revisionId: 'revision', observedSeq: 1, now: at });
}
async function work(f: ReturnType<typeof fixture>, phase: 'judgment' | 'delivery' = 'judgment', workId = 'work') {
  const api = createDelegationApi(f.db, principal, { domain: 'personal', now });
  const scope = { actions: ['judge', 'collect', 'publish_pr'], resources: ['work', 'github:123'],
    effects: ['publish_pr'], domains: ['personal'], risk: 'low', level: 'L1' as const, budget_micros: 5000 };
  await api.registerMandateType({ type_id: 'type', ...scope, config_version: 1 });
  await api.openMandate({ mandate_id: 'mandate', type_id: 'type', ...scope, expires_at: '2027-01-01T00:00:00Z' });
  await api.setCapability({ profile_id: 'profile', level: 'L2', actions: scope.actions, report_id: 'report', report_version: 1, config_version: 1 });
  await api.ensureJudgmentPolicy();
  await api.openWork({ work_id: workId, generation: 1, mandate_id: 'mandate', phase,
    next_action: phase === 'delivery' ? 'publish_pr' : 'judge', budget_micros: 5000 });
  if (phase === 'delivery') await api.setWorkGate(workId, 1, { evidence_ready: true });
  const grant = await api.authorizeAction({ work_id: workId, generation: 1, attempt_id: 'attempt', phase,
    next_action: phase === 'delivery' ? 'publish_pr' : 'judge', allowed_effects: phase === 'delivery' ? ['publish_pr'] : [],
    expires_at: '2026-11-17T00:00:00Z' });
  return { api, grant, workId };
}
async function candidate(f: ReturnType<typeof fixture>) {
  f.db.prepare(`INSERT INTO vaults VALUES ('vault','source','owner','personal','fixture','/vault','/isolated','identity','/vault',?,1,1,'connected','1.0',?,?)`).run('a'.repeat(64), at, at);
  const api = createStandardsApi(f.db, principal, { domain: 'personal', now });
  await api.seedProductDataset();
  const { candidate_rules: rules } = JSON.parse(readFileSync(new URL('../../fixtures/evaluation/product/manifest.json', import.meta.url), 'utf8')) as { candidate_rules: StandardRule[] };
  const draft = { vaultId: 'vault', standardId: 'standard', draftKey: 'draft', rules };
  const head = await api.ingestStandardDraft(draft);
  const item = await api.openCandidate(head);
  return { api, draft, head, item };
}

test.each(['required', 'other-domain', 'peer', 'epoch', 'pending'])('direct consultation creation denies %s admission without rows', async (mode) => {
  const f = fixture();
  let db = f.db;
  if (mode === 'required') createRecoveryRuntimeGate(db);
  else {
    admit(db, mode === 'other-domain' ? 'other' : 'personal');
    if (mode === 'peer') { db = openDatabase(f.path); const peer = db; cleanups.unshift(() => peer.close()); }
    if (mode === 'epoch') db.prepare("UPDATE recovery_domain_gates SET writer_epoch='epoch-b'").run();
    if (mode === 'pending') {
      db.prepare("INSERT INTO withdrawal_events VALUES ('withdraw','personal','knowledge','x',1,1,'owner',?)").run(at);
      db.prepare("UPDATE recovery_domain_gates SET status='open'").run();
    }
  }
  await expect(createConsultationApi(db, { now }).createConsultation(principal, request)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  for (const table of ['consultations', 'conversations', 'messages', 'business_budgets', 'domain_events']) expect(count(db, table)).toBe(0);
});

test('consultation exact replay and cancel survive closure while completion and new messages deny', async () => {
  const f = fixture(); const gate = admit(f.db);
  const api = createConsultationApi(f.db, { now });
  const receipt = await api.createConsultation(principal, request);
  gate.revoke('personal');
  expect(await api.createConsultation(principal, request)).toEqual(receipt);
  await expect(api.postMessage(principal, receipt.conversation_id, { client_request_id: 'message', text: 'new' })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  await expect(api.completeConsultation(receipt.request_id, 0, { text: 'answer' })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  expect(count(f.db, 'messages')).toBe(1);
  expect(await api.cancelConsultation(principal, receipt.request_id, 0)).toBe(true);
});

test.each(['create', 'message', 'dispatch'])('consultation %s rechecks after supplied clock revokes admission', async (kind) => {
  const f = fixture(); const gate = admit(f.db);
  const initial = createConsultationApi(f.db, { now });
  const receipt = await initial.createConsultation(principal, request);
  let published = 0;
  const api = createConsultationApi(f.db, { now() { gate.revoke('personal'); return now(); } });
  if (kind === 'create') await expect(api.createConversation(principal, { ...request, client_request_id: 'conversation' })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  if (kind === 'message') await expect(api.postMessage(principal, receipt.conversation_id, { client_request_id: 'message', text: 'new' })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  if (kind === 'dispatch') await expect(api.dispatchConsultation(receipt.request_id, { async publish() { published++; return 'accepted'; } })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  expect(published).toBe(0); expect(count(f.db, 'messages')).toBe(1); expect(count(f.db, 'conversations')).toBe(1);
});

test('knowledge recording and indexing use actual stored domain and withdrawal remains atomic', () => {
  const f = fixture(); const gate = admit(f.db); knowledge(f.db);
  const evidence = f.db.prepare('SELECT evidence_id FROM evidence_refs').get() as { evidence_id: string };
  admit(f.db, 'other'); gate.revoke('personal');
  expect(() => knowledge(f.db)).toThrow('RECOVERY_WRITE_BLOCKED');
  expect(() => reindexKnowledge(f.db, 'knowledge', 'other', ['injected'])).toThrow('CONFLICT');
  expect(() => reindexKnowledge(f.db, 'knowledge', 'personal', ['injected'])).toThrow('RECOVERY_WRITE_BLOCKED');
  expect(withdrawEvidence(f.db, { domain: 'personal', evidenceId: evidence.evidence_id, reason: 'owner', now: at })).toEqual({ epoch: 1 });
  expect(count(f.db, 'withdrawal_events')).toBe(1); expect(count(f.db, 'recovery_withdrawal_pending')).toBe(1);
  expect(f.db.prepare('SELECT status FROM knowledge_records').get()).toEqual({ status: 'withdrawn' });
  expect(count(f.db, 'domain_events')).toBe(1);
});

test.each(['seed', 'ingest', 'candidate', 'evaluation', 'adopt', 'outcome', 'basis'])('standards %s cannot materialize authority after closure', async (kind) => {
  const f = fixture(); const { api, draft, head, item } = await candidate(f);
  const report = await api.evaluate(item, { version: 1 });
  const gate = admit(f.db); gate.revoke('personal');
  const before = Object.fromEntries(['blobs', 'vault_revisions', 'standard_candidates', 'evaluation_reports', 'adoption_facts', 'projection_batches', 'case_outcomes', 'judgment_bases'].map((t) => [t, count(f.db, t)]));
  const operations = {
    seed: () => api.seedDataset({ datasetId: 'new', policyId: 'new', policyVersion: 2, minSamples: 1, thresholdThousandths: 1, budgetMicros: 1, cases: [] }),
    ingest: () => api.ingestStandardDraft({ ...draft, draftKey: 'next' }),
    candidate: () => api.openCandidate({ ...head, draft_key: 'next' }),
    evaluation: () => api.evaluate(item, { version: 1 }),
    adopt: () => api.adoptStandard(item.id, report.id, item.revision),
    outcome: () => api.recordOutcome('seed-01', { result: 'accepted', source: 'test', observed_at: at }),
    basis: () => api.freezeJudgmentBasis('work', 1),
  };
  await expect(operations[kind as keyof typeof operations]()).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  for (const [table, value] of Object.entries(before)) expect(count(f.db, table)).toBe(value);
});

test('admitted adoption exact replay and owner withdrawal retain pending protections while closed', async () => {
  const f = fixture(); const { api, item } = await candidate(f); const gate = admit(f.db);
  const report = await api.evaluate(item, { version: 1 });
  expect(await api.adoptStandard(item.id, report.id, item.revision)).toBe('adopted');
  gate.revoke('personal');
  expect(await api.adoptStandard(item.id, report.id, item.revision)).toBe('adopted');
  expect(count(f.db, 'adoption_facts')).toBe(1); expect(count(f.db, 'projection_batches')).toBe(1);
  expect(await api.withdrawStandardVersion('standard', 1, 'owner')).toEqual({ epoch: 1 });
  expect(count(f.db, 'recovery_withdrawal_pending')).toBe(1);
  expect(f.db.prepare('SELECT status FROM standard_versions').get()).toEqual({ status: 'withdrawn' });
});

test('standards clock revocation denies seed before business rows', async () => {
  const f = fixture(); const gate = admit(f.db);
  const api = createStandardsApi(f.db, principal, { domain: 'personal', now() { gate.revoke('personal'); return now(); } });
  await expect(api.seedProductDataset()).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  expect(count(f.db, 'evaluation_policies')).toBe(0);
});

test('resume checks admission after final clock while pause and stop remain available', async () => {
  const f = fixture(); await work(f); const gate = admit(f.db); const stop = createStopFixture();
  const api = createWorkControlApi(f.db, principal, { now, stopPort: stop });
  const paused = await api.applyWorkControl(principal, { work_id: 'work', generation: 1, type: 'pause', expected_revision: (f.db.prepare('SELECT revision FROM work_generations').get() as { revision: number }).revision });
  let calls = 0;
  const racing = createWorkControlApi(f.db, principal, { now() { calls++; if (calls === 2) gate.revoke('personal'); return now(); } });
  await expect(racing.applyWorkControl(principal, { work_id: 'work', generation: 1, type: 'resume', expected_revision: paused.revision })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  expect(f.db.prepare('SELECT control_state FROM work_generations').get()).toEqual({ control_state: 'paused' });
  const stopped = await api.applyWorkControl(principal, { work_id: 'work', generation: 1, type: 'stop', expected_revision: paused.revision });
  expect(stopped.state).toBe('processing');
  stop.report('work', 1, { process_tree_stopped: true, effects_reconciled: true });
  expect((await api.syncStop('work', 1)).state).toBe('stopped');
});

test.each(['stage', 'handoff'])('direct continuation %s loads actual work domain', async (kind) => {
  const f = fixture(); await work(f); admit(f.db, 'other');
  if (kind === 'stage') expect(() => emitStage(f.db, 'work', 1, 'pr.sent', now())).toThrow('RECOVERY_WRITE_BLOCKED');
  else expect(() => dispatchDelivery(f.db, 'work', 1)).toThrow('RECOVERY_WRITE_BLOCKED');
  expect(count(f.db, 'stage_events')).toBe(0);
});

async function effects(f: ReturnType<typeof fixture>, prepare = true) {
  const source = join(f.root, 'source'); mkdirSync(source); writeFileSync(join(source, 'demand.md'), 'Demand');
  const registry = createSourceRegistry(f.db, { blobs: createBlobStore(join(f.root, 'blobs')), now: () => at });
  const enabled = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: source,
    hasTriggerRule: true, excludes: [], frequency: 'poll', history: 'none' });
  await registry.collectSource(enabled.sourceId, enabled.configRevision);
  const { event_id: id } = f.db.prepare("SELECT event_id FROM outbox WHERE destination='source-work'").get() as { event_id: string };
  const { grant } = await work(f, 'delivery', id);
  const artifact = { headSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), title: 'Plan', body: 'Plan' };
  const target = { owner: 'approved', repo: 'plans', repoId: '123', baseRef: 'main' };
  const repository = (clock = now) => createEffectRepository(f.db, principal, { target, domain: 'personal', now: clock,
    async verifyBuild() { return { artifact, patch: { path: 'plan.md', before: null, after: 'Plan', digest: 'd'.repeat(64) } }; } });
  const repo = repository();
  if (prepare) await repo.prepareBuild({ workId: id, generation: 1, grant, artifact });
  const receipt = prepare ? repo.freezePr({ workId: id, generation: 1, grant }) : { intentId: '' };
  return { repo, repository, receipt, artifact, target, id, grant };
}

test('effect verification cannot create delivered authority while closed but preserves uncertain accounting', async () => {
  const f = fixture(); const e = await effects(f); const gate = admit(f.db);
  const intent = e.repo.intent(e.receipt.intentId);
  expect(e.repo.claimSend(intent.intentId, 'create_pr', e.artifact.baseSha, undefined, e.artifact.headSha)).toBe(true);
  gate.revoke('personal');
  expect(() => e.repo.verify(intent.intentId, { ...intent.frozen, number: 1, currentBaseSha: e.artifact.baseSha }, e.artifact.baseSha)).toThrow('RECOVERY_WRITE_BLOCKED');
  expect(e.repo.mark(intent.intentId, 'uncertain', 'readback_unavailable').status).toBe('uncertain');
  expect(count(f.db, 'outcome_watches')).toBe(0); expect(count(f.db, 'stage_events')).toBe(0);
});

test('effect replacement activation rechecks after supplied clock and sends remain denied', async () => {
  const f = fixture(); const e = await effects(f); const gate = admit(f.db);
  const rebuild = e.repo.prepareRebuild(e.receipt.intentId, { number: null, headSha: null, baseSha: 'c'.repeat(40), baseTree: 'd'.repeat(40),
    expectedTree: 'e'.repeat(40), expectedHead: 'f'.repeat(40), payload: { tree: { base_tree: 'd'.repeat(40), tree: [] },
      commit: { message: 'Plan', tree: 'e'.repeat(40), parents: ['c'.repeat(40)], author: { name: 'Fixture', email: 'fixture@example.invalid', date: at }, committer: { name: 'Fixture', email: 'fixture@example.invalid', date: at } } } });
  const repo = e.repository(() => { gate.revoke('personal'); return now(); });
  expect(() => repo.activateReplacement(e.receipt.intentId, rebuild.rebuild_id, 'f'.repeat(40), 'e'.repeat(40), 'c'.repeat(40))).toThrow('RECOVERY_WRITE_BLOCKED');
  expect(e.repo.rebuild(e.receipt.intentId)?.applied_at).toBeNull();
  expect(e.repo.claimSend(e.receipt.intentId, 'create_ref', e.artifact.headSha)).toBe(false);
  expect(count(f.db, 'effect_dispatches')).toBe(0);
});

test('consultation handoff rechecks after authorization yields and before custom billing dispatch', async () => {
  const f = fixture(); const gate = admit(f.db); let calls = 0;
  const api = createConsultationApi(f.db, { now });
  const item = await api.createConsultation(principal, request);
  // The authorization promise resolves after its transaction has admitted the grant.
  const running = api.runConsultation(principal, item.request_id, { async dispatch() {
    calls++; return { sent: true, alreadyDispatched: false, text: 'result' };
  } });
  gate.revoke('personal');
  await expect(running).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  expect(calls).toBe(0); expect(count(f.db, 'messages')).toBe(1);
});

test('completion of an absent consultation retains false result', async () => {
  const f = fixture();
  expect(await createConsultationApi(f.db, { now }).completeConsultation('absent', 0, { text: 'answer' })).toBe(false);
});

test('standards outcome callback cannot commit fresh facts after revoking admission', async () => {
  const f = fixture(); const { api } = await candidate(f); const gate = admit(f.db);
  await expect(api.recordOutcome('seed-01', { result: 'accepted', source: 'test', observed_at: at }, () => gate.revoke('personal')))
    .rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  expect(count(f.db, 'case_outcomes')).toBe(0);
});

test('standards adoption uses persisted candidate domain despite another admitted factory domain', async () => {
  const f = fixture(); const { api, item } = await candidate(f); const report = await api.evaluate(item, { version: 1 });
  admit(f.db, 'other');
  const other = createStandardsApi(f.db, principal, { domain: 'other', now });
  await expect(other.adoptStandard(item.id, report.id, item.revision)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  expect(count(f.db, 'adoption_facts')).toBe(0);
});

test('effect prepareBuild rechecks after async verifier revokes admission before rows or cases', async () => {
  const f = fixture(); const e = await effects(f, false); const gate = admit(f.db);
  const before = count(f.db, 'cases'); let verified = 0;
  const repo = createEffectRepository(f.db, principal, { target: e.target, domain: 'personal', now,
    async verifyBuild() { await Promise.resolve(); verified++; gate.revoke('personal');
      return { artifact: e.artifact, patch: { path: 'plan.md', before: null, after: 'Plan', digest: 'a'.repeat(64) } }; } });
  await expect(repo.prepareBuild({ workId: e.id, generation: 1, grant: e.grant, artifact: e.artifact })).rejects.toThrow('DENIED');
  expect(verified).toBe(1); expect(count(f.db, 'work_pr_builds')).toBe(0); expect(count(f.db, 'cases')).toBe(before);
});

test('effect verified terminal receipts stay readable after closure without extra authority', async () => {
  const f = fixture(); const e = await effects(f); const gate = admit(f.db); const intent = e.repo.intent(e.receipt.intentId);
  expect(e.repo.claimSend(intent.intentId, 'create_pr', e.artifact.baseSha, undefined, e.artifact.headSha)).toBe(true);
  const actual = { ...intent.frozen, number: 1, currentBaseSha: e.artifact.baseSha };
  const verified = e.repo.verify(intent.intentId, actual, e.artifact.baseSha);
  expect(verified.status).toBe('verified'); gate.revoke('personal');
  expect(e.repo.verify(intent.intentId, actual, e.artifact.baseSha)).toEqual(verified);
  expect(count(f.db, 'outcome_watches')).toBe(1); expect(count(f.db, 'stage_events')).toBe(1);
});

async function continuation(f: ReturnType<typeof fixture>) {
  const { grant } = await work(f);
  const key = { work_id: 'work', generation: 1, question_id: 'question', answer_event_id: 'answer', phase: 'answer' as const };
  f.db.prepare(`INSERT INTO question_bindings (
    question_id,question_version,work_id,generation,account_id,data_domain,proposal_revision,options_hash,
    hub_card_id,judgment_basis_hash,options_json,custom_rules_json,custom_allowed,status,
    expected_material,withdrawal_watermark,schema_version,revision,created_at,updated_at)
    VALUES ('question',1,'work',1,'owner','personal',1,?,1,?,'[]','[]',0,'closed','material',0,'1.0',0,?,?)`)
    .run('a'.repeat(64), grant.basis_hash, at, at);
  f.db.prepare(`INSERT INTO resume_intents VALUES ('work',1,'question','answer','answer','ready','collect:collection',NULL,NULL)`).run();
  f.db.prepare('UPDATE work_generations SET attempt_closed=1,process_tree_stopped=1,effects_reconciled=1').run();
  return key;
}

test('closed continuation claim leaves ready intent intact and later exact claimed replay is readable', async () => {
  const f = fixture(); const key = await continuation(f); const gate = admit(f.db); gate.revoke('personal');
  expect(claimContinuation(f.db, principal, 'personal', key, 'next', now())).toEqual({ status: 'waiting' });
  expect(f.db.prepare('SELECT state FROM resume_intents').get()).toEqual({ state: 'ready' });
  admit(f.db);
  expect(claimContinuation(f.db, principal, 'personal', key, 'next', now()).status).toBe('claimed');
  gate.revoke('personal');
  expect(claimContinuation(f.db, principal, 'personal', key, 'next', now())).toEqual({ status: 'duplicate' });
});

test('collected evidence confirmation denies new proof while closed and retains exact completed proof replay', async () => {
  const f = fixture(); const key = await continuation(f); const gate = admit(f.db);
  f.db.prepare("UPDATE resume_intents SET state='claimed',attempt_id='next'").run();
  recordCollectionRound(f.db, principal, { question_id: 'question', material: 'material', evidence_ref: 'material' }, now());
  gate.revoke('personal');
  expect(() => confirmCollectedEvidence(f.db, principal, 'personal', key, 'material', now())).toThrow('RECOVERY_WRITE_BLOCKED');
  expect(count(f.db, 'evidence_proofs')).toBe(0); expect(count(f.db, 'resume_intents')).toBe(1);
  admit(f.db); confirmCollectedEvidence(f.db, principal, 'personal', key, 'material', now());
  gate.revoke('personal'); confirmCollectedEvidence(f.db, principal, 'personal', key, 'material', now());
  expect(count(f.db, 'evidence_proofs')).toBe(1); expect(count(f.db, 'resume_intents')).toBe(2);
  expect(count(f.db, 'work_stages')).toBe(1);
});

test('recordCollectionRound denies authority for closed persisted question domain', async () => {
  const f = fixture(); await continuation(f); admit(f.db, 'other');
  expect(() => recordCollectionRound(f.db, principal, { question_id: 'question', material: 'material', evidence_ref: 'material' }, now()))
    .toThrow('RECOVERY_WRITE_BLOCKED');
  expect(count(f.db, 'collection_rounds')).toBe(0);
});

test('consultation admission and outbox acknowledgement independently deny closure with hub receipt present', async () => {
  const f = fixture(); const gate = admit(f.db); const api = createConsultationApi(f.db, { now });
  const item = await api.createConsultation(principal, request); const id = `consultation.requested:${item.request_id}`;
  f.db.prepare(`INSERT INTO hub_events VALUES (?,?,?,0,0,'consultation.requested',?,NULL,1,?)`)
    .run(id, item.request_id, item.request_id, item.request_id, at);
  gate.revoke('personal');
  expect(() => acknowledgeConsultationOutbox(f.db, item.request_id, 'accepted')).toThrow('RECOVERY_WRITE_BLOCKED');
  expect(f.db.prepare("SELECT result FROM outbox WHERE destination='autoloop'").get()).toEqual({ result: null });
  admit(f.db); acknowledgeConsultationOutbox(f.db, item.request_id, 'accepted');
  expect(admittedConsultation(f.db, item.request_id, at)?.domain).toBe('personal');
  gate.revoke('personal');
  expect(admittedConsultation(f.db, item.request_id, at)).toBeNull();
  expect(() => acknowledgeConsultationOutbox(f.db, item.request_id, 'accepted')).not.toThrow();
});

test('consultation dispatch clock cannot substitute an admitted stale object domain', async () => {
  const f = fixture(); admit(f.db); const api = createConsultationApi(f.db, { now });
  const item = await api.createConsultation(principal, request); let sent = 0;
  const racing = createConsultationApi(f.db, { now() {
    f.db.prepare("UPDATE consultations SET data_domain='other' WHERE request_id=?").run(item.request_id); return now();
  } });
  await expect(racing.dispatchConsultation(item.request_id, { async publish() { sent++; return 'accepted'; } })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  expect(sent).toBe(0);
});

test('new conversation work linking denies closure and exact existing link stays readable', async () => {
  const f = fixture(); await work(f); const gate = admit(f.db); const api = createConsultationApi(f.db, { now });
  const conversation = await api.createConversation(principal, { ...request, client_request_id: 'conversation' });
  gate.revoke('personal');
  await expect(api.linkConversationWork(principal, conversation.conversation_id, 'work', 0)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  admit(f.db); const linked = await api.linkConversationWork(principal, conversation.conversation_id, 'work', 0);
  gate.revoke('personal');
  expect(await api.linkConversationWork(principal, conversation.conversation_id, 'work', 0)).toEqual(linked);
  expect(count(f.db, 'conversations')).toBe(1);
});

test('standard control proposal clock cannot reopen adoption when permission is missing', async () => {
  const f = fixture(); const { api, item } = await candidate(f); const report = await api.evaluate(item, { version: 1 });
  const gate = admit(f.db); let calls = 0;
  const outside = createStandardsApi(f.db, { ...principal, domains: [] }, { domain: 'personal', now() {
    calls++; if (calls === 2) gate.revoke('personal'); return now();
  } });
  await expect(outside.adoptStandard(item.id, report.id, item.revision)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
  expect(count(f.db, 'control_proposals')).toBe(0); expect(count(f.db, 'auth_challenges')).toBe(0);
});
