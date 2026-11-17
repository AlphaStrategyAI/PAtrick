import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createCredentialStore } from '@patrick/host';
import { createRecoveryRuntimeGate, openDatabase, recoveryWriteAllowed } from '@patrick/storage';
import { createGitHubClient } from '../../packages/integrations/publisher/github.js';
import { createApp, type CreateAppOptions } from '../../apps/service/src/app.js';
import { issueCallerSession, ORIGIN, RP_ID, type Principal } from '../../apps/service/src/auth.js';
import { createSettingsChanges } from '../../apps/service/src/settings/changes.js';
import { assertBusinessWrite, recoveryWriteCredential } from '../../apps/service/src/recovery-runtime.js';

const at = '2026-11-17T04:00:00.000Z';
const owner: Principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, authenticated_at: at,
  domains: ['personal'], operations: ['owner'] };
const draft = { operation: 'change_vault', domain: 'personal', target: 'vault', input: null };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t22-runtime-'));
  const databasePath = join(root, 'service.sqlite');
  const db = openDatabase(databasePath);
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run('owner', 1, 1, at);
  db.prepare("INSERT INTO caller_scopes VALUES ('owner','web','personal','owner',NULL)").run();
  return { root, databasePath, db, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('recovery-required settings refuses new authority before recording an intent', async () => {
  const fx = fixture();
  try {
    createRecoveryRuntimeGate(fx.db);
    const apply = vi.fn(async () => ({ revision: 1, effects: [] }));
    const engine = createSettingsChanges({ db: fx.db, now: () => new Date(at), handlers: { change_vault: {
      binding: () => ({ revision: 0, deviceId: 'host', identityId: 'owner', scopeHash: 'a'.repeat(64) }),
      validate: async () => ({ valid: true }), authorize() {}, apply, recheck: async () => ({ verified: true }),
    } } });
    const proof = await engine.validateSettings(owner, draft);
    await expect(engine.submitSettings(owner, { draft, validationId: proof.validation_id,
      controlReceiptId: 'control-a', requestId: 'change-a' })).rejects.toThrow('CONFLICT');
    expect(apply).not.toHaveBeenCalled();
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM settings_changes').get()).toEqual({ n: 0 });
  } finally { fx.close(); }
});

test('settings rechecks recovery admission immediately before its adapter writes', async () => {
  const fx = fixture();
  try {
    const engine = createSettingsChanges({ db: fx.db, now: () => new Date(at), handlers: { change_vault: {
      binding: () => ({ revision: 0, deviceId: 'host', identityId: 'owner', scopeHash: 'a'.repeat(64) }),
      validate: async () => ({ valid: true }), authorize() {},
      async apply(_principal, _draft, _proof, beforeWrite) {
        createRecoveryRuntimeGate(fx.db);
        beforeWrite();
        throw new Error('EXTERNAL_WRITE_REACHED');
      }, recheck: async () => ({ verified: true }),
    } } });
    const proof = await engine.validateSettings(owner, draft);
    const receipt = await engine.submitSettings(owner, { draft, validationId: proof.validation_id,
      controlReceiptId: 'control-b', requestId: 'change-b' });
    expect(receipt).toMatchObject({ phase: 'observed', verified: false, issues: ['confirmation_changed'],
      effects: [{ item: 'settings_target', outcome: 'blocked', revision: null }] });
  } finally { fx.close(); }
});

test('createApp attaches a trusted recovery controller before exposing its connection', async () => {
  const fx = fixture();
  try {
    const credentials = createCredentialStore(join(fx.root, 'credentials'), () => new Date(at));
    const authorization = issueCallerSession(fx.db, { accountId: 'owner', callerId: 'web', domain: 'personal',
      permissions: ['settings.read'] }, () => new Date(at), credentials).authorization;
    let attached = 0;
    const recoveryRuntime: NonNullable<CreateAppOptions['recoveryRuntime']> = {
      attach({ database, admission }) {
        attached++;
        expect(recoveryWriteAllowed(database, 'personal')).toBe(false);
        const identity = { domain: 'personal', writerEpoch: 'epoch-verified', activationId: 'activation-verified', witnessRevision: 'witness-verified' };
        database.prepare(`INSERT INTO recovery_domain_gates VALUES (?, ?, 'blocked', ?, ?, NULL, NULL, ?)`)
          .run(identity.domain, identity.writerEpoch, identity.activationId, identity.witnessRevision, at);
        admission.admit(identity);
        expect(recoveryWriteAllowed(database, 'personal')).toBe(false);
        database.prepare("UPDATE recovery_domain_gates SET status='open' WHERE data_domain='personal'").run();
        expect(recoveryWriteAllowed(database, 'personal')).toBe(true);
      },
    };
    const app = createApp({ databasePath: fx.databasePath, credentialDirectory: join(fx.root, 'credentials'),
      now: () => new Date(at), recoveryRuntime });
    const headers = { authorization, origin: ORIGIN, host: RP_ID };
    expect((await app.request('/api/v1/settings?domain=personal', { headers })).status).toBe(200);
    expect((await app.request('/api/v1/settings?domain=personal', { headers })).status).toBe(200);
    expect(attached).toBe(1);
  } finally { fx.close(); }
});

test('the raw GitHub client cannot mutate with read credentials alone', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ sha: 'a'.repeat(40) })));
  const client = createGitHubClient({ fetch, authorization: () => 'fixture-read-credential' });
  await expect(client.createTree({ owner: 'fixture', repo: 'repository', repoId: '1', baseRef: 'main' },
    { base_tree: 'b'.repeat(40), tree: [] })).rejects.toThrow('PUBLICATION_WRITES_DISABLED');
  expect(fetch).not.toHaveBeenCalled();
});

test('GitHub final write authorization rechecks admission after an awaited credential provider', async () => {
  const fx = fixture();
  try {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ sha: 'a'.repeat(40) })));
    const credential = vi.fn(async () => {
      await Promise.resolve();
      createRecoveryRuntimeGate(fx.db);
      return 'fixture-write-credential';
    });
    const client = createGitHubClient({ fetch, writeAuthorization: recoveryWriteCredential(fx.db, 'personal', credential),
      assertWriteAllowed: () => assertBusinessWrite(fx.db, 'personal') });
    await expect(client.createTree({ owner: 'fixture', repo: 'repository', repoId: '1', baseRef: 'main' },
      { base_tree: 'b'.repeat(40), tree: [] })).rejects.toThrow('CONFLICT');
    expect(credential).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.createTree({ owner: 'fixture', repo: 'repository', repoId: '1', baseRef: 'main' },
      { base_tree: 'b'.repeat(40), tree: [] })).rejects.toThrow('CONFLICT');
    expect(credential).toHaveBeenCalledOnce();
  } finally { fx.close(); }
});

test('GitHub checks admission in the handoff turn after credential promise completion', async () => {
  const fx = fixture();
  try {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ sha: 'a'.repeat(40) })));
    const credential = recoveryWriteCredential(fx.db, 'personal', async () => {
      queueMicrotask(() => queueMicrotask(() => { createRecoveryRuntimeGate(fx.db); }));
      return 'fixture-write-credential';
    });
    const client = createGitHubClient({ fetch, writeAuthorization: credential,
      assertWriteAllowed: () => assertBusinessWrite(fx.db, 'personal') });
    await expect(client.createTree({ owner: 'fixture', repo: 'repository', repoId: '1', baseRef: 'main' },
      { base_tree: 'b'.repeat(40), tree: [] })).rejects.toThrow('CONFLICT');
    expect(fetch).not.toHaveBeenCalled();
  } finally { fx.close(); }
});
