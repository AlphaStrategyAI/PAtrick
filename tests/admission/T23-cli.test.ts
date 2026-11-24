import { execFileSync, spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';

const entry = new URL('../../deploy/cli/patrick.mjs', import.meta.url);
test('standalone parser refuses unknown commands with bounded redacted JSON', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(entry), 'arbitrary-secret-/Users/private'], { encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'invalid', code: 'CLI_ARGUMENT_INVALID' });
  expect(result.stdout).not.toContain('private');
  expect(result.stderr).toBe('');
});
test('all fixed standalone commands distinguish missing host registration', () => {
  for (const command of ['init', 'doctor', 'install', 'start', 'stop', 'backup', 'restore', 'upgrade', 'uninstall']) {
    const result = spawnSync(process.execPath, [fileURLToPath(entry), command], { encoding: 'utf8' });
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ command, status: 'unavailable', code: 'HOST_REGISTRATION_REQUIRED' });
  }
});
test('importing executable is side effect free', () => {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(entry.href)})`], { encoding: 'utf8' });
  expect(stdout).toBe('');
});

import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { openDatabase } from '@patrick/storage';
import { createRecoveryBackupReader, createRecoveryOperations } from '../../packages/host/src/recovery/operations.js';
import { readRecoveryDatabase } from '../../packages/host/src/recovery/backup.js';
import { canonical, digest } from '../../packages/host/src/recovery/files.js';
import { createLifecycleJournal, type LifecycleRegistration, type LifecycleRequest } from '../../deploy/runtime/lifecycle-journal.js';
import { createRuntimeCli, createRuntimeProvisioning } from '../../deploy/runtime/composition.js';
import type { RegisteredHost } from '../../deploy/lib/doctor.mjs';
import { createNetworkInspector } from '../../packages/host/src/network/probes.js';
import { createObsidianDoctor, createObsidianInspector } from '../../deploy/obsidian/doctor.mjs';
import { createVaultKitInstaller } from '../../deploy/obsidian/install.mjs';
import { createPatrickCli, parseArguments } from '../../deploy/cli/patrick.mjs';
import { deriveRuntimeStaging, leased } from '../../deploy/lib/emitted-release.mjs';
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((close) => close()); });
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 't23-cli-'));
  const service = openDatabase(join(root, 'service.sqlite'));
  const hub = openDatabase(join(root, 'hub.sqlite'));
  const closeSources = () => { if (service.open) service.close(); if (hub.open) hub.close(); };
  cleanup.push(() => { closeSources(); rmSync(root, { recursive: true, force: true }); });
  for (const db of [service, hub]) db.prepare("INSERT INTO hub_snapshots VALUES ('hub',0,'{}',?)").run(new Date().toISOString());
  for (const directory of ['operations', 'sets', 'isolated']) mkdirSync(join(root, directory));
  const keys = generateKeyPairSync('ed25519');
  const authority = { keyId: 'test', async sign(bytes: Uint8Array) { return sign(null, bytes, keys.privateKey).toString('base64'); },
    async verify(bytes: Uint8Array, signature: string, keyId: string) { return keyId === 'test' && verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64')); } };
  const identity = { accountId: 'owner', scopeId: 'scope', domains: ['personal'], deviceId: 'device', configRevision: '1' };
  let captures = 0;
  let interrupt = false;
  const scope = { setId: 'set', domains: [{ domain: 'personal', writerEpoch: 'epoch', withdrawal: { seq: 0, hash: createHash('sha256').update('').digest('hex') } }], resources: [], versionLocks: { app: '1' } };
  const backup = { root: join(root, 'sets'), databases: { service, hub }, authority, freeze: { async acquire() {
    captures++;
    if (interrupt) throw new Error('SECRET /Users/private credential=secret');
    return { cutId: 'cut', ingressFrozen: true, claimsFrozen: true, receiptsFrozen: true, effectsFrozen: true, executionTreesStopped: true,
      uncertainCallsJournaled: true, durableHandoff: true, async release() {} };
  } } };
  const target = { identity: { ...identity }, backup: { options: backup, scope },
    drill: { recoveryRoot: backup.root, isolationRoot: join(root, 'isolated'), authority, versionLocks: scope.versionLocks } };
  const host = { identity, captureHost: hostname(), serviceUid: process.geteuid!(), profile: root,
    dataRoot: root, minimumFreeBytes: 1, runtime: { createRecoveryOperations, createNetworkInspector, createObsidianDoctor, createVaultKitInstaller },
    recovery: { root: join(root, 'operations'), authority, targets: { target } } };
  return { root, target, host, closeSources, captures: () => captures, interrupt: () => { interrupt = true; }, cli: () => createPatrickCli(host) };
}
test.each([
  ['backup', '--execute', '--operation', 'backup', '--target', 'target', '--root', 'secret'],
  ['restore', '--mode', 'activate'], ['start', '--execute', '--readback', '--operation', 'start'],
  ['doctor', '--execute'], ['backup', '--target', 'target', '--target', 'other'],
  ['install', '--release', '../path'], ['init', '--module', 'evil'], ['start', '--execute'],
  ['backup', '--manifest', '0'.repeat(64)], ['doctor', '--operation', 'op'],
])('strict parser refuses %j', (...args) => { expect(() => parseArguments(args)).toThrow('CLI_ARGUMENT_INVALID'); });
test('actual recovery backup previews without reservation then survives fresh CLI same-ID replay', async () => {
  const f = fixture();
  expect(await f.cli().run(['backup', '--target', 'target'])).toMatchObject({ status: 'preview', identity: f.host.identity });
  expect(readdirSync(join(f.root, 'operations'))).toEqual([]);
  const args = ['backup', '--target', 'target', '--execute', '--operation', 'backup'];
  const completed = await f.cli().run(args);
  expect(completed).toMatchObject({ status: 'completed', exitCode: 0, manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await f.cli().run(args)).toEqual(completed);
  expect(f.captures()).toBe(1);
  expect(JSON.stringify(completed)).not.toContain(f.root);
  const drill = await f.cli().run(['restore', '--target', 'target', '--manifest', completed.manifestHash!, '--execute', '--operation', 'drill']);
  expect(drill).toMatchObject({ status: 'completed', mode: 'drill', externalWrites: 0 });
  expect(readdirSync(join(f.root, 'isolated'))).toHaveLength(1);
});
test('unknown effect stays uncertain on same-command replay and readback without reinvocation', async () => {
  const f = fixture(); f.interrupt();
  const args = ['backup', '--target', 'target', '--execute', '--operation', 'backup'];
  expect(await f.cli().run(args)).toMatchObject({ status: 'uncertain', exitCode: 4 });
  expect(await f.cli().run(args)).toMatchObject({ status: 'uncertain' });
  const before = readdirSync(join(f.root, 'operations'));
  expect(await f.cli().run(['backup', '--target', 'target', '--readback', '--operation', 'backup'])).toMatchObject({ status: 'uncertain' });
  expect(readdirSync(join(f.root, 'operations'))).toEqual(before);
  expect(f.captures()).toBe(1);
});
function verificationOnlyHost(f: ReturnType<typeof fixture>) {
  const operationRoot = f.host.recovery.root;
  const info = statSync(operationRoot);
  const { keyId, verify } = f.host.recovery.authority;
  const authority = { keyId, verify };
  return {
    ...f.host,
    recovery: undefined,
    runtime: { createRecoveryBackupReader },
    backupReadback: {
      root: { path: operationRoot, device: info.dev, inode: info.ino },
      authority,
      targets: { target: { identity: { ...f.target.identity }, scope: f.target.backup.scope,
        root: f.target.backup.options.root, authority, protection: { kind: 'local_only' as const } } },
    },
  };
}

const backupReadCommand = ['backup', '--target', 'target', '--readback', '--operation', 'backup'];

test('verification-only CLI reads an authenticated completed backup after both source connections close', async () => {
  const f = fixture();
  const completed = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  expect(completed.status).toBe('completed');
  const host = verificationOnlyHost(f);
  f.closeSources();
  const result = await createPatrickCli(host).run(backupReadCommand);
  expect(result).toMatchObject({ status: 'completed', mode: 'backup', manifestHash: completed.manifestHash });
  expect(JSON.stringify(result)).not.toContain(f.root);
  expect(f.captures()).toBe(1);
});

test('verification-only CLI projects only backup fields from an authenticated extended terminal', async () => {
  const f = fixture();
  const completed = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  expect(completed.status).toBe('completed');
  const host = verificationOnlyHost(f);
  const path = join(host.backupReadback.root.path, 'backup.terminal.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.payload.outcome.receipt = { external_writes: { privatePath: f.root } };
  record.signature = await f.host.recovery.authority.sign(Buffer.from(canonical(record.payload)));
  writeFileSync(path, canonical(record));
  f.closeSources();
  const result = await createPatrickCli(host).run(backupReadCommand);
  expect(result).toEqual({
    command: 'backup', action: 'readback', status: 'completed', code: 'RECOVERY_COMPLETED',
    nextStep: 'Retain the signed operation and RecoverySet records.', identity: f.host.identity,
    manifestHash: completed.manifestHash, mode: 'backup', exitCode: 0,
  });
});

test('off-host evidence refusal is public only for verification-only readback', async () => {
  const f = fixture();
  const refuse = async () => { throw new Error('RECOVERY_OFF_HOST_UNCONFIRMED'); };
  const liveCli = createPatrickCli({
    ...f.host, runtime: { ...f.host.runtime, createRecoveryOperations: () => ({ read: refuse, reserve: refuse, run: refuse }) },
  });
  const cold = verificationOnlyHost(f);
  const coldCli = createPatrickCli({
    ...cold, runtime: { createRecoveryBackupReader: () => ({ read: refuse }) },
  });
  expect(await coldCli.run(backupReadCommand)).toMatchObject({ status: 'blocked', code: 'RECOVERY_OFF_HOST_UNCONFIRMED' });
  expect(await liveCli.run(backupReadCommand)).toMatchObject({ status: 'blocked', code: 'RECOVERY_OPERATION_FAILED' });
});

test('verification-only CLI preserves a signed claim without a terminal and cannot run effects', async () => {
  const f = fixture();
  f.interrupt();
  expect(await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup'])).toMatchObject({ status: 'uncertain' });
  const host = verificationOnlyHost(f);
  f.closeSources();
  const cli = createPatrickCli(host);
  const before = readdirSync(host.backupReadback.root.path).sort();
  expect(await cli.run(backupReadCommand)).toMatchObject({ status: 'uncertain', exitCode: 4 });
  expect(await cli.run(['backup', '--target', 'target', '--execute', '--operation', 'backup'])).toMatchObject({ status: 'unavailable' });
  expect(readdirSync(host.backupReadback.root.path).sort()).toEqual(before);
  expect(f.captures()).toBe(1);
});

function installedRecoveryProvisioning(f: ReturnType<typeof fixture>, backupReadback?: RegisteredHost['backupReadback'],
  lifecycleReadbacks?: RegisteredHost['lifecycleReadbacks']) {
  Object.assign(f.target.backup.options, { readDatabase: readRecoveryDatabase });
  return createRuntimeProvisioning({
    registration: {
      identity: f.host.identity, captureHost: f.host.captureHost, serviceUid: f.host.serviceUid,
      dataRoot: f.root, minimumFreeBytes: 1, profile: 'test', origin: 'http://localhost', rpId: 'localhost',
      listener: { host: '127.0.0.1', port: 0, origin: 'http://localhost' },
    },
    hostCapabilities: { recovery: f.host.recovery, backupReadback, lifecycleReadbacks },
    operationalRecoveryHub: {
      identity: f.host.identity, database: f.target.backup.options.databases.hub,
      physicalPath: join(f.root, 'hub.sqlite'), readDatabase: readRecoveryDatabase,
    },
    service: {
      databasePath: join(f.root, 'service.sqlite'), credentialDirectory: f.root,
      recoveryRuntime: { attach() { throw new Error('Unexpected live startup'); } },
      bindRecoveryOperations() { return f.host.recovery; },
    },
  });
}

test('installed CLI keeps cold readback usable when its original live recovery binding has closed', async () => {
  const f = fixture();
  const provisioning = installedRecoveryProvisioning(f, verificationOnlyHost(f).backupReadback);
  const execute = ['backup', '--target', 'target', '--execute', '--operation', 'backup'];
  const invalid = ['backup', '--readback', '--target', 'target'];
  const installed = createRuntimeCli(provisioning);
  expect(await installed.run(invalid)).toMatchObject({ status: 'invalid', code: 'CLI_ARGUMENT_INVALID' });
  const prior = await installed.run(execute);
  expect(prior.status).toBe('completed');
  f.closeSources();
  const restarted = createRuntimeCli(provisioning);
  expect(await restarted.run(backupReadCommand)).toMatchObject({ status: 'completed', manifestHash: prior.manifestHash });
  expect(await restarted.run(execute)).toMatchObject({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
  expect.soft(await restarted.run(invalid)).toMatchObject({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
  let iterations = 0;
  const changingArgv = new Proxy(backupReadCommand, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        const argv = ++iterations === 1 ? target : execute;
        return argv[Symbol.iterator].bind(argv);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  expect.soft(await restarted.run(changingArgv)).toMatchObject({ action: 'readback', status: 'completed', manifestHash: prior.manifestHash });
  expect.soft(iterations).toBe(1);
  expect(f.captures()).toBe(1);
});

test('a live-only backup target ignores unrelated cold configuration before checking live storage', async () => {
  const f = fixture();
  const { backupReadback: cold } = verificationOnlyHost(f);
  const provisioning = installedRecoveryProvisioning(f, {
    ...cold,
    authority: { get keyId() { return cold.authority.keyId; }, verify: cold.authority.verify },
    targets: { unrelated: cold.targets.target },
  });
  const cli = createRuntimeCli(provisioning);
  const completed = await cli.run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  expect(completed.status).toBe('completed');
  expect.soft(await cli.run(backupReadCommand)).toMatchObject({ status: 'completed', manifestHash: completed.manifestHash });
  f.closeSources();
  expect.soft(await cli.run(backupReadCommand)).toMatchObject({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
  expect(await cli.run(['backup', '--target', 'unrelated', '--readback', '--operation', 'backup']))
    .toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(f.captures()).toBe(1);
});

function installedLifecycleFixture(command: LifecycleRequest['command'], requireOriginalReceiver = false) {
  const f = fixture();
  const path = join(f.root, 'lifecycle');
  mkdirSync(path, { mode: 0o700 });
  const { dev, ino } = statSync(path);
  const { keyId, verify } = f.host.recovery.authority;
  const evidencePath = join(f.root, 'fixture-native-readback');
  const target = 'registered-target';
  const targetFlag = command === 'init' ? '--vault' : command === 'install' || command === 'upgrade' ? '--release' : undefined;
  const planSha256 = digest('normalized fixture ' + command + ' plan');
  let beforeVerification: (() => Promise<void>) | undefined;
  let evidenceReads = 0;
  const authority: LifecycleRegistration['authority'] = { keyId, async verify(bytes, signature, expected) {
    if (requireOriginalReceiver && this !== authority) return false;
    const pause = beforeVerification;
    beforeVerification = undefined;
    await pause?.();
    return verify(bytes, signature, expected);
  } };
  const evidence: LifecycleRegistration['evidence'] = { version: 'fixture-evidence-v1', async observe(subject, evidenceId) {
    evidenceReads++;
    if (requireOriginalReceiver && this !== evidence) throw new Error('Fixture observer receiver changed');
    const bytes = readFileSync(evidencePath);
    if (bytes.toString() !== canonical({ subject, evidenceId })) throw new Error('Fixture evidence changed');
    return { evidenceId, claimSha256: subject.claimSha256, evidenceSha256: digest(bytes) };
  } };
  const registered: LifecycleRegistration = {
    root: { path, device: dev, inode: ino },
    identity: { ...f.host.identity, installationId: 'fixture-installation' },
    plan: { command, targetId: target, expectedGeneration: null,
      nextGeneration: 'generation-one', releaseSha256: targetFlag === '--release' ? digest('registered fixture archive') : null, planSha256 },
    authority, evidence,
  };
  const operation: LifecycleRequest = { operationId: 'lifecycle-one', command, targetId: target,
    planSha256, expectedGeneration: null };
  const selected = targetFlag ? [targetFlag, target] : [];
  const args = [command, ...selected, '--readback', '--operation', operation.operationId];
  const registrations = { [operation.operationId]: registered } as Record<string, LifecycleRegistration>;
  const provisioning = installedRecoveryProvisioning(f, undefined, registrations);
  const writer = createLifecycleJournal(() => registered, f.host.recovery.authority);
  return { f, path, evidencePath, writer, operation, targetFlag, selected, args, provisioning, registrations,
    evidenceReads: () => evidenceReads,
    pauseVerification(pause: () => Promise<void>) { beforeVerification = pause; },
  };
}

test.each(['init', 'install', 'start', 'stop', 'upgrade', 'uninstall'] as const)(
  'installed lifecycle readback observes exact signed %s receipts after closing live storage', async (command) => {
    const { f, path, evidencePath, writer, operation, targetFlag, selected, args, provisioning } = installedLifecycleFixture(command, true);
    const cli = createRuntimeCli(provisioning);
    expect(await cli.run(args)).toMatchObject({ status: 'absent', code: 'LIFECYCLE_ABSENT' });
    await writer.reserve(operation);
    expect(await cli.run(args)).toMatchObject({ status: 'reserved', code: 'LIFECYCLE_RESERVED' });
    const claim = await writer.claim(operation);
    if (claim.status !== 'claimed') throw new Error('Fixture claim missing');
    f.closeSources();
    const restarted = createRuntimeCli(provisioning);
    expect(await restarted.run(args)).toMatchObject({ status: 'uncertain', code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
    const wrongSelection = targetFlag ? [targetFlag, 'other', '--operation', operation.operationId] : ['--operation', 'other'];
    expect(await restarted.run([command, '--readback', ...wrongSelection]))
      .toMatchObject({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
    expect(await restarted.run([command, ...selected, '--execute', '--operation', operation.operationId]))
      .toMatchObject({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
    const evidenceId = 'observed';
    writeFileSync(evidencePath, canonical({ subject: claim.subject, evidenceId }));
    const completion = await writer.markCompleted(claim.token, evidenceId);
    if (completion.status !== 'completed') throw new Error('Fixture terminal missing');
    const files = readdirSync(path).sort().map((file) => [file, digest(readFileSync(join(path, file)))]);
    const result = await createRuntimeCli(provisioning).run(args);
    expect(result).toEqual({
      command, action: 'readback', status: 'completed', code: 'LIFECYCLE_COMPLETED',
      nextStep: 'Retain the signed lifecycle records and verified evidence.',
      identity: f.host.identity, lifecycleReceipt: completion.receipt, exitCode: 0,
    });
    expect(JSON.stringify(result)).not.toContain(f.root);
    expect(readdirSync(path).sort().map((file) => [file, digest(readFileSync(join(path, file)))])).toEqual(files);
    writeFileSync(evidencePath, 'different observation');
    expect(await restarted.run(args)).toMatchObject({ status: 'blocked', code: 'LIFECYCLE_READBACK_FAILED' });
    expect(f.captures()).toBe(0);
  });

test('withdrawn lifecycle enrollment cannot call its evidence observer after signature validation', async () => {
  const setup = installedLifecycleFixture('install');
  await setup.writer.reserve(setup.operation);
  const claim = await setup.writer.claim(setup.operation);
  if (claim.status !== 'claimed') throw new Error('Fixture claim missing');
  writeFileSync(setup.evidencePath, canonical({ subject: claim.subject, evidenceId: 'observed' }));
  await setup.writer.markCompleted(claim.token, 'observed');
  const originalReads = setup.evidenceReads();
  let onPause!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { onPause = resolve; });
  const waiting = new Promise<void>((resolve) => { resume = resolve; });
  setup.pauseVerification(async () => { onPause(); await waiting; });
  const pending = createRuntimeCli(setup.provisioning).run(setup.args);
  await entered;
  delete setup.registrations[setup.operation.operationId];
  resume();
  expect(await pending).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(setup.evidenceReads()).toBe(originalReads);
});

test.each([undefined, {}])('empty or absent lifecycle enrollment keeps the stale constructor guard (%j)', (registrations) => {
  const f = fixture();
  const provisioning = installedRecoveryProvisioning(f, undefined, registrations);
  f.closeSources();
  expect(() => createRuntimeCli(provisioning)).toThrow('RECOVERY_SERVICE_HANDLE_MISMATCH');
});

test('installed lifecycle readback uses the same own keys at construction and dispatch', async () => {
  const setup = installedLifecycleFixture('install');
  Object.defineProperty(setup.registrations, setup.operation.operationId, { enumerable: false });
  await setup.writer.reserve(setup.operation);
  setup.f.closeSources();
  await expect(createRuntimeCli(setup.provisioning).run(setup.args))
    .resolves.toMatchObject({ status: 'reserved', code: 'LIFECYCLE_RESERVED' });
});

test('verification-only CLI treats the enrolled reader as authoritative if a signed record was damaged', async () => {
  const f = fixture();
  await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  const cold = verificationOnlyHost(f);
  writeFileSync(join(cold.backupReadback.root.path, 'backup.terminal.json'), JSON.stringify({ path: f.root }));
  let liveLookups = 0;
  const cli = createPatrickCli({
    ...cold, recovery: f.host.recovery,
    runtime: { ...cold.runtime, createRecoveryOperations(config) { liveLookups++; return createRecoveryOperations(config); } },
  });
  const result = await cli.run(backupReadCommand);
  expect(result).toMatchObject({ status: 'blocked', code: 'RECOVERY_OPERATION_RECORD_INVALID' });
  expect(JSON.stringify(result)).not.toContain(f.root);
  expect(liveLookups).toBe(0);
  expect(f.captures()).toBe(1);
});

test('verification-only CLI rejects a registered identifier from a different revision', async () => {
  const f = fixture();
  const host = verificationOnlyHost(f);
  host.backupReadback.targets.target.identity.configRevision = '2';
  expect(await createPatrickCli(host).run(backupReadCommand)).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(f.captures()).toBe(0);
});

test('trusted target identity mismatch rejects before effects', async () => {
  const f = fixture(); f.target.identity.configRevision = '2';
  expect(await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup'])).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(f.captures()).toBe(0);
});
test('unsigned terminal cannot claim completed and raw exception stays redacted', async () => {
  const f = fixture();
  await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  const path = join(f.root, 'operations/backup.terminal.json');
  const record = JSON.parse(readFileSync(path, 'utf8')); record.payload.outcome.manifestHash = '0'.repeat(64); writeFileSync(path, JSON.stringify(record));
  expect(await f.cli().run(['backup', '--target', 'target', '--readback', '--operation', 'backup'])).toMatchObject({ status: 'blocked', code: 'RECOVERY_OPERATION_RECORD_INVALID' });
});

test('standalone doctor collects real UID/platform/disk facts and explicit unregistered boundaries', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(entry), 'doctor'], { encoding: 'utf8' });
  const report = JSON.parse(result.stdout);
  expect(report.checks?.host_registration).toMatchObject({ status: 'unavailable', impact: 'core' });
  expect(report.checks?.node_runtime).toMatchObject({ status: 'ready', evidence: { version: process.versions.node } });
  expect(report.checks?.filesystem).toMatchObject({ evidence: { probe: 'statfs' } });
  expect(report.checks?.service_identity.status).toBe('unavailable');
  expect(JSON.stringify(report)).not.toContain(process.cwd());
});
test('doctor projects actual network TLS rejection and separates optional editor from core checks', async () => {
  const f = fixture();
  const policy = { schema_version: '1.0' as const, device_id: 'device', revision: 1,
    targets: [{ id: 'origin', role: 'hub' as const }, { id: 'peer', role: 'peer' as const }], vpn_paths: [], repairs: [],
    limits: { maximum_attempts: 1, cooldown_ms: 5000, deadline_ms: 5000 }, fallback: 'none' as const };
  const ports = { interfaces: async () => 'passed' as const, route: async () => 'passed' as const,
    proxy: async () => 'not_applicable' as const, dns: async () => 'passed' as const, tcp: async () => 'passed' as const,
    tls: async () => 'failed' as const, http: async () => { throw new Error('must not reach HTTP'); } };
  const host = { ...f.host, network: { identity: f.host.identity, policy, ports, originTargetId: 'origin' },
    origin: 'https://localhost:8443', rpId: 'localhost' };
  const report = await createPatrickCli(host).run(['doctor']);
  expect(report.checks?.web_origin).toMatchObject({ status: 'blocked', impact: 'core', evidence: { tls: 'failed' } });
  expect(report.checks?.obsidian_app).toMatchObject({ status: 'unavailable', impact: 'editor' });
  expect(report.checks?.service_identity.status).toBe('ready');
  expect(report.checks?.headless_profile.status).toBe('ready');
  for (const check of Object.values(report.checks ?? {})) {
    expect(check).toMatchObject({ observedAt: expect.stringMatching(/^\d{4}-/), nextStep: expect.any(String), evidence: expect.any(Object) });
  }
});
test('doctor blocks insufficient disk and unavailable runtime while redacting probe exceptions', async () => {
  const f = fixture();
  const host = { ...f.host, minimumFreeBytes: Number.MAX_SAFE_INTEGER, runtime: undefined };
  const report = await createPatrickCli(host).run(['doctor']);
  expect(report.checks?.filesystem.status).toBe('blocked');
  expect(report.checks?.recovery.status).toBe('unavailable');
  expect(report.checks?.native_dependencies.status).toBe('unavailable');
  expect(JSON.stringify(report)).not.toContain(f.root);
});
test('doctor rejects mixed revision network context before invoking a probe', async () => {
  const f = fixture(); let called = 0;
  const host = { ...f.host, network: { identity: { ...f.host.identity, configRevision: '2' },
    policy: {} as never, ports: {} as never, originTargetId: 'origin' },
    runtime: { ...f.host.runtime, createNetworkInspector: (() => { called++; throw new Error('secret'); }) as typeof createNetworkInspector } };
  const report = await createPatrickCli(host).run(['doctor']);
  expect(report.checks?.network).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
  expect(called).toBe(0);
});

import { connectVault, confirmVault, requireVault, inspectVault } from '../../packages/integrations/vault/connection.js';
import { canonicalize } from '../../deploy/lib/release.mjs';
test('doctor composes actual T27 registration, installer and filesystem permission inspection', async () => {
  const f = fixture(); const root = join(f.root, 'vault'); mkdirSync(root);
  const db = openDatabase(join(f.root, 'vault.sqlite')); cleanup.push(() => db.close());
  await connectVault(db, { deviceId: 'device', vaultId: 'vault', captureHost: hostname(), now: new Date().toISOString(), root,
    accountId: 'owner', domain: 'personal' });
  await confirmVault(db, 'device', 'vault', new Date().toISOString());
  const options = { deviceId: 'device', captureHost: hostname(), serviceUid: process.geteuid!(), editorUid: process.geteuid!(), stageParent: f.root,
    loadVault: (vaultId: string) => requireVault(db, vaultId), inspectVault: (deviceId: string, vaultId: string) => inspectVault(db, deviceId, vaultId),
    inspectObsidian: createObsidianInspector({ localDeviceId: 'device', lockedVersion: null, installerHash: null, readMacState: async () => ({ application: null }) }),
    syncMode: 'single_device' as const };
  const vault = requireVault(db, 'vault');
  const host = { ...f.host, vaults: { vault: { identity: f.host.identity, configRevision: vault.config_revision, scopeHash: vault.scope_hash, options, installer: options } } };
  const kitAdapter = (await import('../../deploy/cli/patrick.mjs')).createVaultKitAdapter;
  expect(kitAdapter).toBeTypeOf('function');
  expect(await kitAdapter(host).install('vault')).toMatchObject({ vaultId: 'vault', configRevision: 1, manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const result = await createPatrickCli(host).run(['doctor', '--vault', 'vault']);
  expect(result.checks?.vault.status).toBe('ready');
  expect(result.checks?.obsidian_app).toMatchObject({ status: 'blocked', impact: 'editor' });
  expect(result.checks?.vault_sync).toMatchObject({ status: 'ready', evidence: { mode: 'single_device' } });
  expect(JSON.stringify(result)).not.toContain(root);
  expect(await createPatrickCli(host).run(['init', '--vault', 'vault'])).toMatchObject({ status: 'preview', code: 'VAULT_INITIALIZATION_PREVIEW' });
  host.vaults.vault.configRevision++;
  expect((await createPatrickCli(host).run(['doctor', '--vault', 'vault'])).checks?.vault.status).toBe('blocked');
});
function candidateFixture(f: ReturnType<typeof fixture>) {
  const keys = generateKeyPairSync('ed25519'); const commit = 'a'.repeat(40); const version = '1.2.3';
  const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
  const lock = JSON.stringify({ packages: {} });
  const raw = {
    'evidence/T25.json': JSON.stringify({ task: 'T25', versions: { release: version, commit, os: 'darwin', arch: 'arm64' },
      scenarios: [{ id: 'fixture', command: 'synthetic', versions: { fixture: '1' }, status: 'passed', exitCode: 0, evidenceFile: 'evidence/probe.txt', evidenceSha256: hash('synthetic') }] }),
    'evidence/probe.txt': 'synthetic',
    'metadata/sbom.json': JSON.stringify({ format: 'patrick-lock-sbom-v1', commit, lockSha256: hash(lock), packages: {} }),
    'source/package-lock.json': lock, 'source/package.json': JSON.stringify({ version }),
  };
  const files = Object.entries(raw).sort(([a], [b]) => a < b ? -1 : 1).map(([path, content]) => ({ path, content: Buffer.from(content).toString('base64') }));
  const artifacts = files.map(({ path, content }) => { const data = Buffer.from(content, 'base64'); return { path, sha256: hash(data), bytes: data.length, mode: '100644' }; });
  const inputs = artifacts.filter((artifact) => artifact.path.startsWith('source/')).map((artifact) => {
    const data = Buffer.from(files.find((file) => file.path === artifact.path)!.content, 'base64');
    return { ...artifact, path: artifact.path.slice(7), gitBlob: createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') };
  });
  const manifest = { format: 'patrick-release-manifest-v1', kind: 'source-candidate', version, commit,
    target: { os: 'darwin', arch: 'arm64' }, schema: { min: 1, max: 2 }, runtime: { status: 'unavailable',
      prerequisites: ['installed-service-bootstrap', 'installed-hub-worker-bootstrap', 'target-native-sqlite-runtime', 'native-host-acceptance'] },
    artifacts, inputs, sbom: 'metadata/sbom.json', evidence: [{ id: 'T25', path: 'evidence/T25.json' }] };
  const envelope = { format: 'patrick-release-envelope-v1', manifest, files,
    signatures: [{ keyId: 'fixture', signature: sign(null, Buffer.from(canonicalize(manifest)), keys.privateKey).toString('base64') }] };
  const path = join(f.root, 'candidate.json'); writeFileSync(path, canonicalize(envelope));
  let stagingReads = 0;
  const release = { identity: f.host.identity, candidatePath: path, expected: { version, commit, os: 'darwin', arch: 'arm64', schema: 1 },
    policy: { keys: [{ id: 'fixture', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }], requiredEvidence: ['T25'] },
    staging: { async withExclusiveReadRoot<T>(read: (root: string) => Promise<T>) { stagingReads++; return read(f.root); } } };
  return { release, path, reads: () => stagingReads };
}
test.each([
  ['class', 'public-key'], ['class', 'schema'], ['ordinary', 'public-key'], ['ordinary', 'schema'],
] as const)('rejects %s release row %s drift during a real signed package fstat', (kind, changedField) => {
  const f = fixture(), candidate = candidateFixture(f);
  const host = { identity: f.host.identity, captureHost: f.host.captureHost, serviceUid: f.host.serviceUid,
    profile: f.host.profile, dataRoot: f.host.dataRoot, minimumFreeBytes: f.host.minimumFreeBytes,
    releases: { candidate: { ...candidate.release, staging: undefined } } };
  const module = new URL('../../deploy/cli/patrick.mjs', import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';import fs from 'node:fs';import {generateKeyPairSync} from 'node:crypto';
    import {syncBuiltinESMExports} from 'node:module';
    const [raw,root,path,kind,field]=process.argv.slice(1),host=JSON.parse(raw);
    const data=host.releases.candidate;
    const row=kind==='class'?Object.assign(new class ReleaseRow {},data):data;
    const goodKey=row.policy.keys[0].publicKey,goodSchema=row.expected.schema;
    if(field==='public-key') row.policy.keys[0].publicKey=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString();
    else row.expected.schema=99;
    let changed=false,reads=0,closed=0,signerGets=0;
    Object.defineProperty(row,'signer',{get(){signerGets++;throw Error('unexpected signer');}});
    const open=fs.promises.open;
    fs.promises.open=async function(name,...args){const handle=await Reflect.apply(open,this,[name,...args]);
      if(name===path){const stat=handle.stat,read=handle.read,close=handle.close;
        handle.stat=async function(...values){const result=await Reflect.apply(stat,this,values);if(!changed){changed=true;
          if(field==='public-key')row.policy.keys[0].publicKey=goodKey;else row.expected.schema=goodSchema;}return result;};
        handle.read=async function(...values){if(changed)reads++;return Reflect.apply(read,this,values);};
        handle.close=async function(...values){closed++;return Reflect.apply(close,this,values);};
      }return handle;};
    syncBuiltinESMExports();
    const {createPatrickCli}=await import(${JSON.stringify(module)});
    row.staging={async withExclusiveReadRoot(read){return await read(root);}};
    host.releases.candidate=row;
    const result=await createPatrickCli(host).run(['install','--release','candidate']);
    console.log(JSON.stringify({kind,field,changed,reads,closed,signerGets,status:result.status,code:result.code}));
    assert(changed);assert.equal(result.status,'blocked');assert.equal(reads,0);assert.equal(closed,1);assert.equal(signerGets,0);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(host), f.root, candidate.path, kind, changedField],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 120_000);

test.each(['policy', 'expected', 'nested-key', 'nested-schema'] as const)(
  'refuses class release row %s accessor without executing it', async key => {
  const f = fixture(), candidate = candidateFixture(f);
  const row = Object.assign(new class ReleaseRow {}, candidate.release);
  let getters = 0;
  const object = key === 'policy' || key === 'expected' ? row : key === 'nested-key' ? row.policy.keys[0] : row.expected;
  const property = key === 'nested-key' ? 'publicKey' : key === 'nested-schema' ? 'schema' : key;
  const original = Reflect.get(object, property);
  Object.defineProperty(object, property, { configurable: true, enumerable: true, get() { getters++; return original; } });
  const host = { ...f.host, releases: { candidate: row } };
  const result = await createPatrickCli(host).run(['install', '--release', 'candidate']);
  expect(result.status).toBe('blocked');
  expect(getters).toBe(0);
}, 120_000);

test('rejects inherited digest constraints before entering staging', async () => {
  const f = fixture(), candidate = candidateFixture(f);
  const row = Object.assign(new class ReleaseRow {}, candidate.release);
  let gets = 0;
  Object.setPrototypeOf(row.expected, { get packageSha256() { gets++; return '0'.repeat(64); } });
  const result = await createPatrickCli({ ...f.host, releases: { candidate: row } }).run(['install', '--release', 'candidate']);
  expect(result.status).toBe('blocked');
  expect(gets).toBe(0);
  expect(candidate.reads()).toBe(0);
});

test.each(['class', 'ordinary'] as const)('accepts an unchanged %s release row without reading an unrelated signer', async kind => {
  const f = fixture(), candidate = candidateFixture(f);
  const row = kind === 'class' ? Object.assign(new class ReleaseRow {}, candidate.release) : candidate.release;
  let getters = 0;
  Object.defineProperty(row, 'signer', { configurable: true, get() { getters++; throw Error('unexpected signer'); } });
  const host = { ...f.host, releases: { candidate: row } };
  expect(await createPatrickCli(host).run(['install', '--release', 'candidate'])).toMatchObject({ status: 'preview' });
  expect(getters).toBe(0);
}, 120_000);
test('legacy Ed25519 candidate preview keeps genuine recursive derived staging and its original receiver', async () => {
  const f = fixture(), candidate = candidateFixture(f);
  const original = candidate.release.staging;
  class Owner {
    async withExclusiveReadRoot<T>(read: (root: string) => Promise<T>) {
      expect(this).toBe(owner);
      return Reflect.apply(original.withExclusiveReadRoot<T>, original, [read]);
    }
  }
  const owner = new Owner();
  const selected = (staging: typeof owner) => ({ ...f.host, releases: { candidate: { ...candidate.release, staging } } });
  expect(await createPatrickCli(selected(owner)).run(['install', '--release', 'candidate'])).toMatchObject({ status: 'preview' });
  let expired!: typeof owner;
  await leased(owner, async parent => {
    const child = deriveRuntimeStaging(parent, f.root);
    expired = child;
    expect(await createPatrickCli(selected(child)).run(['install', '--release', 'candidate'])).toMatchObject({ status: 'preview' });
    await leased(child, async nested => {
      const grandchild = deriveRuntimeStaging(nested, f.root);
      expect(await createPatrickCli(selected(grandchild)).run(['install', '--release', 'candidate'])).toMatchObject({ status: 'preview' });
    }, true);
    const forged = { withExclusiveReadRoot: child.withExclusiveReadRoot };
    expect((await createPatrickCli(selected(forged)).run(['install', '--release', 'candidate'])).status).toBe('blocked');
    const narrow = deriveRuntimeStaging(parent, join(f.root, 'isolated'));
    expect((await createPatrickCli(selected(narrow)).run(['install', '--release', 'candidate'])).status).toBe('blocked');
  }, true);
  expect((await createPatrickCli(selected(expired)).run(['install', '--release', 'candidate'])).status).toBe('blocked');
}, 120_000);

test('legacy candidate refuses an unadmitted class staging getter without invoking it', async () => {
  const f = fixture(), candidate = candidateFixture(f);
  let getters = 0;
  class Staging { get withExclusiveReadRoot() { getters++; return candidate.release.staging.withExclusiveReadRoot; } }
  const host = { ...f.host, releases: { candidate: { ...candidate.release, staging: new Staging() } } };
  const result = await createPatrickCli(host).run(['install', '--release', 'candidate']);
  expect(['blocked', 'unavailable']).toContain(result.status);
  expect(getters).toBe(0);
});

test('legacy candidate never combines an old original port with a newly selected registration', async () => {
  const f = fixture(), candidate = candidateFixture(f);
  let reads = 0, firstCalls = 0, secondCalls = 0;
  const first = { async withExclusiveReadRoot<T>(read: (root: string) => Promise<T>) { firstCalls++; return read(f.root); } };
  const second = { async withExclusiveReadRoot<T>(read: (root: string) => Promise<T>) { secondCalls++; return read(f.root); } };
  const entries = { candidate: { ...candidate.release, staging: first } };
  const replacement = { ...candidate.release, staging: second };
  const host = Object.defineProperty({ ...f.host }, 'releases', { get() {
    if (++reads === 3) entries.candidate = replacement;
    return entries;
  } });
  const result = await createPatrickCli(host).run(['install', '--release', 'candidate']);
  expect(result).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(firstCalls).toBe(0);
  expect(secondCalls).toBe(0);
});

test.each(['fstat', 'short-read'] as const)(
  'legacy signed candidate stops after parent loss during %s and always closes the handle', scenario => {
  const f = fixture(), candidate = candidateFixture(f);
  const host = { identity: f.host.identity, captureHost: f.host.captureHost, serviceUid: f.host.serviceUid,
    profile: f.host.profile, dataRoot: f.host.dataRoot, minimumFreeBytes: f.host.minimumFreeBytes,
    releases: { candidate: { ...candidate.release, staging: undefined } } };
  const module = new URL('../../deploy/cli/patrick.mjs', import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [raw,root,path,scenario]=process.argv.slice(1),host=JSON.parse(raw);
    let start,resume,pending,released=false,armed=false,lateReads=0,lateStats=0,closed=0;
    const entered=new Promise(resolve=>start=resolve),continuing=new Promise(resolve=>resume=resolve);
    const open=fs.promises.open;
    fs.promises.open=async function(name,...args){const handle=await Reflect.apply(open,this,[name,...args]);
      if(name===path){const stat=handle.stat,read=handle.read,close=handle.close;
        handle.close=async function(...values){closed++;return Reflect.apply(close,this,values);};
        handle.stat=async function(...values){if(released)lateStats++;const result=await Reflect.apply(stat,this,values);
          if(scenario==='fstat'&&!armed){armed=true;start();await continuing;}return result;};
        handle.read=async function(buffer,offset,length,position){if(released)lateReads++;
          if(scenario==='short-read'&&!armed){armed=true;const result=await Reflect.apply(read,this,[buffer,offset,Math.min(length,1),position]);start();await continuing;return result;}
          return Reflect.apply(read,this,[buffer,offset,length,position]);};
      }return handle;};
    syncBuiltinESMExports();
    const {createPatrickCli}=await import(${JSON.stringify(module)});
    host.releases.candidate.staging={async withExclusiveReadRoot(read){pending=read(root);pending.catch(()=>{});await entered;released=true;setImmediate(resume);}};
    const result=await createPatrickCli(host).run(['install','--release','candidate']);
    await pending.catch(()=>{});
    console.log(JSON.stringify({scenario,released,armed,lateReads,lateStats,closed,status:result.status}));
    assert(released&&armed);assert.equal(result.status,'blocked');
    assert.equal(lateReads,0);assert.equal(lateStats,0);assert.equal(closed,1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(host), f.root, candidate.path, scenario],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 120_000);
test('legacy signed candidate rejects class owner getter drift after real fstat without calling it', () => {
  const f = fixture(), candidate = candidateFixture(f);
  const host = { identity: f.host.identity, captureHost: f.host.captureHost, serviceUid: f.host.serviceUid,
    profile: f.host.profile, dataRoot: f.host.dataRoot, minimumFreeBytes: f.host.minimumFreeBytes,
    releases: { candidate: { ...candidate.release, staging: undefined } } };
  const module = new URL('../../deploy/cli/patrick.mjs', import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const [raw,root,path]=process.argv.slice(1),host=JSON.parse(raw);
    let changed=false,getters=0,lateReads=0,closed=0;
    class Owner { async withExclusiveReadRoot(read){assert.equal(this,owner);return await read(root);} }
    const owner=new Owner(),original=Owner.prototype.withExclusiveReadRoot,open=fs.promises.open;
    fs.promises.open=async function(name,...args){const handle=await Reflect.apply(open,this,[name,...args]);
      if(name===path){const stat=handle.stat,read=handle.read,close=handle.close;
        handle.stat=async function(...values){const result=await Reflect.apply(stat,this,values);if(!changed){changed=true;
          Object.defineProperty(owner,'withExclusiveReadRoot',{configurable:true,get(){getters++;return original;}});}return result;};
        handle.read=async function(...values){if(changed)lateReads++;return Reflect.apply(read,this,values);};
        handle.close=async function(...values){closed++;return Reflect.apply(close,this,values);};
      }return handle;};
    syncBuiltinESMExports();
    const {createPatrickCli}=await import(${JSON.stringify(module)});
    host.releases.candidate.staging=owner;
    const result=await createPatrickCli(host).run(['install','--release','candidate']);
    console.log(JSON.stringify({changed,getters,lateReads,closed,status:result.status}));
    assert(changed);assert.equal(result.status,'blocked');assert.equal(getters,0);assert.equal(lateReads,0);assert.equal(closed,1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(host), f.root, candidate.path],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 120_000);
test('install and upgrade verify actual signed candidate under trusted exclusive staging and keep installable false', async () => {
  const f = fixture(); const candidate = candidateFixture(f);
  const host = { ...f.host, releases: { candidate: candidate.release } };
  for (const command of ['install', 'upgrade']) {
    const result = await createPatrickCli(host).run([command, '--release', 'candidate']);
    expect(result).toMatchObject({ status: 'preview', candidate: { installable: false, runtime: 'unavailable', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(await createPatrickCli(host).run([command, '--release', 'candidate', '--execute', '--operation', 'install'])).toMatchObject({ status: 'unavailable', code: 'RELEASE_RUNTIME_REQUIRED' });
  }
  expect(candidate.reads()).toBe(4);
  writeFileSync(candidate.path, JSON.stringify({ installable: true, status: 'verified-candidate', credential: 'SECRET' }));
  const result = await createPatrickCli(host).run(['install', '--release', 'candidate']);
  expect(result).toMatchObject({ status: 'blocked', code: 'RELEASE_VERIFICATION_FAILED' });
  expect(JSON.stringify(result)).not.toContain('SECRET');
});
test('release selection requires independently registered staging authority and denies request chosen physical root', async () => {
  const f = fixture(); const candidate = candidateFixture(f);
  const host = { ...f.host, releases: { candidate: { ...candidate.release, staging: undefined } } };
  expect(await createPatrickCli(host).run(['install', '--release', 'candidate'])).toMatchObject({ status: 'unavailable', code: 'CONTROLLED_STAGING_REQUIRED' });
  expect(await createPatrickCli(host).run(['install', '--release', 'candidate', '--read-root', f.root])).toMatchObject({ status: 'invalid' });
  expect(candidate.reads()).toBe(0);
});

test('a staging callback cannot fabricate a verified release receipt', async () => {
  const f = fixture(); const candidate = candidateFixture(f);
  const host = { ...f.host, releases: { candidate: { ...candidate.release, staging: {
    async withExclusiveReadRoot<T>(): Promise<T> { return { sha256: '0'.repeat(64), manifestSha256: '0'.repeat(64), installable: true } as T; },
  } } } };
  expect(await createPatrickCli(host).run(['install', '--release', 'candidate'])).toMatchObject({ status: 'blocked', code: 'RELEASE_VERIFICATION_FAILED' });
});
test('runtime constructor failure is bounded and redacted', async () => {
  const f = fixture();
  f.host.runtime.createRecoveryOperations = (() => { throw new Error('SECRET /private/credential'); }) as typeof createRecoveryOperations;
  const result = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'op']);
  expect(result).toMatchObject({ status: 'blocked', code: 'RECOVERY_OPERATION_FAILED' });
  expect(JSON.stringify(result)).not.toContain('SECRET');
});

import { createServer } from 'node:https';
import { createNodeNetworkProbePorts } from '../../packages/host/src/network/node-probes.js';
test('doctor uses real Node TLS verification on a synthetic loopback server', async () => {
  const f = fixture(); const keyPath = join(f.root, 'synthetic.key'); const certificatePath = join(f.root, 'synthetic.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyPath, '-out', certificatePath,
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, (_request, response) => { response.end('synthetic'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture listener');
    const origin = `https://127.0.0.1:${address.port}`;
    const policy = { schema_version: '1.0' as const, device_id: 'device', revision: 1,
      targets: [{ id: 'origin', role: 'hub' as const }, { id: 'peer', role: 'peer' as const }], vpn_paths: [], repairs: [],
      limits: { maximum_attempts: 1, cooldown_ms: 5000, deadline_ms: 5000 }, fallback: 'none' as const };
    const node = { policy, localDeviceId: 'device', endpoints: policy.targets.map((target) => ({ targetId: target.id, url: origin,
      identity: () => 'verified' as const, peer: async () => 'passed' as const, ...(target.id === 'peer' ? { ca: readFileSync(certificatePath) } : {}) })),
      local: { interfaces: async () => 'passed' as const, route: async () => 'passed' as const, proxy: async () => 'not_applicable' as const } };
    const host = { ...f.host, origin, rpId: '127.0.0.1', network: { identity: f.host.identity, policy, node, originTargetId: 'origin' },
      runtime: { ...f.host.runtime, createNodeNetworkProbePorts } };
    const result = await createPatrickCli(host).run(['doctor']);
    expect(result.checks?.web_origin).toMatchObject({ status: 'blocked', evidence: { fixedOrigin: true, tls: 'failed' } });
    expect(JSON.stringify(result)).not.toContain(origin);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
test('doctor readiness probes have a bounded deadline and receive cancellation', async () => {
  const f = fixture(); let aborted = false;
  const host = { ...f.host, readiness: { executor: { identity: f.host.identity, inspect: async (signal: AbortSignal) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise<never>(() => {});
  } } } };
  const started = Date.now();
  const result = await createPatrickCli(host).run(['doctor']);
  expect(result.checks?.executor).toMatchObject({ status: 'unknown', evidence: { code: 'READINESS_PROBE_UNAVAILABLE' } });
  expect(aborted).toBe(true); expect(Date.now() - started).toBeLessThan(7000);
}, 10000);
test('doctor reads existing signed backup and drill completion without invoking recovery again', async () => {
  const f = fixture();
  const backup = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  await f.cli().run(['restore', '--target', 'target', '--manifest', backup.manifestHash!, '--execute', '--operation', 'drill']);
  const host = { ...f.host, recoveryReadbacks: [{ targetId: 'target', backupOperationId: 'backup', drillOperationId: 'drill', manifestHash: backup.manifestHash! }] };
  const before = readdirSync(join(f.root, 'operations'));
  const result = await createPatrickCli(host).run(['doctor']);
  expect(result.checks?.recovery_backup).toMatchObject({ status: 'ready', evidence: { localSet: 'completed' } });
  expect(result.checks?.recovery_drill).toMatchObject({ status: 'ready', evidence: { isolatedDrill: 'completed' } });
  expect(f.captures()).toBe(1);
  expect(readdirSync(join(f.root, 'operations'))).toEqual(before);
});

test('doctor checks enrolled off-host protection even when live recovery is available', async () => {
  const f = fixture();
  Object.assign(f.target.backup.options, { offHost: { async protect(set: { manifestHash: string }) {
    return { encrypted: true, offHost: true, verified: true, domains: ['personal'], targetId: 'fixture-offsite',
      snapshotId: 'fixture-snapshot', recoveryCredentialRef: 'fixture-ref', verifiedAt: new Date().toISOString(), manifestHash: set.manifestHash };
  } } });
  const completed = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  expect(completed.status).toBe('completed');
  const { backupReadback } = verificationOnlyHost(f);
  let confirmed = false;
  let verifications = 0;
  const host = {
    ...f.host,
    runtime: { ...f.host.runtime, createRecoveryBackupReader },
    backupReadback: { ...backupReadback, targets: { target: { ...backupReadback.targets.target,
      protection: { kind: 'off_host' as const, async verify() { verifications++; return confirmed; } },
    } } },
    recoveryReadbacks: [{ targetId: 'target', backupOperationId: 'backup', drillOperationId: 'drill', manifestHash: completed.manifestHash! }],
  };
  const cli = createPatrickCli(host);
  expect((await cli.run(['doctor'])).checks?.recovery_backup).toMatchObject({ status: 'blocked' });
  confirmed = true;
  expect((await cli.run(['doctor'])).checks?.recovery_backup).toMatchObject({ status: 'ready' });
  expect(verifications).toBe(2);
  expect(f.captures()).toBe(1);
});

test('installed doctor verifies a signed backup when only its cold reader remains enrolled', async () => {
  const f = fixture();
  const completed = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  expect(completed.status).toBe('completed');
  const { backupReadback } = verificationOnlyHost(f);
  f.closeSources();
  const provisioning = createRuntimeProvisioning({
    registration: {
      identity: f.host.identity, captureHost: f.host.captureHost, serviceUid: f.host.serviceUid,
      dataRoot: f.root, minimumFreeBytes: 1, profile: 'test', origin: 'http://localhost', rpId: 'localhost',
      listener: { host: '127.0.0.1', port: 0, origin: 'http://localhost' },
    },
    hostCapabilities: { backupReadback, recoveryReadbacks: [
      { targetId: 'target', backupOperationId: 'backup', drillOperationId: 'drill', manifestHash: completed.manifestHash! },
    ] },
    service: {
      databasePath: join(f.root, 'service.sqlite'), credentialDirectory: f.root,
      recoveryRuntime: { attach() { throw new Error('Unexpected service startup'); } },
      bindRecoveryOperations() { throw new Error('Unexpected live recovery'); },
    },
  });
  const journal = backupReadback.root.path;
  const before = readdirSync(journal).sort().map((file) => [file, digest(readFileSync(join(journal, file)))]);
  const result = await createRuntimeCli(provisioning).run(['doctor']);
  expect(result.checks?.recovery_backup).toMatchObject({ status: 'ready', evidence: { localSet: 'completed', offHostProtection: 'not_configured' } });
  expect(result.checks?.recovery_drill).toMatchObject({ status: 'unavailable', evidence: { code: 'SIGNED_DRILL_READBACK_REQUIRED' } });
  expect(result.checks?.recovery).toMatchObject({ status: 'unavailable' });
  expect(readdirSync(journal).sort().map((file) => [file, digest(readFileSync(join(journal, file)))])).toEqual(before);
  expect(JSON.stringify(result)).not.toContain(f.root);
  writeFileSync(join(journal, 'backup.terminal.json'), canonical({ invalid: f.root }));
  expect((await createRuntimeCli(provisioning).run(['doctor'])).checks?.recovery_backup)
    .toMatchObject({ status: 'blocked', evidence: { code: 'SIGNED_RECOVERY_READBACK_FAILED' } });
  expect(f.captures()).toBe(1);
});

test('doctor refuses a replacement cold verifier installed during an early network probe', async () => {
  const f = fixture();
  const completed = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  expect(completed.status).toBe('completed');
  const cold = verificationOnlyHost(f);
  f.closeSources();
  const verifier = cold.backupReadback.authority;
  let replacementCalls = 0;
  const host: RegisteredHost = {
    ...cold, origin: 'https://patrick.test', rpId: 'patrick.test',
    runtime: { ...cold.runtime, createNetworkInspector },
    recoveryReadbacks: [{ targetId: 'target', backupOperationId: 'backup', drillOperationId: 'drill', manifestHash: completed.manifestHash! }],
    network: {
      identity: cold.identity, origin: 'https://patrick.test', originTargetId: 'origin',
      policy: { schema_version: '1.0', device_id: 'device', revision: 1, targets: [{ id: 'origin', role: 'hub' }, { id: 'peer', role: 'peer' }],
        vpn_paths: [], repairs: [], limits: { maximum_attempts: 1, cooldown_ms: 5000, deadline_ms: 5000 }, fallback: 'none' },
      ports: {
        async interfaces() {
          cold.backupReadback.authority = { keyId: verifier.keyId, async verify(...args) {
            replacementCalls++;
            return verifier.verify(...args);
          } };
          return 'passed';
        },
        dns: async () => 'passed', tcp: async () => 'passed', tls: async () => 'passed',
        http: async () => ({ status: 200, identity: 'verified' }),
      },
    },
  };
  const result = await createPatrickCli(host).run(['doctor']);
  expect(cold.backupReadback.authority).not.toBe(verifier);
  expect.soft(replacementCalls).toBe(0);
  expect(result.checks?.recovery_backup).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
});

test('doctor invalidates an authenticated backup when a later probe changes a class verifier', async () => {
  const f = fixture();
  const completed = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  expect(completed.status).toBe('completed');
  const cold = verificationOnlyHost(f);
  f.closeSources();
  class Verifier {
    #original = cold.backupReadback.authority;
    keyId = this.#original.keyId;
    calls = 0;
    async verify(...args: Parameters<typeof cold.backupReadback.authority.verify>) {
      this.calls++;
      return this.#original.verify(...args);
    }
  }
  const verifier = new Verifier();
  cold.backupReadback.targets.target.authority = verifier;
  const host: RegisteredHost = {
    ...cold,
    recoveryReadbacks: [{ targetId: 'target', backupOperationId: 'backup', drillOperationId: 'drill', manifestHash: completed.manifestHash! }],
  };
  expect((await createPatrickCli(host).run(['doctor'])).checks?.recovery_backup?.status).toBe('ready');
  let callsBeforeMutation = 0;
  verifier.calls = 0;
  host.readiness = { executor: { identity: cold.identity, async inspect() {
    callsBeforeMutation = verifier.calls;
    verifier.verify = async () => false;
    return { capability: 'ready' };
  } } };
  const result = await createPatrickCli(host).run(['doctor']);
  expect(callsBeforeMutation).toBeGreaterThan(0);
  expect(result.checks?.executor?.status).toBe('ready');
  expect(result.checks?.recovery_backup).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
});

test.each(['receipt digest', 'target identity'] as const)('doctor invalidates an authenticated backup after a later change to the class-backed %s', async (field) => {
  const f = fixture();
  const completed = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  expect(completed.status).toBe('completed');
  const cold = verificationOnlyHost(f);
  f.closeSources();
  class BackupReference {
    targetId = 'target';
    backupOperationId = 'backup';
    drillOperationId = 'drill';
    manifestHash = completed.manifestHash!;
  }
  class TargetIdentity {
    accountId = f.host.identity.accountId;
    scopeId = f.host.identity.scopeId;
    domains = [...f.host.identity.domains];
    deviceId = f.host.identity.deviceId;
    configRevision = f.host.identity.configRevision;
  }
  const reference = new BackupReference();
  const identity = new TargetIdentity();
  cold.backupReadback.targets.target.identity = identity;
  const host: RegisteredHost = { ...cold, recoveryReadbacks: [reference] };
  expect((await createPatrickCli(host).run(['doctor'])).checks?.recovery_backup?.status).toBe('ready');
  host.readiness = { executor: { identity: cold.identity, async inspect() {
    if (field === 'receipt digest') reference.manifestHash = 'f'.repeat(64);
    else identity.configRevision = '2';
    return { capability: 'ready' };
  } } };
  const result = await createPatrickCli(host).run(['doctor']);
  expect(result.checks?.executor?.status).toBe('ready');
  expect(result.checks?.recovery_backup).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
});

test('registered service UID mismatch blocks recovery execution before authority use', async () => {
  const f = fixture(); f.host.serviceUid++;
  expect(await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup'])).toMatchObject({ status: 'blocked', code: 'HOST_SERVICE_IDENTITY_MISMATCH' });
  expect(f.captures()).toBe(0);
});


test('doctor refuses a symlinked registered data root even with sufficient disk', async () => {
  const f = fixture(); const linked = join(f.root, 'linked'); symlinkSync(f.root, linked);
  const report = await createPatrickCli({ ...f.host, dataRoot: linked }).run(['doctor']);
  expect(report.checks?.filesystem.status).toBe('blocked');
});

test.each(['read', 'reserve', 'invoke'] as const)('actual recovery refuses selected registration replacement at %s handoff', async (stage) => {
  const f = fixture(); let replacements = 0; let replacementEffects = 0;
  const replace = () => {
    replacements++;
    f.host.recovery.targets.target = { ...f.target, identity: { ...f.target.identity, accountId: stage === 'reserve' ? 'owner' : 'other' },
      backup: { ...f.target.backup, options: { ...f.target.backup.options, freeze: { async acquire() {
        replacementEffects++;
        throw new Error('replacement effect was invoked');
      } } } } };
  };
  f.host.runtime.createRecoveryOperations = (options) => {
    const actual = createRecoveryOperations(options);
    return {
      ...actual,
      async read(request) { const result = await actual.read(request); if (stage === 'read' && replacements === 0) replace(); return result; },
      async reserve(request) { const result = await actual.reserve(request); if (stage === 'reserve' && replacements === 0) replace(); return result; },
      run(request, beforeInvoke) { return actual.run(request, () => { if (stage === 'invoke' && replacements === 0) replace(); beforeInvoke?.(); }); },
    };
  };
  const result = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'mutation']);
  expect(result.code).toBe('HOST_IDENTITY_MISMATCH');
  expect(result.status).toBe(stage === 'invoke' ? 'uncertain' : 'blocked');
  expect(replacements).toBe(1); expect(replacementEffects).toBe(0); expect(f.captures()).toBe(0);
  expect(readdirSync(join(f.root, 'sets'))).toEqual([]);
  if (stage === 'invoke') {
    f.host.recovery.targets.target = f.target;
    expect(await f.cli().run(['backup', '--target', 'target', '--readback', '--operation', 'mutation'])).toMatchObject({ status: 'uncertain' });
    expect(await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'mutation'])).toMatchObject({ status: 'uncertain' });
    expect(f.captures()).toBe(0); expect(replacementEffects).toBe(0);
  }
});
test('actual recovery blocks completed readback after current selection replacement without invoking effects', async () => {
  const f = fixture(); await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  const before = readdirSync(join(f.root, 'operations'));
  f.host.runtime.createRecoveryOperations = (options) => {
    const actual = createRecoveryOperations(options);
    return { ...actual, async read(request) { const result = await actual.read(request); f.host.recovery.targets.target = { ...f.target }; return result; } };
  };
  expect(await f.cli().run(['backup', '--target', 'target', '--readback', '--operation', 'backup'])).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(f.captures()).toBe(1); expect(readdirSync(join(f.root, 'operations'))).toEqual(before);
});
test.each(['host', 'registration', 'configuration'] as const)('doctor blocks readiness after awaited %s mutation', async (kind) => {
  const f = fixture();
  const probe = { identity: { ...f.host.identity }, inspect: async (_signal: AbortSignal) => {
    if (kind === 'host') f.host.identity = { ...f.host.identity, configRevision: '2' };
    if (kind === 'registration') host.readiness.service = { ...probe };
    if (kind === 'configuration') probe.identity.configRevision = '2';
    return { liveness: 'ready' as const, readiness: 'ready' as const };
  } };
  const host = { ...f.host, readiness: { service: probe } };
  // Mutate the same live host object consumed by the composition.
  if (kind === 'host') probe.inspect = async () => { host.identity = { ...host.identity, configRevision: '2' }; return { liveness: 'ready', readiness: 'ready' }; };
  const result = await createPatrickCli(host).run(['doctor']);
  expect(result.checks?.service).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
});
test.each(['registration', 'configuration', 'host'] as const)('actual network doctor blocks awaited %s mutation', async (kind) => {
  const f = fixture();
  const policy = { schema_version: '1.0' as const, device_id: 'device', revision: 1,
    targets: [{ id: 'origin', role: 'hub' as const }, { id: 'peer', role: 'peer' as const }], vpn_paths: [], repairs: [],
    limits: { maximum_attempts: 1, cooldown_ms: 5000, deadline_ms: 5000 }, fallback: 'none' as const };
  let mutated = false;
  const ports = { interfaces: async () => 'passed' as const, route: async () => 'passed' as const, proxy: async () => 'not_applicable' as const,
    dns: async () => 'passed' as const, tcp: async () => 'passed' as const, tls: async () => {
      if (!mutated) {
        mutated = true;
        if (kind === 'registration') host.network = { ...host.network };
        if (kind === 'configuration') policy.revision++;
        if (kind === 'host') host.identity = { ...host.identity, configRevision: '2' };
      }
      return 'passed' as const;
    }, http: async () => ({ status: 200, identity: 'verified' as const }), peer: async () => 'passed' as const };
  const host = { ...f.host, origin: 'https://localhost', rpId: 'localhost', network: { identity: { ...f.host.identity }, policy, ports, originTargetId: 'origin', origin: 'https://localhost' } };
  const result = await createPatrickCli(host).run(['doctor']);
  expect(result.checks?.network).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
  expect(result.checks?.web_origin.status).toBe('blocked');
});
test.each(['registration', 'target', 'host'] as const)('actual signed recovery doctor blocks awaited %s mutation', async (kind) => {
  const f = fixture(); const backup = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  await f.cli().run(['restore', '--target', 'target', '--manifest', backup.manifestHash!, '--execute', '--operation', 'drill']);
  const host = { ...f.host, recoveryReadbacks: [{ targetId: 'target', backupOperationId: 'backup', drillOperationId: 'drill', manifestHash: backup.manifestHash! }] };
  const before = readdirSync(join(f.root, 'operations')); let mutated = false;
  host.runtime = { ...host.runtime, createRecoveryOperations: (options) => {
    const actual = createRecoveryOperations(options);
    return { ...actual, async read(request) {
      const result = await actual.read(request);
      if (!mutated) {
        mutated = true;
        if (kind === 'registration') host.recovery = { ...host.recovery };
        if (kind === 'target') host.recovery.targets.target = { ...f.target };
        if (kind === 'host') host.identity = { ...host.identity, configRevision: '2' };
      }
      return result;
    } };
  } };
  const result = await createPatrickCli(host).run(['doctor']);
  expect(result.checks?.recovery_backup).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
  expect(result.checks?.recovery_drill.status).toBe('blocked');
  expect(f.captures()).toBe(1); expect(readdirSync(join(f.root, 'operations'))).toEqual(before);
});
test.each(['load', 'inspection', 'host', 'record'] as const)('actual T27 doctor blocks current Vault replacement at %s handoff', async (stage) => {
  const f = fixture(); const root = join(f.root, 'mutable-vault'); mkdirSync(root);
  const db = openDatabase(join(f.root, 'mutable-vault.sqlite')); cleanup.push(() => db.close());
  await connectVault(db, { deviceId: 'device', vaultId: 'vault', captureHost: hostname(), now: new Date().toISOString(), root, accountId: 'owner', domain: 'personal' });
  await confirmVault(db, 'device', 'vault', new Date().toISOString());
  const options = { deviceId: 'device', captureHost: hostname(), serviceUid: process.geteuid!(), editorUid: process.geteuid!(), stageParent: f.root,
    loadVault: (vaultId: string) => requireVault(db, vaultId), inspectVault: (deviceId: string, vaultId: string) => inspectVault(db, deviceId, vaultId),
    inspectObsidian: createObsidianInspector({ localDeviceId: 'device', lockedVersion: null, installerHash: null, readMacState: async () => ({ application: null }) }), syncMode: 'single_device' as const };
  await createVaultKitInstaller(options).installVaultKit('vault');
  const record = requireVault(db, 'vault');
  const registration = { identity: { ...f.host.identity }, configRevision: record.config_revision, scopeHash: record.scope_hash, options };
  const host = { ...f.host, vaults: { vault: registration } }; let mutated = false;
  const replace = () => { if (!mutated) { mutated = true; host.vaults.vault = { ...registration }; } };
  if (stage === 'record') {
    let loads = 0;
    options.loadVault = (vaultId) => {
      if (++loads === 2) db.prepare("UPDATE vaults SET account_id='other' WHERE vault_id=?").run(vaultId);
      return requireVault(db, vaultId);
    };
  } else if (stage === 'load') options.loadVault = (vaultId) => { const value = requireVault(db, vaultId); replace(); return value; };
  else options.inspectObsidian = async (deviceId) => {
    if (stage === 'host') host.identity = { ...host.identity, configRevision: '2' }; else replace();
    return createObsidianInspector({ localDeviceId: 'device', lockedVersion: null, installerHash: null, readMacState: async () => ({ application: null }) })(deviceId);
  };
  const result = await createPatrickCli(host).run(['doctor', '--vault', 'vault']);
  expect(result.checks?.vault).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
  expect(result.checks?.vault_sync.status).toBe('blocked');
});

test('doctor invalidates earlier ready service evidence when a later probe replaces its registration', async () => {
  const f = fixture();
  const host = { ...f.host, readiness: {
    service: { identity: { ...f.host.identity }, inspect: async () => ({ liveness: 'ready' as const, readiness: 'ready' as const }) },
    executor: { identity: { ...f.host.identity }, inspect: async () => {
      host.readiness.service = { ...host.readiness.service };
      return { capability: 'ready' as const };
    } },
  } };
  const result = await createPatrickCli(host).run(['doctor']);
  expect(result.checks?.service).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
  expect(result.checks?.executor.status).toBe('ready');
});
test('actual release verification refuses current release registration replacement across staging await', async () => {
  const f = fixture(); const candidate = candidateFixture(f);
  const host = { ...f.host, releases: { candidate: candidate.release } };
  const original = candidate.release.staging.withExclusiveReadRoot;
  candidate.release.staging.withExclusiveReadRoot = async (read) => {
    const result = await original(read);
    host.releases.candidate = { ...candidate.release };
    return result;
  };
  expect(await createPatrickCli(host).run(['install', '--release', 'candidate'])).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
});
test('actual Vault-kit adapter refuses current registration replacement after awaited load before writing', async () => {
  const f = fixture(); const root = join(f.root, 'kit-vault'); mkdirSync(root);
  const db = openDatabase(join(f.root, 'kit-vault.sqlite')); cleanup.push(() => db.close());
  await connectVault(db, { deviceId: 'device', vaultId: 'vault', captureHost: hostname(), now: new Date().toISOString(), root, accountId: 'owner', domain: 'personal' });
  await confirmVault(db, 'device', 'vault', new Date().toISOString());
  const record = requireVault(db, 'vault');
  const options = { deviceId: 'device', captureHost: hostname(), serviceUid: process.geteuid!(), editorUid: process.geteuid!(), stageParent: f.root,
    loadVault: async (vaultId: string) => { const vault = requireVault(db, vaultId); host.vaults.vault = { ...host.vaults.vault }; return vault; },
    inspectVault: (deviceId: string, vaultId: string) => inspectVault(db, deviceId, vaultId),
    inspectObsidian: createObsidianInspector({ localDeviceId: 'device', lockedVersion: null, installerHash: null, readMacState: async () => ({ application: null }) }) };
  const host = { ...f.host, vaults: { vault: { identity: f.host.identity, configRevision: record.config_revision, scopeHash: record.scope_hash, options, installer: options } } };
  const { createVaultKitAdapter } = await import('../../deploy/cli/patrick.mjs');
  await expect(createVaultKitAdapter(host).install('vault')).rejects.toThrow('HOST_IDENTITY_MISMATCH');
  expect(readdirSync(root)).toEqual([]);
});

test('actual restore bind rejects selection replacement during awaited manifest authority verification', async () => {
  const f = fixture(); const backup = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'backup']);
  const authority = f.target.drill.authority; let changed = false;
  f.target.drill.authority = { ...authority, async verify(bytes, signature, keyId) {
    const valid = await authority.verify(bytes, signature, keyId);
    if (!changed) {
      changed = true;
      f.host.recovery.targets.target = { ...f.target, identity: { ...f.target.identity, configRevision: '2' } };
    }
    return valid;
  } };
  const result = await f.cli().run(['restore', '--target', 'target', '--manifest', backup.manifestHash!, '--execute', '--operation', 'drill-bind']);
  expect(result).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(changed).toBe(true); expect(f.captures()).toBe(1);
  expect(readdirSync(join(f.root, 'isolated'))).toEqual([]);
  expect(readdirSync(join(f.root, 'operations'))).not.toContain('drill-bind.reservation.json');
});

function expectBoundaryResult(result: Awaited<ReturnType<ReturnType<typeof createPatrickCli>['run']>>) {
  expect(Number.isInteger(result.exitCode) && result.exitCode > 0).toBe(true);
  const json = JSON.stringify(result);
  expect(json.length).toBeLessThan(32768);
  expect(JSON.parse(json)).toEqual(result);
  expect(json).not.toContain('SECRET');
}
test.each(['preview', 'execute', 'readback'] as const)('init boundary resolves a partial doctor report after early drift during %s', async (action) => {
  const f = fixture(); const args = ['init', '--vault', 'vault', `--${action}`, ...(action === 'preview' ? [] : ['--operation', 'init'])];
  const pending = f.cli().run(args);
  queueMicrotask(() => { f.host.identity = { ...f.host.identity, configRevision: '2' }; });
  const result = await pending;
  expectBoundaryResult(result);
  expect(result).toMatchObject({ command: 'init', status: 'blocked', code: 'VAULT_INITIALIZATION_BLOCKED', exitCode: 5 });
  expect(result.checks?.binding).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
  expect(result.checks?.vault).toBeUndefined();
  expect(f.captures()).toBe(0);
});
test.each(['init', 'doctor', 'install', 'start', 'stop', 'backup', 'restore', 'upgrade', 'uninstall'])('public %s boundary resolves host capture refusal without invoking its accessor', async (command) => {
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.host.runtime, 'refused', { enumerable: true, get() { calls++; throw new Error('SECRET capture accessor'); } });
  const result = await f.cli().run([command]);
  expectBoundaryResult(result);
  expect(result).toMatchObject({ command, status: 'blocked', code: 'HOST_IDENTITY_MISMATCH', exitCode: 5 });
  expect(calls).toBe(0); expect(f.captures()).toBe(0);
});
test.each(['backup', 'restore'])('public %s boundary resolves selected recovery capture refusal without invoking its accessor', async (command) => {
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.target.backup.scope, 'refused', { enumerable: true, get() { calls++; throw new Error('SECRET recovery accessor'); } });
  const result = await f.cli().run([command, '--target', 'target', '--execute', '--operation', 'refused', ...(command === 'restore' ? ['--manifest', '0'.repeat(64)] : [])]);
  expectBoundaryResult(result);
  expect(result).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(calls).toBe(0); expect(f.captures()).toBe(0);
  expect(readdirSync(join(f.root, 'operations'))).toEqual([]);
});
test.each(['install', 'upgrade'])('public %s boundary resolves selected release capture refusal without invoking its accessor', async (command) => {
  const f = fixture(); const candidate = candidateFixture(f); let calls = 0;
  Object.defineProperty(candidate.release.expected, 'refused', { enumerable: true, get() { calls++; throw new Error('SECRET release accessor'); } });
  const host = { ...f.host, releases: { candidate: candidate.release } };
  const result = await createPatrickCli(host).run([command, '--release', 'candidate']);
  expectBoundaryResult(result);
  expect(result).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(calls).toBe(0); expect(candidate.reads()).toBe(0);
});
test('doctor boundary resolves component capture refusal without invoking its accessor', async () => {
  const f = fixture(); let calls = 0;
  const registration = { identity: f.host.identity };
  Object.defineProperty(registration, 'refused', { enumerable: true, get() { calls++; throw new Error('SECRET doctor accessor'); } });
  const host = { ...f.host, readiness: { service: registration as never } };
  const result = await createPatrickCli(host).run(['doctor']);
  expectBoundaryResult(result);
  expect(result).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(calls).toBe(0);
});
test('recovery boundary preserves a signed uncertain claim when live configuration gains a refused accessor', async () => {
  const f = fixture(); let calls = 0;
  f.host.runtime.createRecoveryOperations = (options) => {
    const actual = createRecoveryOperations(options);
    return { ...actual, run(request, beforeInvoke) { return actual.run(request, () => {
      Object.defineProperty(f.target.backup.options, 'refused', { configurable: true, enumerable: true, get() { calls++; throw new Error('SECRET claimed accessor'); } });
      beforeInvoke?.();
    }); } };
  };
  const args = ['backup', '--target', 'target', '--execute', '--operation', 'claim'];
  const result = await f.cli().run(args);
  expectBoundaryResult(result);
  expect(result).toMatchObject({ status: 'uncertain', code: 'HOST_IDENTITY_MISMATCH', exitCode: 4 });
  expect(calls).toBe(0); expect(f.captures()).toBe(0);
  expect(readdirSync(join(f.root, 'operations'))).toContain('claim.claim.json');
  const refused = await f.cli().run(args);
  expectBoundaryResult(refused);
  expect(refused).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expect(calls).toBe(0);
  Reflect.deleteProperty(f.target.backup.options, 'refused');
  expect(await f.cli().run(['backup', '--target', 'target', '--readback', '--operation', 'claim'])).toMatchObject({ status: 'uncertain', exitCode: 4 });
  expect(f.captures()).toBe(0);
});

import { doctor } from '../../deploy/lib/doctor.mjs';
function identityMetadata(f: ReturnType<typeof fixture>) {
  const expected = structuredClone(f.host.identity);
  const enriched = { ...f.host.identity, credential: 'SECRET_SYNTHETIC_CREDENTIAL', debugRoot: '/private/synthetic-registration-root',
    diagnostic: { nested: [{ oversized: 'x'.repeat(1024 * 1024), credential: 'SECRET_NESTED_CREDENTIAL' }] } };
  f.host.identity = enriched;
  f.target.identity = { ...enriched };
  return { expected, enriched };
}
function expectIdentityRedaction(result: { identity?: unknown }, expected: ReturnType<typeof fixture>['host']['identity']) {
  expect(Object.keys(result.identity ?? {}).sort()).toEqual(['accountId', 'configRevision', 'deviceId', 'domains', 'scopeId']);
  const json = JSON.stringify(result);
  expect(json.length).toBeLessThan(32768);
  expect(json).not.toContain('SECRET');
  expect(json).not.toContain('/private/synthetic-registration-root');
  expect(json).not.toContain('oversized');
  expect(result.identity).toEqual(expected);
}
test.each(['init', 'doctor', 'install', 'start', 'stop', 'backup', 'restore', 'upgrade', 'uninstall'])('public %s redaction exposes only finite identity fields with sensitive and oversized extra metadata', async (command) => {
  const f = fixture(); const { expected } = identityMetadata(f);
  const candidate = candidateFixture(f);
  const host = { ...f.host, releases: { candidate: candidate.release } };
  const args = command === 'backup' ? ['backup', '--target', 'target'] : command === 'restore' ? ['restore', '--target', 'target', '--manifest', '0'.repeat(64)]
    : command === 'install' || command === 'upgrade' ? [command, '--release', 'candidate'] : [command];
  const result = await createPatrickCli(host).run(args);
  expect(['preview', 'blocked', 'unavailable']).toContain(result.status);
  expectIdentityRedaction(result, expected);
});
test.each(['normal', 'early-drift'] as const)('direct doctor redaction bounds identity on its %s report', async (mode) => {
  const f = fixture(); const { expected } = identityMetadata(f);
  const pending = doctor(f.host);
  if (mode === 'early-drift') queueMicrotask(() => { f.host.identity = { ...f.host.identity, configRevision: '2' }; });
  const report = await pending;
  expectIdentityRedaction(report, expected);
  if (mode === 'early-drift') expect(report.checks.binding).toMatchObject({ status: 'blocked', evidence: { code: 'HOST_IDENTITY_MISMATCH' } });
});
test.each(['completed', 'uncertain'] as const)('actual signed recovery %s redaction preserves binding and replay with extra identity metadata', async (status) => {
  const f = fixture(); const { expected } = identityMetadata(f);
  if (status === 'uncertain') f.interrupt();
  const args = ['backup', '--target', 'target', '--execute', '--operation', 'redaction'];
  const result = await f.cli().run(args);
  expect(result.status).toBe(status); expectIdentityRedaction(result, expected);
  const signed = JSON.parse(readFileSync(join(f.root, 'operations/redaction.reservation.json'), 'utf8'));
  expect(signed.payload.binding.configuration.identity.credential).toBe('SECRET_SYNTHETIC_CREDENTIAL');
  const repeated = await f.cli().run(args);
  expect(repeated).toEqual(result); expectIdentityRedaction(repeated, expected); expect(f.captures()).toBe(1);
});
test('identity redaction retains live metadata mutation guards before actual recovery effects', async () => {
  const f = fixture(); const { expected, enriched } = identityMetadata(f);
  f.host.runtime.createRecoveryOperations = (options) => {
    const actual = createRecoveryOperations(options);
    return { ...actual, async read(request) { const result = await actual.read(request); enriched.debugRoot = '/private/changed-registration-root'; return result; } };
  };
  const result = await f.cli().run(['backup', '--target', 'target', '--execute', '--operation', 'redaction-drift']);
  expect(result).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
  expectIdentityRedaction(result, expected); expect(f.captures()).toBe(0);
  expect(readdirSync(join(f.root, 'operations'))).toEqual([]);
});
