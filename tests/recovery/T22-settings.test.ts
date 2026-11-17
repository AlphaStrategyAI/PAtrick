import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { canonicalPayload } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { createBlobStore, createRecoveryRuntimeGate, openDatabase, recoveryWriteAllowed } from '@patrick/storage';
import { createSettingsChanges, type SettingsHandler } from '../../apps/service/src/settings/changes.js';
import { ORIGIN, RP_ID, runWithAuth, type Principal } from '../../apps/service/src/auth.js';
import { confirmControl } from '../../apps/service/src/control.js';
import { builtinSettingsHandlers } from '../../apps/service/src/settings/builtin.js';
import { sourceSettingsHandlers } from '../../apps/service/src/settings/sources.js';
import { connectVault } from '../../packages/integrations/vault/connection.js';
import { createLocalHubPort } from '../../packages/integrations/autoloop/answers.js';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';

const at = '2026-11-17T04:00:00.000Z';
const owner: Principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, authenticated_at: at,
  domains: ['personal'], operations: ['owner'] };
const draft = { operation: 'change_vault', domain: 'personal', target: 'vault', input: null };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t22-settings-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(at);
  db.prepare("INSERT INTO caller_scopes VALUES ('owner','web','personal','owner',NULL)").run();
  db.prepare("INSERT INTO recovery_domain_gates VALUES ('personal','epoch-a','open','activation','witness',NULL,NULL,?)").run(at);
  const gate = createRecoveryRuntimeGate(db);
  gate.admit({ domain: 'personal', writerEpoch: 'epoch-a', activationId: 'activation', witnessRevision: 'witness' });
  return { root, db, gate };
}

test.each(['binding', 'authorize', 'clock'] as const)('settings %s closure rejects before new command authority', async (callback) => {
  const f = fixture();
  let armed = false;
  let writes = 0;
  const close = () => { if (armed) f.gate.revoke('personal'); };
  const engine = createSettingsChanges({ db: f.db, now() { if (callback === 'clock') close(); return new Date(at); }, handlers: {
    change_vault: {
      binding() { if (callback === 'binding') close(); return { revision: 0, deviceId: 'host', identityId: 'owner', scopeHash: 'a'.repeat(64) }; },
      validate: async () => ({ valid: true }), authorize() { if (callback === 'authorize') close(); },
      async apply(_p, _d, _v, beforeWrite) { beforeWrite(); writes++; return { revision: 1, effects: [] }; },
      recheck: async () => ({ verified: true }),
    },
  } });
  const proof = await engine.validateSettings(owner, draft);
  armed = true;
  await expect(engine.submitSettings(owner, { draft, validationId: proof.validation_id,
    requestId: 'apply', controlReceiptId: 'receipt' }))
    .rejects.toMatchObject({ status: 409, message: 'CONFLICT', params: { reason: 'recovery_write_blocked' } });
  expect(writes).toBe(0);
  for (const table of ['command_inbox', 'command_records', 'settings_changes']) {
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
});

test.each(['binding', 'authorize', 'revalidate'] as const)('adapter final %s callback cannot write after epoch drift', async (callback) => {
  const f = fixture();
  let applying = false;
  let writes = 0;
  const drift = () => { if (applying) f.db.prepare("UPDATE recovery_domain_gates SET writer_epoch='epoch-b'").run(); };
  const handler: SettingsHandler = {
    binding() { if (callback === 'binding') drift(); return { revision: 0, deviceId: 'host', identityId: 'owner', scopeHash: 'a'.repeat(64) }; },
    validate: async () => ({ valid: true }), authorize() { if (callback !== 'binding') drift(); },
    async apply(_p, _d, _v, beforeWrite, revalidate) {
      await Promise.resolve(); applying = true;
      if (callback === 'revalidate') revalidate!(); else beforeWrite();
      writes++; return { revision: 1, effects: [] };
    },
    recheck: async () => ({ verified: true }),
  };
  const engine = createSettingsChanges({ db: f.db, now: () => new Date(at), handlers: { change_vault: handler } });
  const proof = await engine.validateSettings(owner, draft);
  const receipt = await engine.submitSettings(owner, { draft, validationId: proof.validation_id, requestId: 'apply', controlReceiptId: 'receipt' });
  expect(writes).toBe(0);
  expect(receipt).toMatchObject({ phase: 'observed', verified: false, issues: ['confirmation_changed'],
    effects: [{ item: 'settings_target', outcome: 'blocked', revision: null }] });
  expect(await engine.submitSettings(owner, { draft, validationId: proof.validation_id, requestId: 'apply', controlReceiptId: 'receipt' })).toEqual(receipt);
});

test.each(['disable_feishu', 'start_backup', 'start_restore', 'pause_http_source', 'disconnect_http_source'])('registered trusted %s controls remain usable while closed', async (operation) => {
  const f = fixture(); f.gate.revoke('personal'); let writes = 0;
  const engine = createSettingsChanges({ db: f.db, now: () => new Date(at), handlers: { [operation]: {
    binding: () => ({ revision: 0, deviceId: 'host', identityId: 'owner', scopeHash: 'a'.repeat(64) }),
    validate: async () => ({ valid: true }), authorize() {},
    async apply(_p, _d, _v, beforeWrite) { beforeWrite(); writes++; return { revision: 1, effects: [] }; },
    recheck: async () => ({ verified: true }),
  } } });
  const control = { ...draft, operation };
  const proof = await engine.validateSettings(owner, control);
  expect((await engine.submitSettings(owner, { draft: control, validationId: proof.validation_id, requestId: 'control', controlReceiptId: 'receipt' })).verified).toBe(true);
  expect(writes).toBe(1);
});


test.each([
  { kind: 'vault', race: 'target-domain' },
  { kind: 'source', race: 'target-domain' },
  { kind: 'vault', race: 'binding-closure' },
] as const)('final claim $race refuses new authority with the real $kind handler', async ({ kind, race }) => {
  const f = fixture(); const now = () => new Date(at);
  const credentials = createCredentialStore(join(f.root, 'credentials'), now);
  let target: string;
  let handler: SettingsHandler;
  let operation: string;
  let input: { device_id: string } | { frequency: string };
  if (kind === 'vault') {
    const root = join(f.root, 'vault'); mkdirSync(root);
    await connectVault(f.db, { accountId: 'owner', deviceId: 'device', vaultId: 'vault', root,
      domain: 'personal', captureHost: 'test-host', now: at });
    target = 'vault'; operation = 'connect_vault'; input = { device_id: 'device' };
    handler = builtinSettingsHandlers({ db: f.db, now, credentials, host: 'test-host',
      hub: () => createLocalHubPort(join(f.root, 'hub')) })[operation];
  } else {
    const url = 'https://feed.example.test/news';
    const registry = createSourceRegistry(f.db, { blobs: createBlobStore(join(f.root, 'blobs')), now: () => at,
      http: { approvedUrls: () => [url], port: { async resolve() { throw new Error('UNEXPECTED_NETWORK_READ'); },
        async request() { throw new Error('UNEXPECTED_NETWORK_READ'); } } } });
    const enabled = await registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'rss', target: url });
    target = enabled.sourceId; operation = 'modify_http_source'; input = { frequency: '1h' };
    handler = sourceSettingsHandlers({ db: f.db, now, credentials, registry })[operation];
  }
  let armed = false; let calls = 0; let bindings = 0;
  const checkedHandler: SettingsHandler = { ...handler, binding(principal, currentDraft) {
    const bound = handler.binding(principal, currentDraft);
    if (armed && ++bindings === 2 && race === 'binding-closure') f.gate.revoke('personal');
    return bound;
  } };
  const engine = createSettingsChanges({ db: f.db, handlers: { [operation]: checkedHandler }, now() {
    if (armed && ++calls === 2 && race === 'target-domain') {
      const table = kind === 'vault' ? 'vaults' : 'source_configs';
      const key = kind === 'vault' ? 'vault_id' : 'source_id';
      f.db.prepare(`UPDATE ${table} SET data_domain='other' WHERE ${key}=?`).run(target);
      expect(recoveryWriteAllowed(f.db, 'personal')).toBe(true);
      expect(recoveryWriteAllowed(f.db, 'other')).toBe(false);
    }
    return now();
  } });
  const requestDraft = { operation, domain: 'personal', target, input };
  const proof = await engine.validateSettings(owner, requestDraft);
  expect(proof.valid).toBe(true);
  f.db.prepare(`INSERT INTO auth_challenges(challenge_id,account_id,purpose,challenge,challenge_hash,origin,rp_id,expires_at,created_at)
    VALUES ('challenge','owner','control','value',?,?,?,?,?)`).run('a'.repeat(64), ORIGIN, RP_ID, '2026-11-17T04:02:00.000Z', at);
  const { data: proposal } = engine.prepareControl(owner, requestDraft, proof.validation_id, 'challenge', proof.base_revision, 'prepare');
  const payload = { proposal_hash: proposal.proposal_hash, challenge_id: 'challenge' };
  const control = await runWithAuth({ db: f.db, now, credentials }, () => confirmControl(owner, {
    proposal_id: proposal.proposal_id, proposal_hash: proposal.proposal_hash, challenge: 'challenge',
    client_request_id: 'confirm', expected_revision: proposal.base_revision,
    payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex'),
  }));
  const artifacts = ['command_inbox', 'command_records', 'settings_changes'];
  const before = artifacts.map((table) => f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  armed = true;
  await expect(engine.submitSettings(owner, { draft: requestDraft, validationId: proof.validation_id,
    requestId: 'apply', controlReceiptId: control.receipt_id })).rejects.toMatchObject(race === 'target-domain'
      ? { status: 403, message: 'FORBIDDEN' }
      : { status: 409, message: 'CONFLICT', params: { reason: 'recovery_write_blocked' } });
  for (const [index, table] of artifacts.entries()) expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual(before[index]);
  expect(f.db.prepare("SELECT 1 FROM command_inbox WHERE client_request_id='apply'").get()).toBeUndefined();
  if (kind === 'vault') expect(f.db.prepare("SELECT status,connection_epoch FROM vaults WHERE vault_id='vault'").get())
    .toEqual({ status: 'awaiting_confirmation', connection_epoch: 0 });
  else expect(f.db.prepare('SELECT config_revision,frequency FROM source_configs WHERE source_id=?').get(target))
    .toEqual({ config_revision: 1, frequency: 'poll' });
});
