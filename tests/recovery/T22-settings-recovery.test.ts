import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { settingsDashboardSchema, settingsRecoveryOfferSchema } from '../../packages/contracts/src/resources.js';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { openDatabase, createRecoveryRuntimeGate, recoveryWriteAllowed } from '@patrick/storage';
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession, ORIGIN, RP_ID } from '../../apps/service/src/auth.js';
import { connectVault } from '../../packages/integrations/vault/connection.js';
import { createRecoveryOperations } from '../../packages/host/src/recovery/operations.js';
import type { RecoveryOperationTarget } from '../../packages/host/src/recovery/operations.js';

const at = '2026-11-17T04:00:00.000Z';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function fixture(requireComposition = true) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'T22-settings-recovery-impl-'));
  const databasePath = join(root, 'service.sqlite');
  const db = openDatabase(databasePath); const hub = openDatabase(join(root, 'hub.sqlite'));
  cleanups.push(() => { db.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(at);
  for (const database of [db, hub]) database.prepare("INSERT INTO hub_snapshots VALUES ('hub',0,'{}',?)").run(at);
  for (const directory of ['operations', 'sets', 'isolated', 'vault', 'blobs']) mkdirSync(join(root, directory));
  let onNow: (() => void) | undefined;
  await connectVault(db, { accountId: 'owner', deviceId: 'device', vaultId: 'vault', root: join(root, 'vault'), domain: 'personal', captureHost: hostname(), now: at });
  let clock = new Date(at); const now = () => { onNow?.(); return clock; };
  const credentialDirectory = join(root, 'credentials');
  const credentials = createCredentialStore(credentialDirectory, now);
  const session = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
  const keys = generateKeyPairSync('ed25519');
  let afterClaim: (() => void) | undefined; let afterTerminal: (() => void) | undefined;
  let interruptTerminal = false; let interruptFreeze = false; let captures = 0;
  const authority = { keyId: 'synthetic', async sign(bytes: Uint8Array) {
    const object = JSON.parse(Buffer.from(bytes).toString()) as { kind?: string };
    if (object.kind === 'terminal') { afterTerminal?.(); if (interruptTerminal) throw new Error('terminal interrupted'); }
    return sign(null, bytes, keys.privateKey).toString('base64');
  }, async verify(bytes: Uint8Array, signature: string, key: string) {
    const valid = key === 'synthetic' && verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64'));
    const object = JSON.parse(Buffer.from(bytes).toString()) as { kind?: string };
    if (object.kind === 'claim') afterClaim?.();
    return valid;
  } };
  const target: RecoveryOperationTarget = {
    identity: { accountId: 'owner', scopeId: 'complete-personal', domains: ['personal'], deviceId: 'device', configRevision: '1' },
    backup: { scope: { setId: 'fixed-set', domains: [{ domain: 'personal', writerEpoch: 'epoch', withdrawal: { seq: 0, hash: createHash('sha256').update('').digest('hex') } }],
      resources: [{ kind: 'vault', vaultId: 'vault', domain: 'personal', root: join(root, 'vault') }, { kind: 'blob', domain: 'personal', root: join(root, 'blobs') }], versionLocks: { app: '1' } },
      options: { root: join(root, 'sets'), databases: { service: db, hub }, authority, freeze: { async acquire() {
        captures++; if (interruptFreeze) throw new Error('freeze interrupted');
        return { cutId: 'cut', ingressFrozen: true, claimsFrozen: true, receiptsFrozen: true, effectsFrozen: true,
          executionTreesStopped: true, uncertainCallsJournaled: true, durableHandoff: true, async release() {} };
      } } } },
    drill: { recoveryRoot: join(root, 'sets'), isolationRoot: join(root, 'isolated'), authority, versionLocks: { app: '1' } },
  };
  const configuration = { root: join(root, 'operations'), authority, targets: { target }, restoreManifests: {} as Record<string, string> };
  const module = await import('../../apps/service/src/settings/recovery.js').catch(() => undefined);
  if (requireComposition) expect(module, 'real recovery settings composition is available').toBeDefined();
  const app = () => createApp({ databasePath, credentialDirectory, now, recoveryOperations: configuration,
    recoveryRuntime: { attach() {} } } as Parameters<typeof createApp>[0]);
  let current = app(); let sequence = 0;
  const headers = { authorization: session.authorization };
  async function post(path: string, payload: Json, expected = 1, requestId = 'request-' + ++sequence) {
    return current.request('/api/v1' + path, { method: 'POST', headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ client_request_id: requestId, expected_revision: expected, payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex'), payload }) });
  }
  async function approve(draft: { operation: string; target: string; domain: string; input: Json }) {
    const validation = await post('/settings/validations', draft);
    expect(validation.status).toBe(200);
    const { data: proof } = await validation.json() as { data: { validation_id: string; valid: boolean } };
    expect(proof.valid).toBe(true);
    const challenge = await current.request('/api/v1/auth/challenge', { method: 'POST', headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ rp_id: RP_ID }) });
    expect(challenge.status).toBe(200);
    const { challenge_id } = await challenge.json() as { challenge_id: string };
    const prepared = await post('/settings/control-proposals', { draft, validation_id: proof.validation_id, challenge_id });
    expect(prepared.status).toBe(200);
    const { data: proposal } = await prepared.json() as { data: { proposal_id: string; proposal_hash: string } };
    const confirmation = await post('/control-proposals/' + proposal.proposal_id + '/confirm', { proposal_hash: proposal.proposal_hash, challenge_id });
    expect(confirmation.status).toBe(202);
    const { receipt_url } = await confirmation.json() as { receipt_url: string };
    const { data } = await (await current.request(receipt_url, { headers })).json() as { data: { control_receipt_id: string } };
    return { draft, validation_id: proof.validation_id, control_receipt_id: data.control_receipt_id };
  }
  async function receipt(id: string) { return (await (await current.request('/api/v1/settings/changes/' + id, { headers })).json() as { data: { phase: string; verified: boolean; effects: unknown[]; issues: string[] } }).data; }
  async function apply(payload: Awaited<ReturnType<typeof approve>>, id = 'apply-' + ++sequence) {
    const response = await post('/settings/changes', payload, 1, id); expect(response.status).toBe(202);
    const { command_id } = await response.json() as { command_id: string };
    return { id: command_id, receipt: await receipt(command_id), requestId: id };
  }
  return { root, db, target, configuration, approve, post, apply, receipt, headers, app: () => current,
    onNow: (fn: () => void) => { onNow = fn; }, restart: () => { current = app(); }, captures: () => captures, claim: (fn: () => void) => { afterClaim = fn; },
    terminal: (fn: () => void) => { afterTerminal = fn; }, interrupt: () => { interruptTerminal = true; },
    freezeInterrupt: () => { interruptFreeze = true; }, expire: () => { clock = new Date(+clock + 121_000); } };
}
const backupDraft = { operation: 'start_backup', target: 'target', domain: 'personal', input: {} };

test('actual T03 backup and default isolated drill keep ordinary domain writes closed across replay', async () => {
  const f = await fixture();
  const payload = await f.approve(backupDraft); const backup = await f.apply(payload, 'backup');
  expect(backup.receipt).toMatchObject({ phase: 'observed', verified: true });
  f.restart(); expect((await f.apply(payload, 'backup')).id).toBe(backup.id); expect(f.captures()).toBe(1);
  const terminalName = readdirSync(join(f.root, 'operations')).find((name) => name.endsWith('.terminal.json'))!;
  const terminal = JSON.parse(readFileSync(join(f.root, 'operations', terminalName), 'utf8'));
  f.configuration.restoreManifests.target = terminal.payload.outcome.manifestHash;
  f.restart();
  const dashboard = await (await f.app().request('/api/v1/settings?domain=personal', { headers: f.headers })).json() as { data: { groups: Array<{ operations: Array<{ operation: string; targets: Array<{ input: Json }> }> }> } };
  settingsDashboardSchema.parse(dashboard.data);
  const restore = dashboard.data.groups.flatMap((g) => g.operations).find((o) => o.operation === 'start_restore')!;
  const drill = await f.apply(await f.approve({ operation: 'start_restore', target: 'target', domain: 'personal', input: restore.targets[0].input }));
  expect(drill.receipt).toMatchObject({ phase: 'observed', verified: true });
  expect(readdirSync(join(f.root, 'isolated'))).toHaveLength(1);
  const operation = JSON.parse(readFileSync(join(f.root, 'operations', readdirSync(join(f.root, 'operations')).filter((n) => n.endsWith('.terminal.json')).find((n) => n !== terminalName)!), 'utf8'));
  expect(operation.payload.outcome.receipt).toMatchObject({ mode: 'drill', external_writes: 0 });
  createRecoveryRuntimeGate(f.db); expect(recoveryWriteAllowed(f.db, 'personal')).toBe(false);
  const ordinary = await f.approve({ operation: 'connect_vault', target: 'vault', domain: 'personal', input: { device_id: 'device' } });
  expect((await f.post('/settings/changes', ordinary)).status).toBe(409);
  expect(f.db.prepare("SELECT status FROM vaults WHERE vault_id='vault'").get()).toEqual({ status: 'awaiting_confirmation' });
});

test.each(['session', 'control', 'expiry', 'owner'] as const)('revoked %s during durable claim denies the final actual library handoff', async (kind) => {
  const f = await fixture(); const approved = await f.approve(backupDraft);
  f.claim(() => {
    if (kind === 'session') f.db.prepare('DELETE FROM sessions').run();
    if (kind === 'control') f.db.prepare('DELETE FROM control_receipts').run();
    if (kind === 'owner') f.db.prepare("UPDATE caller_scopes SET revoked_at=?").run(at);
    if (kind === 'expiry') f.expire();
  });
  await f.post('/settings/changes', approved);
  expect(f.captures()).toBe(0); expect(readdirSync(join(f.root, 'sets'))).toEqual([]);
});

test.each(['lost-response', 'unknown'] as const)('authenticated restart readback handles %s without re-invoking the claim', async (kind) => {
  const f = await fixture(); const approved = await f.approve(backupDraft);
  if (kind === 'lost-response') f.terminal(f.expire);
  else f.freezeInterrupt();
  const original = await f.apply(approved); expect(original.receipt.verified).toBe(false);
  f.restart();
  const response = await f.app().request('/api/v1/settings/changes/' + original.id + '/recovery', { headers: f.headers });
  const { data: offer } = await response.json() as { data: { action: string; target: { input: Json } } };
  settingsRecoveryOfferSchema.parse(offer);
  expect(offer.action).toBe('readback_recovery_backup');
  const recovery = await f.approve({ operation: offer.action, target: 'target', domain: 'personal', input: offer.target.input });
  const reconciled = await f.post('/settings/changes/' + original.id + '/recovery', recovery);
  expect(reconciled.status).toBe(200);
  expect(await f.receipt(original.id)).toMatchObject({ verified: kind === 'lost-response', phase: kind === 'lost-response' ? 'observed' : 'uncertain' });
  expect(f.captures()).toBe(1);
});

test('untrusted selectors and missing native ports fail closed before any capture', async () => {
  const f = await fixture();
  const invalidDrafts: Json[] = [{ ...backupDraft, input: { root: '/attacker', set_id: 'other' } }, { ...backupDraft, target: 'other' }, { ...backupDraft, domain: 'other' },
    { operation: 'start_restore', target: 'target', domain: 'personal', input: { mode: 'activate' } }];
  for (const draft of invalidDrafts) {
    expect((await f.post('/settings/validations', draft)).status).toBeGreaterThanOrEqual(400);
  }
  f.target.backup!.options.freeze = undefined as never; f.restart();
  const dashboard = await (await f.app().request('/api/v1/settings?domain=personal', { headers: f.headers })).json();
  expect(JSON.stringify(dashboard)).not.toContain(f.root);
  expect((await f.post('/settings/validations', backupDraft)).status).toBeGreaterThanOrEqual(400);
  expect(f.captures()).toBe(0);
});

test('host deny-only guard follows durable claim and the final asynchronous binding', async () => {
  const f = await fixture(false);
  const operations = createRecoveryOperations(f.configuration);
  const request = { operationId: 'guard-test', targetId: 'target', mode: 'backup' as const };
  await operations.reserve(request);
  let revoked = false; f.claim(() => { revoked = true; });
  await expect(operations.run(request, () => { if (revoked) throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(f.captures()).toBe(0);
  expect(await operations.read(request)).toEqual({ status: 'running_or_uncertain' });
});

test('owner revocation between awaited terminal readback and final SQL projection cannot publish verified success', async () => {
  const f = await fixture(); const approved = await f.approve(backupDraft);
  let queued = false;
  f.onNow(() => {
    const row = f.db.prepare("SELECT phase FROM settings_changes LIMIT 1").get() as { phase: string } | undefined;
    if (row?.phase === 'applied' && !queued) {
      queued = true;
      queueMicrotask(() => { f.db.prepare('DELETE FROM control_receipts WHERE receipt_id=?').run(approved.control_receipt_id); });
    }
  });
  const result = await f.apply(approved);
  expect(queued).toBe(true); expect(result.receipt.verified).toBe(false); expect(f.captures()).toBe(1);
});

test.each(['draft', 'proposal', 'device'] as const)('tampered original %s provenance cannot read a host terminal into success', async (kind) => {
  const f = await fixture(); const original = await f.apply(await f.approve(backupDraft));
  if (kind === 'draft') f.db.prepare("UPDATE settings_validations SET draft_hash=? WHERE validation_id=(SELECT validation_id FROM settings_changes WHERE change_id=?)").run('0'.repeat(64), original.id);
  if (kind === 'proposal') f.db.prepare("UPDATE control_proposals SET action='start_restore'").run();
  if (kind === 'device') f.db.prepare("UPDATE settings_validations SET device_id='other'").run();
  const { data: offer } = await (await f.app().request('/api/v1/settings/changes/' + original.id + '/recovery', { headers: f.headers })).json() as { data: { status: string } };
  expect(offer.status).toBe('unavailable'); expect(f.captures()).toBe(1);
});

test('configured target revision drift during claim blocks actual capture and a copied SQL receipt never opens admission', async () => {
  const f = await fixture(); const approved = await f.approve(backupDraft);
  f.claim(() => { f.target.identity.configRevision = '2'; });
  const result = await f.apply(approved);
  expect(result.receipt.verified).toBe(false); expect(f.captures()).toBe(0);
  f.db.prepare("UPDATE settings_changes SET phase='observed',receipt=json_set(receipt,'$.verified',json('true'))").run();
  createRecoveryRuntimeGate(f.db); expect(recoveryWriteAllowed(f.db, 'personal')).toBe(false);
});

test.each(['control', 'owner', 'expiry'] as const)('fresh readback %s revocation during signed host verification refuses projection', async (kind) => {
  const f = await fixture(); f.freezeInterrupt();
  const original = await f.apply(await f.approve(backupDraft));
  const recoveryDraft = { operation: 'readback_recovery_backup', target: 'target', domain: 'personal', input: { change_id: original.id } };
  const approved = await f.approve(recoveryDraft);
  f.claim(() => {
    if (kind === 'control') f.db.prepare('DELETE FROM control_receipts WHERE receipt_id=?').run(approved.control_receipt_id);
    if (kind === 'owner') f.db.prepare('UPDATE caller_scopes SET revoked_at=?').run(at);
    if (kind === 'expiry') f.expire();
  });
  const response = await f.post('/settings/changes/' + original.id + '/recovery', approved);
  expect(response.status).toBeGreaterThanOrEqual(400); expect(f.captures()).toBe(1);
  expect(f.db.prepare("SELECT phase FROM settings_changes WHERE change_id=?").get(original.id)).toEqual({ phase: 'uncertain' });
});

test.each(['response-lost', 'terminal-interrupted'] as const)('actual isolated drill %s reads one durable identity across restart', async (kind) => {
  const f = await fixture();
  await f.apply(await f.approve(backupDraft));
  const backup = JSON.parse(readFileSync(join(f.root, 'operations', readdirSync(join(f.root, 'operations')).find((n) => n.endsWith('.terminal.json'))!), 'utf8'));
  const manifestHash = backup.payload.outcome.manifestHash as string;
  f.configuration.restoreManifests.target = manifestHash; f.restart();
  const draft = { operation: 'start_restore', target: 'target', domain: 'personal', input: { set_id: 'fixed-set', mode: 'drill', manifest_hash: manifestHash } };
  const approved = await f.approve(draft);
  if (kind === 'response-lost') f.terminal(f.expire); else f.interrupt();
  const original = await f.apply(approved); expect(original.receipt.verified).toBe(false);
  f.restart();
  const recovery = await f.approve({ operation: 'readback_recovery_drill', target: 'target', domain: 'personal', input: { change_id: original.id } });
  const result = await f.post('/settings/changes/' + original.id + '/recovery', recovery);
  expect(result.status).toBe(200);
  expect((await f.receipt(original.id)).verified).toBe(kind === 'response-lost');
  expect(readdirSync(join(f.root, 'isolated'))).toHaveLength(1); expect(f.captures()).toBe(1);
});
