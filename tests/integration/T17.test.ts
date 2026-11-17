import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { openDatabase } from '@patrick/storage';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { createFeishuChannel } from '../../packages/integrations/feishu/connection.js';
import { createLocalHubPort, encodeHubAnswer } from '@patrick/integrations/autoloop/answers';
import { connectVault, requireVault } from '@patrick/integrations/vault/connection';
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession, ORIGIN, RP_ID, type Principal } from '../../apps/service/src/auth.js';
import { createSettingsChanges, type SettingsDraft } from '../../apps/service/src/settings/changes.js';
import { builtinSettingsHandlers } from '../../apps/service/src/settings/builtin.js';

const initial = '2026-11-17T04:00:00.000Z';
const owner: Principal = {
  account_id: 'owner', caller_id: 'web', auth_epoch: 1, authenticated_at: initial, domains: ['personal'], operations: ['owner'],
};
const draft: SettingsDraft = {
  operation: 'change_vault', domain: 'personal', target: 'vault-a',
  input: { selected_location: 'first-choice' },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t17-'));
  const db = openDatabase(join(root, 'settings.sqlite'));
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(owner.account_id, 1, 1, initial);
  db.prepare("INSERT INTO caller_scopes VALUES ('owner','web','personal','owner',NULL)").run();
  let time = new Date(initial);
  let revision = 4;
  let device = 'desktop-a';
  const authorize = vi.fn();
  const apply = vi.fn(async () => {
    revision += 1;
    return { revision, effects: [{ item: 'root', outcome: 'applied' as const, revision }] };
  });
  const recheck = vi.fn(async () => ({ verified: false, issue: 'source_unreachable' }));
  const engine = createSettingsChanges({
    db, now: () => time, ttlMs: 10_000,
    handlers: {
      change_vault: {
        binding: () => ({ revision, deviceId: device, identityId: 'editor-a', scopeHash: 'a'.repeat(64) }),
        validate: async () => ({ valid: true }), authorize, apply, recheck,
      },
    },
  });
  return { root, db, engine, authorize, apply, recheck, changeClock: (ms: number) => { time = new Date(+time + ms); },
    changeDevice: (name: string) => { device = name; }, dispose() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

const fileProbe = vi.hoisted(() => ({ afterAccess: undefined as ((path: string) => void) | undefined }));
vi.mock(import('node:fs/promises'), async (load) => {
  const fs = await load();
  return { ...fs, async access(path: Parameters<typeof fs.access>[0], mode?: number) {
    await fs.access(path, mode);
    if (typeof path === 'string') fileProbe.afterAccess?.(path);
  } };
});

test.each(['draft', 'device', 'expired'] as const)('a %s change makes the saved validation ineligible', async (changed) => {
  const fx = fixture();
  try {
    const proof = await fx.engine.validateSettings(owner, draft);
    if (changed === 'device') fx.changeDevice('desktop-b');
    if (changed === 'expired') fx.changeClock(11_000);
    await expect(fx.engine.submitSettings(owner, {
      validationId: proof.validation_id, requestId: 'same-request', controlReceiptId: 'receipt-a',
      draft: changed === 'draft' ? { ...draft, input: { selected_location: 'second-choice' } } : draft,
    })).rejects.toThrow('VALIDATION_STALE');
    expect(fx.authorize).not.toHaveBeenCalled();
    expect(fx.apply).not.toHaveBeenCalled();
  } finally { fx.dispose(); }
});

test('a failed recheck preserves the actual applied revision and same-request replay does not apply twice', async () => {
  const fx = fixture();
  try {
    const proof = await fx.engine.validateSettings(owner, draft);
    const request = { validationId: proof.validation_id, requestId: 'first-change', controlReceiptId: 'receipt-a', draft };
    const receipt = await fx.engine.submitSettings(owner, request);
    expect(receipt).toMatchObject({ applied_revision: 5, verified: false, phase: 'observed',
      issues: ['source_unreachable'], effects: [{ item: 'root', outcome: 'applied', revision: 5 }] });
    expect(await fx.engine.submitSettings(owner, request)).toEqual(receipt);
    expect(fx.engine.readChange(owner, receipt.change_id)).toEqual(receipt);
    expect(fx.apply).toHaveBeenCalledTimes(1);
    expect(fx.recheck).toHaveBeenCalledTimes(1);
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE json_extract(payload,'$.type')='work.requested'").get())
      .toEqual({ n: 0 });
  } finally { fx.dispose(); }
});

test('preferences are account scoped, whitelisted and replay their original CAS receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t17-prefs-'));
  const databasePath = join(root, 'preferences.sqlite');
  const credentialDirectory = join(root, 'creds');
  const now = () => new Date(initial);
  const db = openDatabase(databasePath);
  try {
    const credentials = createCredentialStore(credentialDirectory, now);
    for (const name of ['owner', 'other']) db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(name, 1, 1, initial);
    const session = (name: string) => issueCallerSession(db, {
      accountId: name, callerId: 'web', domain: 'personal', permissions: ['work.read'],
    }, now, credentials).authorization;
    const ownerAuth = session('owner');
    const otherAuth = session('other');
    const app = createApp({ databasePath, credentialDirectory, now });
    const prefs = '/api/v1/preferences';
    const read = (authorization: string) => app.request(prefs, { headers: { authorization } });
    const patch = (client_request_id: string, expected_revision: number, changes: Json, auth = ownerAuth, auth_epoch = 1) => {
      const payload = { account_id: 'owner', auth_epoch, changes };
      return app.request(prefs, { method: 'PATCH', headers: { authorization: auth, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ client_request_id, expected_revision, payload_hash: createHash('sha256')
          .update(canonicalPayload(payload)).digest('hex'), payload }) });
    };
    const first = await read(ownerAuth);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ data: { revision: 0, mode: 'system' } });
    expect((await patch('stale-tab', 0, { mode: 'zh' }, otherAuth)).status).toBe(403);
    expect((await patch('stale-epoch', 0, { mode: 'zh' }, ownerAuth, 0)).status).toBe(403);
    expect(await (await read(otherAuth)).json()).toMatchObject({ data: { revision: 0, mode: 'system' } });
    const firstSave = await patch('prefs-1', 0, { mode: 'zh' });
    expect(firstSave.status).toBe(200);
    const receipt = await firstSave.json();
    expect(receipt).toMatchObject({ data: { revision: 1, mode: 'zh' } });
    expect((await patch('prefs-2', 1, { reduced_motion: true })).status).toBe(200);
    expect(await (await patch('prefs-1', 0, { mode: 'zh' })).json()).toEqual(receipt);
    expect((await patch('prefs-2', 1, { reduced_motion: false })).status).toBe(409);
    expect((await patch('prefs-3', 0, { mode: 'en' })).status).toBe(409);
    expect((await patch('prefs-4', 2, { budget: 42 })).status).toBe(422);
    expect(await (await read(ownerAuth)).json()).toMatchObject({ data: { revision: 2, mode: 'zh', reduced_motion: true } });
    expect(await (await read(otherAuth)).json()).toMatchObject({ data: { revision: 0, mode: 'system', reduced_motion: false } });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings and system return the same scoped change receipt after trusted approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t17-router-'));
  const databasePath = join(root, 'settings.sqlite');
  const credentialDirectory = join(root, 'creds');
  const now = () => new Date(initial);
  const db = openDatabase(databasePath);
  try {
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(owner.account_id, 1, 1, initial);
    const session = issueCallerSession(db, { accountId: owner.account_id, callerId: owner.caller_id,
      domain: 'personal', permissions: ['owner'] }, now, createCredentialStore(credentialDirectory, now));
    let revision = 7;
    const authorize = vi.fn();
    const app = createApp({ databasePath, credentialDirectory, now, settingsHandlers: {
      change_vault: {
        binding: () => ({ revision, deviceId: 'desktop', identityId: 'editor', scopeHash: 'a'.repeat(64) }),
        validate: async () => ({ valid: true }), authorize,
        apply: async () => ({ revision: ++revision, effects: [{ item: 'root', outcome: 'applied', revision }] }),
        recheck: async () => ({ verified: false, issue: 'source_unreachable' }),
      },
    } });
    const headers = { authorization: session.authorization };
    const post = (path: string, client_request_id: string, expected_revision: number | null, payload: Json) =>
      app.request('/api/v1' + path, { method: 'POST', headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ client_request_id, expected_revision, payload_hash: createHash('sha256')
          .update(canonicalPayload(payload)).digest('hex'), payload }) });
    const dashboard = await app.request('/api/v1/settings?domain=personal', { headers });
    expect(dashboard.status).toBe(200);
    expect((await dashboard.json() as { data: { groups: unknown[] } }).data.groups).toHaveLength(6);
    const [validation, repeated] = await Promise.all([
      post('/settings/validations', 'validate-1', 7, draft),
      post('/settings/validations', 'validate-1', 7, draft),
    ]);
    expect([validation.status, repeated.status]).toEqual([200, 200]);
    const firstBody = await validation.json() as { data: { validation_id: string } };
    const { data: proof } = firstBody;
    expect(proof).toMatchObject({ base_revision: 7, valid: true });
    expect(await repeated.json()).toEqual(firstBody);
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings_validations').get()).toEqual({ n: 1 });
    expect((await post('/settings/validations', 'validate-1', 7, { ...draft, input: { selected_location: 'different' } })).status).toBe(409);
    const payload: Json = { draft, validation_id: proof.validation_id, control_receipt_id: 'trusted-fixture' };
    expect((await post('/settings/changes', 'wrong-revision', 6, payload)).status).toBe(409);
    expect(authorize).not.toHaveBeenCalled();
    const change = await post('/settings/changes', 'apply-1', 7, payload);
    expect(change.status).toBe(202);
    const accepted = await change.json() as { receipt_url: string; command_id: string };
    expect(accepted.receipt_url).toBe('/api/v1/settings/changes/' + accepted.command_id);
    const receipt = await app.request(accepted.receipt_url, { headers });
    const incident = await app.request('/api/v1/system/incidents/' + accepted.command_id, { headers });
    expect(receipt.status).toBe(200);
    expect(incident.status).toBe(200);
    expect(await incident.json()).toEqual(await receipt.json());
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['still-bound', 'revoked', 'remapped', 'expired', 'replaced', 'logged-out'] as const)(
  'Vault confirmation only writes with live root, mapping and authorization: %s', async (change) => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t17-vault-'));
  const databasePath = join(root, 'settings.sqlite');
  const credentialDirectory = join(root, 'creds');
  let time = new Date(initial);
  const now = () => time;
  const db = openDatabase(databasePath);
  try {
    mkdirSync(join(root, 'test-Vault'));
    const credentials = createCredentialStore(credentialDirectory, now);
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(owner.account_id, 1, 1, initial);
    const session = issueCallerSession(db, { accountId: owner.account_id, callerId: owner.caller_id,
      domain: 'personal', permissions: ['owner'] }, now, credentials);
    await connectVault(db, { accountId: owner.account_id, deviceId: 'desktop', vaultId: 'vault-t17',
      root: join(root, 'test-Vault'), domain: 'personal', captureHost: hostname(), now: initial });
    const app = createApp({ databasePath, credentialDirectory, now });
    const post = (route: string, client_request_id: string, expected_revision: number, payload: Json) =>
      app.request('/api/v1' + route, { method: 'POST', headers: { authorization: session.authorization,
        origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ client_request_id, expected_revision, payload, payload_hash: createHash('sha256')
          .update(canonicalPayload(payload)).digest('hex') }) });
    const draft = { operation: 'connect_vault', domain: 'personal', target: 'vault-t17', input: { device_id: 'desktop' } };
    if (change === 'still-bound') {
      renameSync(join(root, 'test-Vault'), join(root, 'temporarily-missing'));
      const missing = await post('/settings/validations', 'missing-proof', 1, draft);
      expect(missing.status).toBe(200);
      expect(await missing.json()).toMatchObject({ data: { valid: false } });
      renameSync(join(root, 'temporarily-missing'), join(root, 'test-Vault'));
    }
    const validated = await post('/settings/validations', 'proof', 1, draft);
    expect(validated.status).toBe(200);
    const { data: proof } = await validated.json() as { data: { validation_id: string; draft_hash: string; valid: boolean } };
    expect(proof.valid).toBe(true);
    const apply = (id: string) => post('/settings/changes', 'apply', 1, { draft, validation_id: proof.validation_id, control_receipt_id: id });
    expect((await apply('guess')).status).toBe(403);
    expect(requireVault(db, draft.target).status).toBe('awaiting_confirmation');
    const challenge = await app.request('/api/v1/auth/challenge', { method: 'POST',
      headers: { authorization: session.authorization, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ rp_id: RP_ID }) });
    expect(challenge.status).toBe(200);
    const { challenge_id } = await challenge.json() as { challenge_id: string };
    const stage = await post('/settings/control-proposals', 'prepare', 1, { draft, validation_id: proof.validation_id, challenge_id });
    expect(stage.status).toBe(200);
    const firstStage = await stage.clone().json();
    if (change === 'still-bound') {
      expect(await (await post('/settings/control-proposals', 'prepare', 1, { draft, validation_id: proof.validation_id, challenge_id })).json())
        .toEqual(firstStage);
      expect((await post('/settings/control-proposals', 'prepare', 1, { draft, validation_id: proof.validation_id, challenge_id: 'different' })).status).toBe(409);
    }
    const { data: proposal } = await stage.json() as { data: { proposal_hash: string; proposal_id: string; base_revision: number } };
    expect(proposal).toMatchObject({ base_revision: 1, proposal_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(requireVault(db, draft.target).status).toBe('awaiting_confirmation');
    const confirmed = await post('/control-proposals/' + proposal.proposal_id + '/confirm', 'confirm', proposal.base_revision,
      { proposal_hash: proposal.proposal_hash, challenge_id });
    expect(confirmed.status).toBe(202);
    const accepted = await confirmed.json() as { receipt_url: string };
    const lookedUp = await app.request(accepted.receipt_url, { headers: { authorization: session.authorization } });
    expect(lookedUp.status).toBe(200);
    const { data: { control_receipt_id: receipt_id } } = await lookedUp.json() as { data: { control_receipt_id: string } };
    if (change === 'still-bound') {
      expect(await (await post('/settings/control-proposals', 'prepare', 1, { draft, validation_id: proof.validation_id, challenge_id })).json())
        .toEqual(firstStage);
    }
    fileProbe.afterAccess = (path) => {
      if (!path.endsWith('/test-Vault')) return;
      fileProbe.afterAccess = undefined;
      if (change === 'revoked') db.prepare("UPDATE caller_scopes SET revoked_at=? WHERE account_id='owner' AND permission='owner'").run(initial);
      if (change === 'remapped') db.prepare("UPDATE vault_clients SET mapping_revision=mapping_revision+1 WHERE vault_id='vault-t17'").run();
      if (change === 'expired') time = new Date(+time + 120_001);
      if (change === 'logged-out') db.prepare("DELETE FROM sessions WHERE account_id='owner' AND caller_id='web'").run();
      if (change === 'replaced') {
        renameSync(join(root, 'test-Vault'), join(root, 'displaced'));
        mkdirSync(join(root, 'test-Vault'));
      }
    };
    expect((await apply(receipt_id)).status).toBe(202);
    if (change !== 'still-bound') {
      expect(requireVault(db, draft.target)).toMatchObject({ status: 'awaiting_confirmation', connection_epoch: 0 });
      const stored = db.prepare('SELECT phase,receipt FROM settings_changes').get() as { phase: string; receipt: string };
      expect(stored.phase).toBe('observed');
      expect(JSON.parse(stored.receipt)).toMatchObject({ verified: false, applied_revision: null, effects: [{ outcome: 'blocked' }] });
      return;
    }
    expect(requireVault(db, draft.target)).toMatchObject({ status: 'connected', connection_epoch: 1 });
    expect((await apply(receipt_id)).status).toBe(202);
    expect(requireVault(db, draft.target).connection_epoch).toBe(1);
  } finally {
    fileProbe.afterAccess = undefined;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a second validation cannot send a competing change while the target result is unresolved', async () => {
  const fx = fixture();
  try {
    const first = await fx.engine.validateSettings(owner, draft);
    const second = await fx.engine.validateSettings(owner, draft);
    let rejectApply!: (error: Error) => void;
    fx.apply.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectApply = reject; }));
    const started = fx.engine.submitSettings(owner, {
      validationId: first.validation_id, requestId: 'change-first', controlReceiptId: 'proof-first', draft,
    });
    try {
      await expect(fx.engine.submitSettings(owner, {
        validationId: second.validation_id, requestId: 'change-second', controlReceiptId: 'proof-second', draft,
      })).rejects.toThrow('CONFLICT');
      expect(fx.apply).toHaveBeenCalledTimes(1);
    } finally {
      rejectApply(new Error('simulated lost apply response'));
      await expect(started).resolves.toMatchObject({ phase: 'uncertain' });
    }
    await expect(fx.engine.submitSettings(owner, {
      validationId: second.validation_id, requestId: 'change-second', controlReceiptId: 'proof-second', draft,
    })).rejects.toThrow('CONFLICT');
  } finally { fx.dispose(); }
});

test.each([false, true])('a trusted Feishu stop fences old permits, pending=%s', async (pending) => {
  const fx = fixture();
  try {
    const at = initial;
    fx.db.prepare(`INSERT INTO channel_connections(connection_id,account_id,data_domain,app_id,tenant_key,credential_ref,
      credential_version,config_revision,channel_incarnation,connection_epoch,binding_revision,status,transport_mode,schema_version,created_at,updated_at)
      VALUES ('t17-channel','owner','personal','t17-app','t17-tenant','fixture-only',1,7,1,9,1,'ready','active','1.0',?,?)`).run(at, at);
    if (pending) fx.db.prepare(`INSERT INTO channel_permits(permit_id,connection_id,inbound_id,question_id,account_id,
      permit_recorded,dispatch_seq,terminal,incarnation,epoch,config_revision,binding_revision,schema_version,created_at)
      VALUES ('t17-permit','t17-channel','in-t17','question-t17','owner',1,43,0,1,9,7,1,'1.0',?)`).run(at);
    const channel = createFeishuChannel(fx.db, { domain: 'personal', connectionId: 't17-channel',
      now: () => new Date(at), encode: encodeHubAnswer, hub: createLocalHubPort(join(fx.root, 'unused-hub')) });
    const target = { accountId: 'owner', configRevision: 7, epoch: 9 };
    await expect(channel.disableTrusted({ ...target, epoch: 8 })).rejects.toThrow('BINDING_STALE');
    const stopped = await channel.disableTrusted(target);
    expect(stopped).toEqual({ status: pending ? 'draining' : 'disabled', epoch: 10 });
    await expect(channel.disableTrusted(target)).rejects.toThrow('BINDING_STALE');
    expect(fx.db.prepare('SELECT status,transport_mode,connection_epoch,cutoff_seq FROM channel_connections WHERE connection_id=?')
      .get('t17-channel')).toEqual(pending
      ? { status: 'draining', transport_mode: 'draining', connection_epoch: 10, cutoff_seq: 43 }
      : { status: 'disabled', transport_mode: 'disabled', connection_epoch: 10, cutoff_seq: null });
    if (pending) expect(fx.db.prepare('SELECT cutoff FROM channel_permits WHERE permit_id=?').get('t17-permit')).toEqual({ cutoff: 43 });
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE json_extract(payload,'$.type')='channel.mode.changed'").get())
      .toEqual({ n: 1 });
  } finally { fx.dispose(); }
});

const channelRaces = ['enable_feishu', 'disable_feishu'].flatMap((operation) =>
  ['none', 'permission', 'binding'].map((race) => ({ operation, race })));

test.each(channelRaces)('Feishu $operation rechecks its original receipt at the channel writer ($race)', async ({ operation, race }) => {
  const fx = fixture();
  const databasePath = join(fx.root, 'settings.sqlite');
  const credentialDirectory = join(fx.root, 'creds');
  const now = () => new Date(initial);
  const peer = openDatabase(databasePath);
  const hub = createLocalHubPort(join(fx.root, 'unused-hub'));
  try {
    const enable = operation === 'enable_feishu';
    const credentials = createCredentialStore(credentialDirectory, now);
    const session = issueCallerSession(fx.db, { accountId: owner.account_id, callerId: owner.caller_id,
      domain: 'personal', permissions: ['owner'] }, now, credentials);
    fx.db.prepare(`INSERT INTO channel_connections(connection_id,account_id,data_domain,app_id,tenant_key,credential_ref,
      credential_version,config_revision,channel_incarnation,connection_epoch,binding_revision,status,transport_mode,schema_version,created_at,updated_at)
      VALUES ('fence-channel','owner','personal','fence-app','fence-tenant','fixture-only',1,7,1,9,1,'ready','active','1.0',?,?)`)
      .run(initial, initial);
    const channel = createFeishuChannel(fx.db, { domain: 'personal', connectionId: 'fence-channel', now, hub, encode: encodeHubAnswer });
    if (enable) await channel.recordTestCallback(await channel.prepareSentTest());
    const settings = builtinSettingsHandlers({ db: fx.db, credentials, now, hub: () => hub, host: 'test-host' });
    const handler = settings[operation];
    let checkedWriter = false;
    const engine = createSettingsChanges({ db: fx.db, now, handlers: { [operation]: {
      ...handler,
      async apply(principal, draft, proof, beforeWrite) {
        const claim = peer.prepare('SELECT phase,control_receipt_id FROM settings_changes').get();
        expect(claim).toMatchObject({ phase: 'applying', control_receipt_id: expect.any(String) });
        expect(fx.db.inTransaction).toBe(false);
        if (race === 'permission') {
          peer.prepare("UPDATE caller_scopes SET revoked_at=? WHERE account_id='owner' AND caller_id='web' AND permission='owner'")
            .run(initial);
        }
        if (race === 'binding') {
          const replaceBinding = peer.transaction(() => {
            peer.prepare("UPDATE channel_connections SET binding_revision=2 WHERE connection_id='fence-channel'").run();
            if (enable) peer.prepare("UPDATE channel_bindings SET binding_revision=2 WHERE connection_id='fence-channel'").run();
          });
          replaceBinding.immediate();
        }
        return handler.apply(principal, draft, proof, () => {
          expect(fx.db.inTransaction).toBe(true);
          checkedWriter = true;
          return beforeWrite();
        });
      },
    } } });
    const draft = { operation, domain: 'personal', target: 'fence-channel', input: null };
    const proof = await engine.validateSettings(owner, draft, 7);
    expect(proof.valid).toBe(true);
    const app = createApp({ databasePath, credentialDirectory, now });
    const headers = { authorization: session.authorization, origin: ORIGIN, 'content-type': 'application/json' };
    const challenge = await app.request('/api/v1/auth/challenge', { method: 'POST', headers, body: JSON.stringify({ rp_id: RP_ID }) });
    expect(challenge.status).toBe(200);
    const { challenge_id } = await challenge.json() as { challenge_id: string };
    const { data: proposal } = engine.prepareControl(owner, draft, proof.validation_id, challenge_id, 7, 'prepare-channel-change');
    const payload = { challenge_id, proposal_hash: proposal.proposal_hash };
    const confirmed = await app.request('/api/v1/control-proposals/' + proposal.proposal_id + '/confirm', {
      method: 'POST', headers, body: JSON.stringify({ client_request_id: 'confirm-channel-change', expected_revision: proposal.base_revision,
        payload, payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex') }),
    });
    expect(confirmed.status).toBe(202);
    const { receipt_id } = peer.prepare('SELECT receipt_id FROM control_receipts WHERE proposal_id=?').get(proposal.proposal_id) as
      { receipt_id: string };
    const receipt = await engine.submitSettings(owner, { draft, validationId: proof.validation_id, expectedRevision: 7,
      controlReceiptId: receipt_id, requestId: 'apply-channel-change' });
    expect(checkedWriter).toBe(true);
    const final = peer.prepare('SELECT status,config_revision,binding_revision,connection_epoch FROM channel_connections WHERE connection_id=?')
      .get('fence-channel');
    const effectCount = peer.prepare('SELECT COUNT(*) AS n FROM channel_receipts').get();
    if (race !== 'none') {
      expect(receipt).toMatchObject({ phase: 'observed', verified: false, applied_revision: null,
        issues: ['confirmation_changed'], effects: [{ outcome: 'blocked' }] });
      expect(final).toEqual({ status: enable ? 'needs_enable' : 'ready', config_revision: 7,
        binding_revision: race === 'binding' ? 2 : 1, connection_epoch: 9 });
      expect(effectCount).toEqual({ n: 0 });
    } else {
      expect(receipt).toMatchObject({ phase: 'observed', verified: true, effects: [{ outcome: 'applied' }] });
      expect(final).toEqual({ status: enable ? 'ready' : 'disabled', config_revision: 7,
        binding_revision: 1, connection_epoch: enable ? 9 : 10 });
      expect(effectCount).toEqual({ n: 1 });
    }
  } finally {
    hub.close();
    peer.close();
    fx.dispose();
  }
});
