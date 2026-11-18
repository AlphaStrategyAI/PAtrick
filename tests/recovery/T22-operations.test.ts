import { generateKeyPairSync, sign, verify, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, realpathSync, renameSync, symlinkSync, existsSync, truncateSync, statSync, chmodSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';
import { openDatabase, createRecoveryRuntimeGate, recoveryWriteAllowed } from '@patrick/storage';
import { verifyRecoverySet } from '../../packages/host/src/recovery/backup.js';
import { canonical } from '../../packages/host/src/recovery/files.js';
import { createRecoveryRestorer } from '../../packages/host/src/recovery/restore.js';
import type { RecoveryScope } from '../../packages/host/src/recovery/types.js';
import type { RecoveryBackupReadbackTarget, RecoveryJournalRoot } from '../../packages/host/src/recovery/operations.js';

const recordBoundary = vi.hoisted(() => ({ afterOpen: undefined as ((path: string) => void) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args);
    try { recordBoundary.afterOpen?.(String(args[0])); }
    catch (error) { await handle.close(); throw error; }
    return handle;
  } };
});

const cleanups: Array<() => void> = [];
afterEach(() => { recordBoundary.afterOpen = undefined; for (const close of cleanups.splice(0)) close(); });
async function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 't22-operations-'));
  const service = openDatabase(join(root, 'service.sqlite'));
  const hub = openDatabase(join(root, 'hub.sqlite'));
  const closeSources = () => { if (service.open) service.close(); if (hub.open) hub.close(); };
  cleanups.push(() => { closeSources(); rmSync(root, { recursive: true, force: true }); });
  for (const db of [service, hub]) db.prepare("INSERT INTO hub_snapshots VALUES ('hub',0,'{}',?)").run(new Date().toISOString());
  for (const path of ['operations', 'sets', 'isolated']) mkdirSync(join(root, path));
  const keys = generateKeyPairSync('ed25519');
  const authority = { keyId: 'test', async sign(bytes: Uint8Array) { return sign(null, bytes, keys.privateKey).toString('base64'); },
    async verify(bytes: Uint8Array, signature: string, keyId: string) { return keyId === 'test' && verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64')); } };
  let captures = 0;
  let interrupt = false;
  const scope: RecoveryScope = { setId: 'set', domains: [{ domain: 'personal', writerEpoch: 'epoch', withdrawal: { seq: 0, hash: createHash('sha256').update('').digest('hex') } }], resources: [], versionLocks: { app: '1' } };
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
  const verifier = { keyId: authority.keyId, verify: authority.verify };
  const operationRoot = join(root, 'operations');
  const journalStat = statSync(operationRoot);
  const journalRoot: RecoveryJournalRoot = { path: operationRoot, device: journalStat.dev, inode: journalStat.ino };
  const journal = { root: journalRoot, authority: verifier };
  const readback = (overrides: Partial<RecoveryBackupReadbackTarget> = {}) => {
    const readTarget: RecoveryBackupReadbackTarget = {
      identity: target.identity, scope, root: backup.root, authority: verifier, protection: { kind: 'local_only' }, ...overrides,
    };
    expect(module?.createRecoveryBackupReader, 'a restarted reader needs no signer, freeze or live databases').toBeTypeOf('function');
    return module!.createRecoveryBackupReader({ root: journalRoot, get authority() { return journal.authority; },
      targets: { target: readTarget } });
  };
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
  return { root, service, target, create, readback, closeSources, publicKey, journal, captures: () => captures, interrupt: () => { interrupt = true; }, failTerminal: () => { failTerminal = true; } };
}
const request = { operationId: 'backup', targetId: 'target', mode: 'backup' as const };

test('verification-only backup readback survives the loss of the live sources', async () => {
  const f = await fixture();
  expect(await f.readback().read(request)).toEqual({ status: 'absent' });
  await f.create().reserve(request);
  expect(await f.readback().read(request)).toEqual({ status: 'reserved' });
  const completed = await f.create().run(request);
  expect(completed.status).toBe('completed');
  f.closeSources();
  renameSync(join(f.root, 'service.sqlite'), join(f.root, 'service-retired.sqlite'));
  renameSync(join(f.root, 'hub.sqlite'), join(f.root, 'hub-retired.sqlite'));
  const reader = f.readback();
  expect(Object.keys(reader)).toEqual(['read']);
  expect(await reader.read(request)).toEqual(completed);
  expect(f.captures()).toBe(1);
});

test('verification-only readback keeps a published set uncertain without a signed terminal', async () => {
  const f = await fixture();
  await f.create().reserve(request);
  f.failTerminal();
  await expect(f.create().run(request)).rejects.toThrow('terminal interrupted');
  expect(readdirSync(join(f.root, 'sets'))).toEqual(['set']);
  f.closeSources();
  expect(await f.readback().read(request)).toEqual({ status: 'running_or_uncertain' });
  expect(f.captures()).toBe(1);
});

test('verification-only readback binds signed records to the current registered directory identity', async () => {
  const f = await fixture();
  await f.create().reserve(request);
  await f.create().run(request);
  f.closeSources();
  const old = join(f.root, 'old-operations');
  const operations = join(f.root, 'operations');
  renameSync(operations, old);
  mkdirSync(operations);
  await expect(f.readback().read(request)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
  for (const name of readdirSync(old)) writeFileSync(join(operations, name), readFileSync(join(old, name)));
  await expect(f.readback().read(request)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
});

test('verification-only readback still requires the captured resource directory identity', async () => {
  const f = await fixture();
  const handoff = join(f.root, 'handoff');
  mkdirSync(handoff);
  writeFileSync(join(handoff, 'snapshot'), 'handoff');
  f.target.backup.scope.resources.push({ kind: 'handoff', root: handoff });
  await f.create().reserve(request);
  const completed = await f.create().run(request);
  f.closeSources();
  expect(await f.readback().read(request)).toEqual(completed);

  renameSync(handoff, join(f.root, 'old-handoff'));
  mkdirSync(handoff);
  writeFileSync(join(handoff, 'snapshot'), 'handoff');
  await expect(f.readback().read(request)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
});

test('verification-only reader returns the authenticated terminal in a fresh process without filesystem writes', async () => {
  const f = await fixture();
  await f.create().reserve(request);
  const completed = await f.create().run(request);
  expect(completed.status).toBe('completed');
  f.closeSources();
  const retired = mkdtempSync(join(realpathSync(tmpdir()), 't22-retired-sources-'));
  cleanups.push(() => rmSync(retired, { recursive: true, force: true }));
  for (const name of ['service.sqlite', 'hub.sqlite']) renameSync(join(f.root, name), join(retired, name));

  const copied = join(f.root, 'sets', 'set', 'databases');
  for (const name of readdirSync(copied).filter((name) => name.endsWith('-wal') || name.endsWith('-shm'))) {
    unlinkSync(join(copied, name));
  }
  const inventory = ['hub.sqlite', 'service.sqlite'];
  expect(readdirSync(copied).sort()).toEqual(inventory);
  const digests = () => inventory.map((name) => createHash('sha256').update(readFileSync(join(copied, name))).digest('hex'));
  const priorDigests = digests();
  for (const name of inventory) chmodSync(join(copied, name), 0o400);
  chmodSync(copied, 0o500);
  cleanups.unshift(() => chmodSync(copied, 0o700));

  const source = fileURLToPath(new URL('../../packages/host/src/recovery/operations.ts', import.meta.url));
  const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
  const moduleRoot = fileURLToPath(new URL('../../node_modules', import.meta.url));
  const runner = join(f.root, 'verification.mjs');
  buildSync({
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    alias: { 'better-sqlite3': sqlite }, external: [sqlite], outfile: runner,
    stdin: { resolveDir: dirname(source), contents: `
      import { createPublicKey, verify } from 'node:crypto';
      import { createRecoveryBackupReader } from './operations.ts';
      const { publicKey, operationRoot, retired, target, request } = JSON.parse(process.argv[2]);
      if (process.permission.has('fs.write', operationRoot.path)
        || process.permission.has('fs.read', retired + '/service.sqlite')
        || process.permission.has('fs.read', retired + '/hub.sqlite')) {
        throw new Error('Unexpected readback process permissions');
      }
      const key = createPublicKey(publicKey);
      const authority = { keyId: 'test', async verify(bytes, signature, keyId) {
        return keyId === 'test' && verify(null, bytes, key, Buffer.from(signature, 'base64'));
      } };
      const reader = createRecoveryBackupReader({
        root: operationRoot, authority, targets: { target: { ...target, authority } },
      });
      const read = await reader.read(request);
      process.stdout.write(JSON.stringify(read));
    ` },
  });
  const result = spawnSync(process.execPath, [
    '--permission', '--allow-fs-read=' + f.root, '--allow-fs-read=' + moduleRoot,
    runner, JSON.stringify({ publicKey: f.publicKey, operationRoot: f.journal.root, retired, request,
      target: { identity: f.target.identity, root: f.target.backup.options.root, scope: f.target.backup.scope, protection: { kind: 'local_only' } } }),
  ], { encoding: 'utf8', timeout: 20_000 });
  expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(completed);
  expect(readdirSync(copied).sort()).toEqual(inventory);
  expect(digests()).toEqual(priorDigests);
  expect(f.captures()).toBe(1);
});

test('verification-only readback refuses changed bindings and signed-set bytes', async () => {
  const f = await fixture();
  await f.create().reserve(request);
  await f.create().run(request);
  f.closeSources();
  await expect(f.readback({ identity: { ...f.target.identity, configRevision: '2' } }).read(request)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
  await expect(f.readback().read({ ...request, mode: 'drill' })).rejects.toThrow('RECOVERY_OPERATION_UNAVAILABLE');
  const journal = join(f.root, 'operations', 'backup.terminal.json');
  const record = readFileSync(journal);
  const terminal = JSON.parse(record.toString('utf8'));
  terminal.payload.outcome.manifestHash = '0'.repeat(64);
  writeFileSync(journal, JSON.stringify(terminal));
  await expect(f.readback().read(request)).rejects.toThrow('RECOVERY_OPERATION_RECORD_INVALID');
  writeFileSync(journal, record);
  truncateSync(journal, 4 * 1024 * 1024 + 1);
  await expect(f.readback().read(request)).rejects.toThrow('RECOVERY_OPERATION_RECORD_INVALID');
  writeFileSync(journal, record);
  const manifest = join(f.root, 'sets', 'set', 'manifest.json');
  const envelope = JSON.parse(readFileSync(manifest, 'utf8'));
  envelope.manifest.cutId = 'wrong-cut';
  writeFileSync(manifest, JSON.stringify(envelope));
  await expect(f.readback().read(request)).rejects.toThrow('RECOVERY_SIGNATURE_INVALID');
  expect(f.captures()).toBe(1);
});
test('verification-only readback accepts large authentic v1 bindings while bounding extra record data', async () => {
  const f = await fixture();
  f.target.backup.scope.versionLocks.app = 'x'.repeat(4 * 1024 * 1024 + 1);
  await f.create().reserve(request);
  expect(await f.readback().read(request)).toEqual({ status: 'reserved' });
  expect(f.captures()).toBe(0);
});

test('verification-only readback refuses a claim that disappears after its initial open', async () => {
  const f = await fixture();
  await f.create().reserve(request);
  f.interrupt();
  await expect(f.create().run(request)).rejects.toThrow('interrupted');
  const claim = join(f.root, 'operations', 'backup.claim.json');
  recordBoundary.afterOpen = (path) => {
    if (path === claim) unlinkSync(path);
  };
  await expect(f.readback().read(request)).rejects.toThrow('RECOVERY_OPERATION_RECORD_INVALID');
  expect(existsSync(claim)).toBe(false);
});

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

test('verification-only readback requires independent proof for an off-host binding', async () => {
  const f = await fixture();
  let copiedHash: string | undefined;
  Object.assign(f.target.backup.options, { offHost: { async protect(set: { manifestHash: string }) {
    copiedHash = set.manifestHash;
    return { encrypted: true, offHost: true, verified: true, domains: ['personal'], targetId: 'synthetic-offhost',
      snapshotId: 'snapshot', recoveryCredentialRef: 'synthetic-reference', verifiedAt: new Date().toISOString(), manifestHash: copiedHash };
  } } });
  await f.create().reserve(request);
  const reader = f.readback({ protection: { kind: 'off_host', async verify(set) {
    return copiedHash === set.manifestHash;
  } } });
  expect(await reader.read(request)).toEqual({ status: 'reserved' });
  const completed = await f.create().run(request);
  expect(completed.status).toBe('completed');
  f.closeSources();
  await expect(f.readback().read(request)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
  const refusing = f.readback({ protection: { kind: 'off_host', async verify() { return false; } } });
  await expect(refusing.read(request)).rejects.toThrow('RECOVERY_OFF_HOST_UNCONFIRMED');
  expect(await reader.read(request)).toEqual(completed);
  expect(f.captures()).toBe(1);
});

test.each(['journal', 'off-host'])('verification-only readback refuses %s verifier rotation before return', async (which) => {
  const f = await fixture();
  Object.assign(f.target.backup.options, { offHost: { async protect(set: { manifestHash: string }) {
    return { encrypted: true, offHost: true, verified: true, domains: ['personal'], targetId: 'synthetic-offhost',
      snapshotId: 'snapshot', recoveryCredentialRef: 'synthetic-reference', verifiedAt: new Date().toISOString(), manifestHash: set.manifestHash };
  } } });
  await f.create().reserve(request);
  expect((await f.create().run(request)).status).toBe('completed');
  f.closeSources();
  const protection = { kind: 'off_host' as const, async verify() {
    await Promise.resolve();
    if (which === 'journal') f.journal.authority = { ...f.journal.authority, async verify() { return false; } };
    else protection.verify = async () => false;
    return true;
  } };
  await expect(f.readback({ protection }).read(request)).rejects.toThrow('RECOVERY_OPERATION_BINDING_MISMATCH');
  expect(f.captures()).toBe(1);
});
