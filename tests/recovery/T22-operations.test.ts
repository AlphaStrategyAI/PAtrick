import { generateKeyPairSync, sign, verify, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, realpathSync, renameSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { openDatabase, createRecoveryRuntimeGate, recoveryWriteAllowed } from '@patrick/storage';
import { verifyRecoverySet } from '../../packages/host/src/recovery/backup.js';
import { canonical } from '../../packages/host/src/recovery/files.js';
import { createRecoveryRestorer } from '../../packages/host/src/recovery/restore.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 't22-operations-'));
  const service = openDatabase(join(root, 'service.sqlite'));
  const hub = openDatabase(join(root, 'hub.sqlite'));
  cleanups.push(() => { service.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });
  for (const db of [service, hub]) db.prepare("INSERT INTO hub_snapshots VALUES ('hub',0,'{}',?)").run(new Date().toISOString());
  for (const path of ['operations', 'sets', 'isolated']) mkdirSync(join(root, path));
  const keys = generateKeyPairSync('ed25519');
  const authority = { keyId: 'test', async sign(bytes: Uint8Array) { return sign(null, bytes, keys.privateKey).toString('base64'); },
    async verify(bytes: Uint8Array, signature: string, keyId: string) { return keyId === 'test' && verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64')); } };
  let captures = 0;
  let interrupt = false;
  const scope = { setId: 'set', domains: [{ domain: 'personal', writerEpoch: 'epoch', withdrawal: { seq: 0, hash: createHash('sha256').update('').digest('hex') } }], resources: [], versionLocks: { app: '1' } };
  const backup = { root: join(root, 'sets'), databases: { service, hub }, authority, freeze: { async acquire() {
    captures++;
    if (interrupt) throw new Error('interrupted');
    return { cutId: 'cut', ingressFrozen: true, claimsFrozen: true, receiptsFrozen: true, effectsFrozen: true, executionTreesStopped: true,
      uncertainCallsJournaled: true, durableHandoff: true, async release() {} };
  } } };
  const target = { identity: { accountId: 'owner', scopeId: 'scope', domains: ['personal'], deviceId: 'device', configRevision: '1' },
    backup: { options: backup, scope }, drill: { recoveryRoot: backup.root, isolationRoot: join(root, 'isolated'), authority, versionLocks: scope.versionLocks } };
  const module = await import('../../packages/host/src/recovery/operations.js').catch(() => undefined);
  expect(module, 'durable actual-library recovery operations are available').toBeDefined();
  let failTerminal = false;
  const operationAuthority = { ...authority, async sign(bytes: Uint8Array) {
    if (failTerminal && JSON.parse(Buffer.from(bytes).toString()).kind === 'terminal') throw new Error('terminal interrupted');
    return authority.sign(bytes);
  } };
  const create = () => module!.createRecoveryOperations({ root: join(root, 'operations'), authority: operationAuthority, targets: { target } });
  return { root, service, target, create, captures: () => captures, interrupt: () => { interrupt = true; }, failTerminal: () => { failTerminal = true; } };
}
const request = { operationId: 'backup', targetId: 'target', mode: 'backup' as const };
test('actual backup and default drill survive lost responses and fresh instances without duplicate effects', async () => {
  const f = await fixture();
  expect(await f.create().read(request)).toEqual({ status: 'absent' });
  await Promise.all([f.create().reserve(request), f.create().reserve(request)]);
  const results = await Promise.all([f.create().run(request), f.create().run(request)]);
  expect(results.some((result) => result.status === 'completed')).toBe(true);
  const backup = await f.create().read(request);
  expect(backup.status).toBe('completed');
  expect(await f.create().run(request)).toEqual(backup);
  expect(f.captures()).toBe(1);
  expect(readdirSync(join(f.root, 'sets'))).toEqual(['set']);
  const drill = { operationId: 'drill', targetId: 'target', mode: 'drill' as const, manifestHash: backup.status === 'completed' ? backup.outcome.manifestHash : '' };
  await f.create().reserve(drill);
  const completed = await f.create().run(drill);
  expect(completed.status).toBe('completed');
  if (completed.status === 'completed') {
    expect(completed.outcome.manifestHash).toBe(drill.manifestHash);
    expect(completed.outcome.receipt).toMatchObject({ manifestHash: drill.manifestHash, mode: 'drill', external_writes: 0, data_domains: { personal: { status: 'blocked' } } });
    const terminal = JSON.parse(readFileSync(join(f.root, 'operations/drill.terminal.json'), 'utf8'));
    expect(terminal.payload.outcome).toEqual(completed.outcome);
  }
  expect(await f.create().run(drill)).toEqual(completed);
  expect(readdirSync(join(f.root, 'isolated'))).toHaveLength(1);
  createRecoveryRuntimeGate(f.service);
  expect(recoveryWriteAllowed(f.service, 'personal')).toBe(false);
});
test('signed source substitution at the actual drill handoff rejects before recovery effects and remains uncertain', async () => {
  const f = await fixture(); await f.create().reserve(request);
  const backup = await f.create().run(request);
  const manifestHash = backup.status === 'completed' ? backup.outcome.manifestHash : '';
  const source = join(f.root, 'sets/set/manifest.json');
  const original = readFileSync(source, 'utf8');
  const substitute = JSON.parse(original);
  substitute.manifest.cutId = 'substituted-cut';
  substitute.signature = await f.target.drill.authority.sign(Buffer.from(canonical(substitute.manifest)));
  const substitutedBytes = JSON.stringify(substitute);
  writeFileSync(source, substitutedBytes);
  const substitutedSet = await verifyRecoverySet(join(f.root, 'sets/set'), f.target.drill.authority, f.target.drill.versionLocks);
  expect(substitutedSet.manifestHash).not.toBe(manifestHash);
  expect(substitutedSet.manifest.setId).toBe('set');
  writeFileSync(source, original);
  const authority = f.target.drill.authority;
  let armed = false;
  const verifiedHashes: string[] = [];
  f.target.drill.authority = { ...authority, async verify(bytes: Uint8Array, signature: string, keyId: string) {
    const valid = await authority.verify(bytes, signature, keyId);
    if (armed) {
      verifiedHashes.push(createHash('sha256').update(bytes).digest('hex'));
      if (verifiedHashes.length === 2) writeFileSync(source, substitutedBytes);
    }
    return valid;
  } };
  let recoveryStarts = 0;
  Object.assign(f.target.drill, { now: () => { recoveryStarts++; return new Date(); } });
  const drill = { operationId: 'drill-substituted', targetId: 'target', mode: 'drill' as const, manifestHash };
  await f.create().reserve(drill);
  armed = true;
  const result = await f.create().run(drill).then((status) => ({ status, error: undefined }), (error: unknown) => ({ status: undefined, error }));
  armed = false;
  writeFileSync(source, original);
  expect(verifiedHashes).toEqual([manifestHash, manifestHash, substitutedSet.manifestHash]);
  expect(result.error).toMatchObject({ message: 'RECOVERY_MANIFEST_HASH_MISMATCH' });
  expect(result.status).toBeUndefined();
  expect(recoveryStarts).toBe(0);
  expect(readdirSync(join(f.root, 'isolated'))).toEqual([]);
  expect(existsSync(join(f.root, 'operations/drill-substituted.claim.json'))).toBe(true);
  expect(existsSync(join(f.root, 'operations/drill-substituted.terminal.json'))).toBe(false);
  expect(await f.create().read(drill)).toEqual({ status: 'running_or_uncertain' });
  expect(await f.create().run(drill)).toEqual({ status: 'running_or_uncertain' });
  expect(recoveryStarts).toBe(0);
  expect(readdirSync(join(f.root, 'isolated'))).toEqual([]);
  expect(f.captures()).toBe(1);
});
test('actual restorer rejects an expected hash mismatch before creating the isolation root', async () => {
  const f = await fixture(); await f.create().reserve(request); await f.create().run(request);
  const isolationRoot = join(f.root, 'uncreated-isolation');
  let recoveryStarts = 0;
  const restorer = createRecoveryRestorer({ ...f.target.drill, isolationRoot, now: () => { recoveryStarts++; return new Date(); } });
  await expect(restorer.restoreRecoverySet('set', 'drill', '0'.repeat(64))).rejects.toThrow('RECOVERY_MANIFEST_HASH_MISMATCH');
  expect(existsSync(isolationRoot)).toBe(false);
  expect(recoveryStarts).toBe(0);
});
test.each(['legacy', 'expected'] as const)('actual %s restorer call returns the consumed verified manifest identity', async (kind) => {
  const f = await fixture(); await f.create().reserve(request);
  const backup = await f.create().run(request);
  const manifestHash = backup.status === 'completed' ? backup.outcome.manifestHash : '';
  const restorer = createRecoveryRestorer(f.target.drill);
  const receipt = kind === 'legacy' ? await restorer.restoreRecoverySet('set') : await restorer.restoreRecoverySet('set', 'drill', manifestHash);
  expect(receipt).toMatchObject({ manifestHash, setId: 'set', mode: 'drill', external_writes: 0 });
});
test.each(['missing', 'receipt', 'outcome', 'set', 'mode'] as const)('drill terminal readback rejects signed %s consumed identity', async (kind) => {
  const f = await fixture(); await f.create().reserve(request);
  const backup = await f.create().run(request);
  const manifestHash = backup.status === 'completed' ? backup.outcome.manifestHash : '';
  const drill = { operationId: 'drill-invalid-identity', targetId: 'target', mode: 'drill' as const, manifestHash };
  await f.create().reserve(drill); await f.create().run(drill);
  const path = join(f.root, 'operations/drill-invalid-identity.terminal.json');
  const terminal = JSON.parse(readFileSync(path, 'utf8'));
  terminal.payload.outcome.receipt.manifestHash = manifestHash;
  if (kind === 'missing') delete terminal.payload.outcome.receipt.manifestHash;
  if (kind === 'receipt') terminal.payload.outcome.receipt.manifestHash = '0'.repeat(64);
  if (kind === 'outcome') terminal.payload.outcome.manifestHash = '0'.repeat(64);
  if (kind === 'set') terminal.payload.outcome.receipt.setId = 'other-set';
  if (kind === 'mode') terminal.payload.outcome.receipt.mode = 'activate';
  terminal.signature = await f.target.drill.authority.sign(Buffer.from(canonical(terminal.payload)));
  writeFileSync(path, JSON.stringify(terminal));
  await expect(f.create().read(drill)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
  await expect(f.create().run(drill)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
  expect(readdirSync(join(f.root, 'isolated'))).toHaveLength(1);
  expect(f.captures()).toBe(1);
});
test('interrupted invocation remains uncertain across restart and cannot capture twice', async () => {
  const f = await fixture(); f.interrupt();
  await f.create().reserve(request);
  await expect(f.create().run(request)).rejects.toThrow('interrupted');
  expect(await f.create().run(request)).toEqual({ status: 'running_or_uncertain' });
  expect(f.captures()).toBe(1);
});
test('conflicting identity and edited terminal control records are rejected', async () => {
  const f = await fixture(); await f.create().reserve(request); await f.create().run(request);
  f.target.identity.configRevision = '2';
  await expect(f.create().read(request)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
  f.target.identity.configRevision = '1';
  const terminal = join(f.root, 'operations', 'backup.terminal.json');
  const envelope = JSON.parse(readFileSync(terminal, 'utf8')); envelope.payload.outcome.manifestHash = '0'.repeat(64);
  writeFileSync(terminal, JSON.stringify(envelope));
  await expect(f.create().read(request)).rejects.toThrow('RECOVERY_OPERATION_RECORD_INVALID');
});

test.each(['accountId', 'scopeId', 'deviceId', 'configRevision'] as const)('reservation rejects changed trusted %s before capture', async (field) => {
  const f = await fixture(); await f.create().reserve(request); f.target.identity[field] = 'changed';
  await expect(f.create().run(request)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
  expect(f.captures()).toBe(0);
});
test('source manifest replacement prevents completed backup readback', async () => {
  const f = await fixture(); await f.create().reserve(request); await f.create().run(request);
  const manifest = join(f.root, 'sets/set/manifest.json');
  const value = JSON.parse(readFileSync(manifest, 'utf8')); value.manifest.cutId = 'forged'; writeFileSync(manifest, JSON.stringify(value));
  await expect(f.create().read(request)).rejects.toThrow('RECOVERY_SIGNATURE_INVALID');
  expect(f.captures()).toBe(1);
});
test('missing freeze authority and request-selected implementation fail before reservation', async () => {
  const f = await fixture();
  await expect(f.create().reserve({ ...request, targetId: 'unknown' })).rejects.toThrow('RECOVERY_OPERATION_UNAVAILABLE');
  await expect(f.create().reserve({ ...request, root: '/tmp/attacker' } as typeof request)).rejects.toThrow('RECOVERY_OPERATION_REQUEST_INVALID');
  f.target.backup.options.freeze = undefined as never;
  await expect(f.create().reserve(request)).rejects.toThrow('RECOVERY_OPERATION_UNAVAILABLE');
  expect(readdirSync(join(f.root, 'operations'))).toEqual([]);
});

test('real drill return interrupted before terminal remains uncertain with exactly one directory', async () => {
  const f = await fixture(); await f.create().reserve(request);
  const backup = await f.create().run(request);
  const drill = { operationId: 'drill', targetId: 'target', mode: 'drill' as const,
    manifestHash: backup.status === 'completed' ? backup.outcome.manifestHash : '' };
  await f.create().reserve(drill); f.failTerminal();
  await expect(f.create().run(drill)).rejects.toThrow('terminal interrupted');
  expect(await f.create().read(drill)).toEqual({ status: 'running_or_uncertain' });
  expect(await f.create().run(drill)).toEqual({ status: 'running_or_uncertain' });
  expect(readdirSync(join(f.root, 'isolated'))).toHaveLength(1);
  expect(f.captures()).toBe(1);
});
test.each(['set', 'root', 'physical-root', 'domain'] as const)('reservation refuses changed %s identity', async (kind) => {
  const f = await fixture(); await f.create().reserve(request);
  if (kind === 'set') f.target.backup.scope.setId = 'changed';
  if (kind === 'domain') f.target.identity.domains = ['other'];
  if (kind === 'root') { mkdirSync(join(f.root, 'other')); f.target.backup.options.root = join(f.root, 'other'); }
  if (kind === 'physical-root') { renameSync(join(f.root, 'sets'), join(f.root, 'old')); mkdirSync(join(f.root, 'sets')); }
  await expect(f.create().run(request)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
  expect(f.captures()).toBe(0);
});
test('symlink operation root and unsafe operation IDs are rejected without effects', async () => {
  const f = await fixture();
  await expect(f.create().reserve({ ...request, operationId: '../escape' })).rejects.toThrow('RECOVERY_PATH_INVALID');
  renameSync(join(f.root, 'operations'), join(f.root, 'old-operations'));
  symlinkSync(join(f.root, 'old-operations'), join(f.root, 'operations'));
  await expect(f.create().reserve(request)).rejects.toThrow('RECOVERY_SYMLINK_FORBIDDEN');
  expect(f.captures()).toBe(0);
});
test('copied signed reservation cannot be replayed under another command identity', async () => {
  const f = await fixture(); await f.create().reserve(request);
  writeFileSync(join(f.root, 'operations/other.reservation.json'), readFileSync(join(f.root, 'operations/backup.reservation.json')));
  await expect(f.create().run({ ...request, operationId: 'other' })).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
  expect(f.captures()).toBe(0);
});
test('ordinary SQL and a copied nonterminal checkpoint cannot publish operation completion', async () => {
  const f = await fixture(); await f.create().reserve(request);
  f.service.prepare("INSERT INTO recovery_receipts VALUES ('checkpoint','set','drill','{}',?)").run(new Date().toISOString());
  expect(await f.create().read(request)).toEqual({ status: 'reserved' });
  writeFileSync(join(f.root, 'operations/backup.terminal.json'), JSON.stringify({ receiptId: 'checkpoint', setId: 'set', mode: 'drill' }));
  await expect(f.create().read(request)).rejects.toThrow('RECOVERY_OPERATION_RECORD_INVALID');
  expect(f.captures()).toBe(0);
});
test('actual configured off-host protection is handed off once across terminal readback', async () => {
  const f = await fixture(); let protections = 0;
  Object.assign(f.target.backup.options, { offHost: { async protect(set: { manifestHash: string }) {
    protections++;
    return { encrypted: true, offHost: true, verified: true, domains: ['personal'], targetId: 'synthetic-offhost',
      snapshotId: 'snapshot', recoveryCredentialRef: 'synthetic-reference', verifiedAt: new Date().toISOString(), manifestHash: set.manifestHash };
  } } });
  await f.create().reserve(request); const completed = await f.create().run(request);
  expect(await f.create().run(request)).toEqual(completed);
  expect(f.captures()).toBe(1); expect(protections).toBe(1);
  const manifest = JSON.parse(readFileSync(join(f.root, 'sets/set/manifest.json'), 'utf8'));
  expect(manifest.manifest.protection.status).toBe('local_only');
});
