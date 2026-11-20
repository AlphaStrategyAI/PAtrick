import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, test } from 'vitest';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { createBlobStore, createRecoveryRuntimeGate, openDatabase, type SqliteDatabase } from '@patrick/storage';
import { issueCallerSession, ORIGIN, runWithAuth } from '../../apps/service/src/auth.js';
import { mountConversationRoutes } from '../../apps/service/src/routes/conversations.js';
import { mountConsultationRoutes } from '../../apps/service/src/routes/consultations.js';
import { mountDelegationRoutes } from '../../apps/service/src/routes/delegations.js';
import { mountStandardRoutes } from '../../apps/service/src/routes/standards.js';
import { mountFeishuRoutes } from '../../apps/service/src/routes/feishu.js';
import { createStandardsApi, type StandardRule } from '../../packages/domain/src/standards.js';
import { mountAnswerRoutes } from '../../apps/service/src/routes/answers.js';
import { mountEditRoutes } from '../../apps/service/src/routes/edits.js';
import { mountSourceRoutes } from '../../apps/service/src/routes/sources.js';
import { createAnswerGate, type AnswerGate } from '../../packages/domain/src/answer-gate.js';
import { createLocalHubPort, encodeHubAnswer } from '../../packages/integrations/autoloop/answers.js';
import { createVaultApi } from '../../packages/integrations/vault/drafts.js';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { mountWorkControlRoutes } from '../../apps/service/src/routes/work-controls.js';
import { createConsultationApi } from '../../packages/domain/src/consultations.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';

const at = '2026-11-17T04:00:00.000Z';
const now = () => new Date(at);
const owner = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, authenticated_at: at,
  domains: ['personal', 'other'], operations: ['owner'] };
const scope = { account_id: 'owner', caller_id: 'web', data_domain: 'personal', permission_epoch: 1 };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture(mode: 'admitted' | 'required' | 'peer' | 'copy' = 'admitted') {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t22-http-'));
  const path = join(root, 'state.sqlite');
  const original = openDatabase(path);
  original.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(at);
  const credentials = createCredentialStore(join(root, 'credentials'), now);
  const authorization = issueCallerSession(original, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials).authorization;
  original.prepare("INSERT INTO caller_scopes VALUES ('owner','web','other','owner',NULL)").run();
  original.prepare("INSERT INTO recovery_domain_gates VALUES ('personal','epoch-a','open','activation','witness',NULL,NULL,?)").run(at);
  const gate = createRecoveryRuntimeGate(original);
  if (mode !== 'required') gate.admit({ domain: 'personal', writerEpoch: 'epoch-a', activationId: 'activation', witnessRevision: 'witness' });
  let db = original;
  if (mode === 'peer') db = openDatabase(path);
  if (mode === 'copy') { original.pragma('wal_checkpoint(TRUNCATE)'); copyFileSync(path, join(root, 'copy.sqlite')); db = openDatabase(join(root, 'copy.sqlite')); }
  cleanups.push(() => { if (db !== original) db.close(); original.close(); rmSync(root, { recursive: true, force: true }); });
  let clock = now;
  const app = new Hono();
  app.use('*', async (_c, next) => runWithAuth({ db, credentials, now }, next));
  const ready = () => ({ db, now: () => clock() });
  mountConversationRoutes(app, ready); mountConsultationRoutes(app, ready); mountDelegationRoutes(app, ready); mountWorkControlRoutes(app, ready, () => true);
  const post = (path: string, id: string, payload: Json, revision: number | null = null) => app.request('/api/v1' + path, {
    method: 'POST', headers: { authorization, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ client_request_id: id, expected_revision: revision, payload,
      payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex') }),
  });
  return { root, app, db, gate, post, authorization, setClock(value: () => Date) { clock = value; },
    get: (path: string) => app.request('/api/v1' + path, { headers: { authorization } }) };
}
function count(db: SqliteDatabase, table: string) { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }
async function blocked(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'CONFLICT', params: { reason: 'recovery_write_blocked' } });
}

test.each(['conversation', 'consultation', 'message'] as const)('HTTP %s final clock closure rolls back business and command rows', async (kind) => {
  const f = fixture();
  let conversationId = '';
  if (kind === 'message') conversationId = (await createConsultationApi(f.db, { now }).createConversation(owner,
    { text: 'first', client_request_id: 'seed', data_domain: 'personal' })).conversation_id;
  const before = Object.fromEntries(['conversations', 'messages', 'consultations', 'domain_events', 'command_inbox', 'command_records'].map((table) => [table, count(f.db, table)]));
  let calls = 0;
  f.setClock(() => { if (++calls === 2) f.gate.revoke('personal'); return now(); });
  const path = kind === 'message' ? '/conversations/' + conversationId + '/messages' : '/' + (kind === 'conversation' ? 'conversations' : 'consultations');
  const payload = kind === 'message' ? { text: 'new' } : { text: 'new', request_scope: scope, ...(kind === 'consultation' ? { parent_work_id: null } : {}) };
  await blocked(await f.post(path, 'new', payload));
  for (const [table, n] of Object.entries(before)) expect(count(f.db, table)).toBe(n);
});

test.each(['required', 'peer', 'copy'] as const)('HTTP refuses SQL-open %s handles without trusted exact-handle admission', async (mode) => {
  const f = fixture(mode);
  await blocked(await f.post('/conversations', 'new', { text: 'new', request_scope: scope }));
  expect(count(f.db, 'conversations')).toBe(0); expect(count(f.db, 'command_inbox')).toBe(0);
});

test('HTTP exact command replay and read routes survive closure', async () => {
  const f = fixture(); const payload = { text: 'new', request_scope: scope };
  const first = await f.post('/conversations', 'new', payload); expect(first.status).toBe(202);
  const receipt = await first.json(); f.gate.revoke('personal');
  expect(await (await f.post('/conversations', 'new', payload)).json()).toEqual(receipt);
  expect((await f.get('/conversations')).status).toBe(200);
  expect((await f.get(receipt.receipt_url.replace('/api/v1', ''))).status).toBe(200);
  expect(count(f.db, 'command_records')).toBe(1);
});

async function work(f: ReturnType<typeof fixture>) {
  const api = createDelegationApi(f.db, owner, { domain: 'personal', now });
  const scope = { actions: ['judge'], resources: ['work'], effects: [], domains: ['personal'], risk: 'low', level: 'L1' as const, budget_micros: 5000 };
  await api.registerMandateType({ type_id: 'type', ...scope, config_version: 1 });
  await api.openMandate({ mandate_id: 'mandate', type_id: 'type', ...scope, expires_at: '2027-01-01T00:00:00Z' });
  await api.setCapability({ profile_id: 'profile', level: 'L2', actions: ['judge'], report_id: 'report', report_version: 1, config_version: 1 });
  await api.ensureJudgmentPolicy();
  await api.openWork({ work_id: 'work', generation: 1, mandate_id: 'mandate', phase: 'judgment', next_action: 'judge', budget_micros: 5000 });
  await api.authorizeAction({ work_id: 'work', generation: 1, attempt_id: 'attempt', phase: 'judgment', next_action: 'judge', allowed_effects: [], expires_at: '2026-11-17T05:00:00Z' });
  return scope;
}

test('closed HTTP resume refuses a new command while pause and stop remain usable', async () => {
  const f = fixture(); await work(f);
  f.gate.revoke('personal');
  let revision = (f.db.prepare('SELECT revision FROM work_generations').get() as { revision: number }).revision;
  const paused = await f.post('/work/work/controls', 'pause', { type: 'pause', generation: 1 }, revision);
  expect(paused.status).toBe(202);
  revision = (f.db.prepare('SELECT revision FROM work_generations').get() as { revision: number }).revision;
  const before = count(f.db, 'command_inbox');
  await blocked(await f.post('/work/work/controls', 'resume', { type: 'resume', generation: 1 }, revision));
  expect(count(f.db, 'command_inbox')).toBe(before);
  expect((await f.post('/work/work/controls', 'stop', { type: 'stop', generation: 1 }, revision)).status).toBe(202);
});

test('delegation proposal cannot confer new create authority while closed', async () => {
  const f = fixture(); const delegation = await work(f);
  f.db.prepare(`INSERT INTO auth_challenges(challenge_id,account_id,purpose,challenge_hash,challenge,origin,rp_id,expires_at,created_at)
    VALUES ('challenge','owner','control',?,'value',?,'localhost','2026-11-17T05:00:00.000Z',?)`).run('c'.repeat(64), ORIGIN, at);
  f.gate.revoke('personal');
  await blocked(await f.post('/delegation-proposals', 'proposal', { ...delegation, type_id: 'type', expires_at: '2027-01-01T00:00:00.000Z', challenge_id: 'challenge' }));
  expect(count(f.db, 'delegation_control_proposals')).toBe(0); expect(count(f.db, 'control_proposals')).toBe(0); expect(count(f.db, 'command_records')).toBe(0);
});

// The real adapter completes while admitted. Its awaited return then closes admission,
// exposing the separate HTTP command-record boundary without duplicating adapter gates.
test.each(['closure', 'domain'] as const)('answer return %s cannot record new HTTP command authority', async (race) => {
  const f = fixture(); await work(f);
  const api = createAnswerGate(f.db, { domain: 'personal', now,
    hub: createLocalHubPort(join(f.root, 'hub')), encode: encodeHubAnswer });
  const binding = await api.bindQuestion(owner, { question_id: 'question', question_version: 1, work_id: 'work', generation: 1,
    proposal_revision: 0, hub_card_id: 1, custom_allowed: false, custom_rules: [], options: [{ option_id: 'later', index: 0,
      label: 'Later', disposition: 'deferred', reason_code: 'OUT_OF_SCOPE', next_action: 'judge', difference: null, missing: [], collection_id: null, expected_material: null }] });
  const gate: AnswerGate = { ...api, async submitAnswer(principal, command) {
    const receipt = await api.submitAnswer(principal, command);
    if (race === 'closure') f.gate.revoke('personal');
    else f.db.prepare("UPDATE question_bindings SET data_domain='other' WHERE question_id='question'").run();
    return receipt;
  } };
  mountAnswerRoutes(f.app, () => ({ db: f.db, now, gate: () => gate }));
  await blocked(await f.post('/questions/question/answers', 'answer', { work_id: 'work', generation: 1, question_id: 'question', question_version: 1,
    proposal_revision: 0, options_hash: binding.options_hash, answer: { kind: 'option', option_id: 'later' } }, 0));
  expect(count(f.db, 'command_inbox')).toBe(0); expect(count(f.db, 'command_records')).toBe(0);
  expect(count(f.db, 'answer_receipts')).toBe(1);
});

test('edit adapter return closure denies a fresh HTTP command record', async () => {
  const f = fixture(); const vaultRoot = join(f.root, 'vault'); const isolated = join(f.root, 'isolated');
  mkdirSync(vaultRoot); mkdirSync(isolated);
  f.db.prepare(`INSERT INTO vaults VALUES ('vault','source','owner','personal','fixture',? ,?,'identity',?, ?,1,1,'connected','1.0',?,?)`)
    .run(vaultRoot, isolated, vaultRoot, 'a'.repeat(64), at, at);
  const api = createVaultApi(f.db, { blobs: createBlobStore(join(f.root, 'blobs')), now });
  mountEditRoutes(f.app, () => ({ db: f.db, now, api: { ...api, async createEdit(principal, input) {
    const receipt = await api.createEdit(principal, input); f.gate.revoke('personal'); return receipt;
  } } }));
  await blocked(await f.post('/edits', 'edit', { operation: 'create_standard', vault_id: 'vault', draft_key: 'draft', expected_active_version: null }));
  expect(count(f.db, 'command_inbox')).toBe(0); expect(count(f.db, 'command_records')).toBe(0);
});

test('source preview final clock closure denies a new configuration-capable command', async () => {
  const f = fixture(); const url = 'https://feed.example.test/news';
  const registry = createSourceRegistry(f.db, { blobs: createBlobStore(join(f.root, 'blobs')), now: () => at,
    http: { approvedUrls: () => [url], port: { async resolve() { return [{ address: '8.8.8.8', family: 4 }]; },
      async request() { return { status: 200, location: null, contentType: 'application/rss+xml',
        bytes: new TextEncoder().encode('<rss><channel><item><guid>post</guid><title>Title</title></item></channel></rss>') }; } } } });
  mountSourceRoutes(f.app, () => ({ db: f.db, registry, now() { f.gate.revoke('personal'); return now(); } }));
  await blocked(await f.post('/sources/detect', 'source', { type: 'rss', target: url, request_scope: scope }));
  for (const table of ['command_inbox', 'command_records', 'source_preview_receipts', 'source_configs']) expect(count(f.db, table)).toBe(0);
});


test('standards evaluation return closure denies a fresh HTTP command', async () => {
  const f = fixture();
  f.db.prepare(`INSERT INTO vaults VALUES ('vault','source','owner','personal','fixture','/vault','/isolated','identity','/vault',?,1,1,'connected','1.0',?,?)`).run('a'.repeat(64), at, at);
  const standards = createStandardsApi(f.db, owner, { domain: 'personal', now });
  await standards.seedProductDataset();
  const { candidate_rules: rules } = JSON.parse(readFileSync(new URL('../../fixtures/evaluation/product/manifest.json', import.meta.url), 'utf8')) as { candidate_rules: StandardRule[] };
  const head = await standards.ingestStandardDraft({ vaultId: 'vault', standardId: 'standard', draftKey: 'draft', rules });
  const candidate = await standards.openCandidate(head);
  const dataset = f.db.prepare('SELECT dataset_id FROM evaluation_datasets').get() as { dataset_id: string };
  const vault = createVaultApi(f.db, { blobs: createBlobStore(join(f.root, 'blobs')), now });
  mountStandardRoutes(f.app, () => ({ db: f.db, api: vault, now() { queueMicrotask(() => f.gate.revoke('personal')); return now(); } }));
  await blocked(await f.post('/standard-candidates/' + candidate.id + '/evaluations', 'evaluation', { dataset_id: dataset.dataset_id }));
  expect(count(f.db, 'command_inbox')).toBe(0); expect(count(f.db, 'command_records')).toBe(0);
});

test('Feishu pairing final clock closure rolls back new pairing and command', async () => {
  const f = fixture(); const connectionId = 'conn_' + createHash('sha256').update('owner').digest('hex').slice(0, 12);
  f.db.prepare(`INSERT INTO channel_connections(connection_id,account_id,data_domain,app_id,tenant_key,credential_ref,credential_version,
    config_revision,channel_incarnation,connection_epoch,binding_revision,status,transport_mode,schema_version,created_at,updated_at)
    VALUES (?,'owner','personal','app','tenant','fixture',1,1,1,1,1,'needs_binding','probe','1.0',?,?)`).run(connectionId, at, at);
  f.db.prepare("DELETE FROM caller_scopes WHERE data_domain='other'").run();
  let calls = 0;
  mountFeishuRoutes(f.app, () => ({ db: f.db, hub: createLocalHubPort(join(f.root, 'hub')), now() {
    if (++calls === 3) f.gate.revoke('personal'); return now();
  } }));
  await blocked(await f.post('/channels/feishu/bindings', 'pairing', {}));
  for (const table of ['channel_pairings', 'command_inbox', 'command_records']) expect(count(f.db, table)).toBe(0);
});


test('creation final clock uses actual persisted conversation domain', async () => {
  const f = fixture(); let calls = 0;
  f.setClock(() => {
    if (++calls === 2) f.db.prepare("UPDATE conversations SET data_domain='other'").run();
    return now();
  });
  await blocked(await f.post('/conversations', 'new', { text: 'new', request_scope: scope }));
  for (const table of ['command_inbox', 'command_records', 'conversations', 'messages']) expect(count(f.db, table)).toBe(0);
});

test.each(['clock', 'provider'] as const)('Feishu credential setup %s closure prevents new connection authority', async (race) => {
  const f = fixture(); f.db.prepare("DELETE FROM caller_scopes WHERE data_domain='other'").run();
  const store = createCredentialStore(join(f.root, 'feishu-credentials'), now); let writes = 0;
  // The closure either happens before the setup or while the secret is stored.
  if (race === 'clock') f.gate.revoke('personal');
  mountFeishuRoutes(f.app, () => ({ db: f.db, hub: createLocalHubPort(join(f.root, 'hub')),
    feishuCredentials: { ...store, put(...args) {
      writes++; const reference = store.put(...args); if (race === 'provider') f.gate.revoke('personal'); return reference;
    } },
    now() { return now(); } }));
  await blocked(await f.app.request('https://localhost/api/v1/channels/feishu/credentials', { method: 'POST',
    headers: { authorization: f.authorization, origin: 'https://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: 'fixture-app', app_secret: 'fixture-secret' }) }));
  expect(writes).toBe(race === 'clock' ? 0 : 1); expect(count(f.db, 'channel_connections')).toBe(0);
});

test('completed standard adoption HTTP replay returns its immutable receipt without projection handoff while closed', async () => {
  const f = fixture();
  f.db.prepare(`INSERT INTO vaults VALUES ('vault','source','owner','personal','fixture','/vault','/isolated','identity','/vault',?,1,1,'connected','1.0',?,?)`).run('a'.repeat(64), at, at);
  const standards = createStandardsApi(f.db, owner, { domain: 'personal', now });
  await standards.seedProductDataset();
  const { candidate_rules: rules } = JSON.parse(readFileSync(new URL('../../fixtures/evaluation/product/manifest.json', import.meta.url), 'utf8')) as { candidate_rules: StandardRule[] };
  const head = await standards.ingestStandardDraft({ vaultId: 'vault', standardId: 'standard', draftKey: 'draft', rules });
  const candidate = await standards.openCandidate(head);
  const report = await standards.evaluate(candidate, { version: 1 });
  const vault = createVaultApi(f.db, { blobs: createBlobStore(join(f.root, 'blobs')), now }); let projectionCalls = 0;
  mountStandardRoutes(f.app, () => ({ db: f.db, now, api: { ...vault,
    async projectPendingStandardAdoption() { projectionCalls++; return undefined; },
  } }));
  const path = '/standard-candidates/' + candidate.id + '/adoptions'; const payload = { report_id: report.id };
  const first = await f.post(path, 'adopt', payload, candidate.revision); expect(first.status).toBe(202);
  const receipt = await first.json(); expect(projectionCalls).toBe(1); f.gate.revoke('personal');
  const replay = await f.post(path, 'adopt', payload, candidate.revision);
  expect(replay.status).toBe(202); expect(await replay.json()).toEqual(receipt); expect(projectionCalls).toBe(1);
  expect(count(f.db, 'command_records')).toBe(1); expect(count(f.db, 'adoption_facts')).toBe(1);
});
