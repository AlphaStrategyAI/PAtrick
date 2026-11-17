import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { openDatabase } from '@patrick/storage';
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession, ORIGIN, RP_ID } from '../../apps/service/src/auth.js';
import { parseNetworkPolicy } from '../../packages/host/src/network/vpn.js';
import { networkSettingsHandlers } from '../../apps/service/src/settings/network.js';
import { ApiError } from '../../apps/service/src/errors.js';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t21-recovery-'));
  const databasePath = join(root, 'ledger.sqlite');
  const credentialDirectory = join(root, 'credentials');
  let time = Date.parse('2026-11-17T07:00:00Z');
  const now = () => new Date(time);
  let db = openDatabase(databasePath);
  const policy = parseNetworkPolicy({ schema_version: '1.0', device_id: 'fixture-mac', revision: 1,
    targets: [{ id: 'hub', role: 'hub' }, { id: 'work', role: 'target' }, { id: 'peer', role: 'peer' }],
    vpn_paths: [], repairs: [{ id: 'fixed-dns', kind: 'refresh_dns', target: 'work' }],
    limits: { maximum_attempts: 1, cooldown_ms: 5_000, deadline_ms: 5_000 }, fallback: 'none' });
  const credentials = createCredentialStore(credentialDirectory, now);
  db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(now().toISOString());
  const session = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
  const reader = issueCallerSession(db, { accountId: 'owner', callerId: 'reader', domain: 'personal', permissions: ['settings.read'] }, now, credentials);
  let fixed = false;
  let interrupt = true;
  let mutations = 0;
  let restores = 0;
  let readbacks = 0;
  let duringReadback: (() => void | Promise<void>) | undefined;
  let rule = 'a'.repeat(64);
  const networkRepair = { policy, accountId: 'owner', domain: 'personal', localDeviceId: policy.device_id,
    observe: async ({ targetIds }: { targetIds: readonly string[] }) => {
      if (fixed) {
        readbacks += 1;
        if (interrupt) { interrupt = false; time += 5_001; }
        await duringReadback?.();
      }
      return targetIds.map((targetId) => ({ targetId, problem: targetId === 'work' && !fixed ? 'dns' as const : 'healthy' as const }));
    },
    actuator: { readRule: async () => rule,
      apply: async () => { fixed = true; mutations += 1; rule = 'b'.repeat(64); return { state: 'changed' as const, revision: rule }; },
      restore: async () => { restores += 1; return 'unknown' as const; } },
  };
  let app = createApp({ databasePath, credentialDirectory, now, networkRepair });
  const headers = { authorization: session['authorization'], origin: ORIGIN, 'content-type': 'application/json' };
  const post = async (path: string, requestId: string, revision: number | null, payload: Json) => app.request('/api/v1' + path, {
    method: 'POST', headers, body: JSON.stringify({ client_request_id: requestId, expected_revision: revision,
      payload, payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex') }),
  });
  let sequence = 0;
  async function authorize(draft: Json, revision: number) {
    const key = 'auth-' + sequence++;
    const validated = await post('/settings/validations', key + '-validate', revision, draft);
    expect(validated.status).toBe(200);
    const { data: proof } = await validated.json() as { data: { validation_id: string; valid: boolean } };
    expect(proof.valid).toBe(true);
    const challenge = await app.request('/api/v1/auth/challenge', { method: 'POST', headers, body: JSON.stringify({ rp_id: RP_ID }) });
    expect(challenge.status).toBe(200);
    const { challenge_id } = await challenge.json() as { challenge_id: string };
    const staged = await post('/settings/control-proposals', key + '-stage', revision, { draft, validation_id: proof.validation_id, challenge_id });
    expect(staged.status).toBe(200);
    const { data: proposal } = await staged.json() as { data: { proposal_id: string; proposal_hash: string; base_revision: number } };
    expect((await post('/control-proposals/' + proposal.proposal_id + '/confirm', key + '-confirm', proposal.base_revision,
      { proposal_hash: proposal.proposal_hash, challenge_id })).status).toBe(202);
    const row = db.prepare('SELECT receipt_id FROM control_receipts WHERE proposal_id=?').get(proposal.proposal_id) as { receipt_id: string };
    return { draft, validation_id: proof.validation_id, control_receipt_id: row.receipt_id };
  }
  const originalDraft = { operation: 'repair_network', domain: 'personal', target: policy.device_id,
    input: { target_id: 'work', repair_id: 'fixed-dns' } };
  const originalPayload = await authorize(originalDraft, 0);
  const applied = await post('/settings/changes', 'original-apply', 0, originalPayload);
  expect(applied.status).toBe(202);
  const { command_id: changeId } = await applied.json() as { command_id: string };
  const original = db.prepare('SELECT * FROM settings_changes WHERE change_id=?').get(changeId) as
    { validation_id: string; control_receipt_id: string; receipt: string; updated_at: string };
  const uncertain = { ...JSON.parse(original.receipt), phase: 'uncertain' };
  db.prepare("UPDATE settings_changes SET phase='uncertain',receipt=? WHERE change_id=?").run(JSON.stringify(uncertain), changeId);
  time += 120_001;
  app = createApp({ databasePath, credentialDirectory, now, networkRepair });
  const draft = { operation: 'reconcile_network', domain: 'personal', target: policy.device_id, input: { change_id: changeId } };
  const get = (path: string, authorization = headers.authorization) => app.request('/api/v1' + path, { headers: { authorization } });
  return { root, get db() { return db; }, get, post, authorize, draft, original, originalPayload, changeId, policy,
    counts: () => ({ mutations, restores, readbacks }), expire: () => { time += 120_001; },
    onReadback: (action: () => void | Promise<void>) => { duringReadback = action; }, replaceRule: () => { rule = 'c'.repeat(64); },
    currentOwner(callerId: string) {
      const fresh = issueCallerSession(db, { accountId: 'owner', callerId, domain: 'personal', permissions: ['owner'] }, now, credentials);
      headers.authorization = fresh.authorization;
    },
    reader: reader.authorization, reopen: () => {
      db.close();
      db = openDatabase(databasePath);
      app = createApp({ databasePath, credentialDirectory, now, networkRepair });
    },
    beforeProjection(action: () => void) {
      const handler = networkSettingsHandlers({ db, credentials, now, networkRepair }).repair_network!;
      app = createApp({ databasePath, credentialDirectory, now, networkRepair, settingsHandlers: {
        repair_network: { ...handler, async recover(...args) {
          const outcome = await handler.recover!(...args);
          action();
          return outcome;
        } },
      } });
    },
    dispose() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('fresh scoped T03 recovery settles the same original receipt after old proof expiry and durably replays', async () => {
  const f = await fixture();
  try {
    const offer = await f.get('/settings/changes/' + f.changeId + '/recovery');
    expect(offer.status).toBe(200);
    expect(await offer.json()).toMatchObject({ data: { change_id: f.changeId, action: 'reconcile_network', status: 'readback_available',
      target: { target: 'fixture-mac', revision: 1, input: { change_id: f.changeId } } } });
    const payload = await f.authorize(f.draft, 1);
    expect((await f.post('/settings/changes', 'ordinary-recovery-apply', 1, payload)).status).toBe(422);
    const response = await f.post('/settings/changes/' + f.changeId + '/recovery', 'fresh-recover', 1, payload);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { recovery_command_id: string; receipt: { change_id: string } } };
    expect(body.data.recovery_command_id).not.toBe(f.changeId);
    expect(body.data.receipt).toMatchObject({ change_id: f.changeId, phase: 'observed', verified: true, applied_revision: 1 });
    const stored = f.db.prepare('SELECT validation_id,control_receipt_id FROM settings_changes WHERE change_id=?').get(f.changeId);
    expect(stored).toEqual({ validation_id: f.original.validation_id, control_receipt_id: f.original.control_receipt_id });
    const settings = await (await f.get('/settings/changes/' + f.changeId)).json();
    expect(await (await f.get('/system/incidents/' + f.changeId)).json()).toEqual(settings);
    const counts = f.counts();
    f.expire();
    f.reopen();
    expect(await (await f.post('/settings/changes/' + f.changeId + '/recovery', 'fresh-recover', 1, payload)).json())
      .toMatchObject({ data: body.data });
    expect(f.counts()).toEqual(counts);
    expect(f.counts()).toMatchObject({ mutations: 1, restores: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM settings_changes').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM network_repair_operations').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT phase FROM settings_recoveries').get()).toEqual({ phase: 'observed' });
    expect(f.db.prepare('SELECT lock_token FROM network_device_state').get()).toEqual({ lock_token: null });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE json_extract(payload,'$.type')='work.requested'").get()).toEqual({ n: 0 });
  } finally { f.dispose(); }
});

test.each(['policy', 'expiry'] as const)('a %s change after host commit requires fresh projection-only recovery', async (race) => {
  const f = await fixture();
  try {
    const payload = await f.authorize(f.draft, 1);
    f.beforeProjection(() => {
      if (race === 'policy') f.db.prepare('UPDATE accounts SET policy_revision=2').run();
      else f.expire();
    });
    const response = await f.post('/settings/changes/' + f.changeId + '/recovery', 'host-committed', 1, payload);
    expect([403, 409]).toContain(response.status);
    expect(f.db.prepare('SELECT lock_token FROM network_device_state').get()).toEqual({ lock_token: null });
    const original = f.db.prepare('SELECT receipt FROM settings_changes').get() as { receipt: string };
    expect(JSON.parse(original.receipt)).toMatchObject({ phase: 'uncertain', verified: false });
    f.reopen();
    expect(await (await f.get('/settings/changes/' + f.changeId + '/recovery')).json()).toMatchObject({
      data: { status: 'projection_available' },
    });
    const fresh = await f.authorize(f.draft, 1);
    const projected = await f.post('/settings/changes/' + f.changeId + '/recovery', 'project-original', 1, fresh);
    expect(projected.status).toBe(200);
    expect(await projected.json()).toMatchObject({ data: { receipt: { change_id: f.changeId, phase: 'observed', verified: true } } });
    expect(f.counts()).toMatchObject({ mutations: 1, restores: 0 });
  } finally { f.dispose(); }
});

test('a later network epoch projects the historical result without adopting its old health', async () => {
  const f = await fixture();
  try {
    const payload = await f.authorize(f.draft, 1);
    f.beforeProjection(() => { throw new ApiError(503, 'UNAVAILABLE', { reason: 'fixture interruption' }); });
    expect((await f.post('/settings/changes/' + f.changeId + '/recovery', 'interrupted-projection', 1, payload)).status).toBe(503);
    f.db.prepare("UPDATE network_device_state SET epoch=2,owner_id='later-operation'").run();
    f.reopen();
    const next = await f.authorize(f.draft, 2);
    const response = await f.post('/settings/changes/' + f.changeId + '/recovery', 'historical-projection', 2, next);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { receipt: { change_id: f.changeId, verified: false,
      applied_revision: 1, phase: 'observed', issues: ['network_superseded'] } } });
    expect(f.db.prepare('SELECT epoch,owner_id FROM network_device_state').get()).toEqual({ epoch: 2, owner_id: 'later-operation' });
    expect(f.counts()).toMatchObject({ mutations: 1, restores: 0 });
  } finally { f.dispose(); }
});

test('fresh owner recovery accepts internally consistent historical authorization from another caller', async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE caller_scopes SET revoked_at='2026-11-17T08:00:00Z' WHERE caller_id='web'").run();
    f.currentOwner('replacement-owner');
    const payload = await f.authorize(f.draft, 1);
    const response = await f.post('/settings/changes/' + f.changeId + '/recovery', 'new-owner-recovery', 1, payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { receipt: { change_id: f.changeId, verified: true } } });
    expect(f.db.prepare('SELECT caller_id FROM settings_changes').get()).toEqual({ caller_id: 'web' });
    expect(f.db.prepare('SELECT caller_id FROM settings_recoveries').get()).toEqual({ caller_id: 'replacement-owner' });
  } finally { f.dispose(); }
});

test('two fresh recoveries compare ownership and only one original receipt CAS projects', async () => {
  const f = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  let notify!: () => void;
  const bothEntered = new Promise<void>((resolve) => { notify = resolve; });
  let first: Promise<Response> | undefined;
  let second: Promise<Response> | undefined;
  try {
    const one = await f.authorize(f.draft, 1);
    const two = await f.authorize(f.draft, 1);
    f.onReadback(async () => { entered += 1; if (entered === 2) notify(); await blocked; });
    first = f.post('/settings/changes/' + f.changeId + '/recovery', 'concurrent-one', 1, one);
    second = f.post('/settings/changes/' + f.changeId + '/recovery', 'concurrent-two', 1, two);
    await bothEntered;
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(f.db.prepare('SELECT phase FROM settings_recoveries ORDER BY phase').all()).toEqual([
      { phase: 'observed' }, { phase: 'superseded' },
    ]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM settings_changes').get()).toEqual({ n: 1 });
    expect(f.counts()).toMatchObject({ mutations: 1, restores: 0 });
  } finally { release(); await Promise.allSettled([first, second]); f.dispose(); }
});

test('projection readback settles at its abort deadline even when an observer does not settle', async () => {
  const f = await fixture();
  try {
    const payload = await f.authorize(f.draft, 1);
    f.beforeProjection(() => { throw new ApiError(503, 'UNAVAILABLE'); });
    expect((await f.post('/settings/changes/' + f.changeId + '/recovery', 'host-only', 1, payload)).status).toBe(503);
    f.reopen();
    const fresh = await f.authorize(f.draft, 1);
    f.onReadback(() => new Promise<void>(() => {}));
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 0);
      return controller.signal;
    });
    try {
      const response = f.post('/settings/changes/' + f.changeId + '/recovery', 'bounded-projection', 1, fresh);
      const result = await Promise.race([response.then(() => 'settled'), new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 25))]);
      expect(result).toBe('settled');
      expect(await (await response).json()).toMatchObject({ data: { receipt: { verified: false, issues: ['network_recheck'] } } });
    } finally { timeout.mockRestore(); }
  } finally { f.dispose(); }
});

test.each(['missing-rule', 'restore-pending', 'foreign-owner', 'wrong-draft', 'missing-operation'] as const)(
  'recovery eligibility fails closed for %s', async (fault) => {
    const f = await fixture();
    try {
      if (fault === 'missing-rule') f.db.prepare('UPDATE network_repair_attempts SET changed_rule=NULL').run();
      if (fault === 'restore-pending') f.db.prepare('UPDATE network_repair_attempts SET restore_epoch=2').run();
      if (fault === 'foreign-owner') f.db.prepare("UPDATE network_device_state SET owner_id='foreign'").run();
      if (fault === 'wrong-draft') f.db.prepare('UPDATE settings_validations SET draft_hash=? WHERE validation_id=?')
        .run('0'.repeat(64), f.original.validation_id);
      if (fault === 'missing-operation') {
        f.db.prepare('DELETE FROM network_repair_attempts').run();
        f.db.prepare('DELETE FROM network_repair_operations').run();
      }
      const response = await f.get('/settings/changes/' + f.changeId + '/recovery');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { status: 'unavailable' } });
      expect(f.db.prepare('SELECT lock_token FROM network_device_state').get()).toMatchObject({ lock_token: expect.any(String) });
      expect(f.counts()).toMatchObject({ mutations: 1, restores: 0 });
    } finally { f.dispose(); }
  });

test('a settings reader receives an owner-required offer without losing read scope', async () => {
  const f = await fixture();
  try {
    const response = await f.get('/settings/changes/' + f.changeId + '/recovery', f.reader);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { status: 'unavailable', reason: 'owner_required' } });
  } finally { f.dispose(); }
});

test.each(['logout', 'owner', 'policy', 'expiry', 'epoch', 'rule'] as const)('readback rechecks fresh %s authority before releasing the lock', async (race) => {
  const f = await fixture();
  try {
    const payload = await f.authorize(f.draft, 1);
    f.onReadback(() => {
      if (race === 'logout') f.db.prepare("DELETE FROM sessions WHERE caller_id='web'").run();
      if (race === 'owner') f.db.prepare("UPDATE caller_scopes SET revoked_at='2026-11-17T08:00:00Z' WHERE caller_id='web'").run();
      if (race === 'policy') f.db.prepare('UPDATE accounts SET policy_revision=2').run();
      if (race === 'expiry') f.expire();
      if (race === 'epoch') f.db.prepare('UPDATE network_device_state SET epoch=2').run();
      if (race === 'rule') f.replaceRule();
    });
    const response = await f.post('/settings/changes/' + f.changeId + '/recovery', 'racing-recovery', 1, payload);
    expect([200, 401, 403, 409]).toContain(response.status);
    const row = f.db.prepare('SELECT receipt FROM settings_changes').get() as { receipt: string };
    expect(JSON.parse(row.receipt).verified).toBe(false);
    expect(f.db.prepare('SELECT lock_token FROM network_device_state').get()).toMatchObject({ lock_token: expect.any(String) });
    expect(f.counts()).toMatchObject({ mutations: 1, restores: 0 });
  } finally { f.dispose(); }
});

test('recovery rejects changed path, extra input, ordinary repair controls and spent proofs', async () => {
  const f = await fixture();
  try {
    const payload = await f.authorize(f.draft, 1);
    expect((await f.post('/settings/changes/other/recovery', 'wrong-path', 1, payload)).status).toBe(403);
    expect((await f.post('/settings/validations', 'extra-input', 1, {
      ...f.draft, input: { change_id: f.changeId, repair_id: 'fixed-dns' },
    })).status).toBe(403);
    expect((await f.post('/settings/changes/' + f.changeId + '/recovery', 'old-control', 1, {
      ...payload, control_receipt_id: f.original.control_receipt_id,
    })).status).toBe(403);
    expect((await f.post('/settings/changes/' + f.changeId + '/recovery', 'correct', 1, payload)).status).toBe(200);
    expect((await f.post('/settings/changes/' + f.changeId + '/recovery', 'spent', 1, payload)).status).toBe(409);
    expect((await f.post('/settings/changes/' + f.changeId + '/recovery', 'correct', 1, {
      ...payload, control_receipt_id: 'different',
    })).status).toBe(409);
    expect(f.counts()).toMatchObject({ mutations: 1, restores: 0 });
  } finally { f.dispose(); }
});
