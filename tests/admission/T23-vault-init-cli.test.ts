import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { closeSync, cpSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, existsSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { createInstalledCli } from '../../deploy/runtime/cli.js';
import { createRuntimeProvisioning } from '../../deploy/runtime/composition.js';
import { createVaultInitController, vaultInitApproval } from '../../deploy/runtime/vault-init.js';
import { createLifecycleJournal, type LifecycleRegistration, type LifecycleRequest } from '../../deploy/runtime/lifecycle-journal.js';
import type { VaultInitCliEntry } from '../../deploy/runtime/vault-init-cli.js';
import type { RegisteredHost } from '../../deploy/lib/doctor.mjs';
import { createVaultKitInstaller } from '../../deploy/obsidian/install.mjs';
import { deriveRuntimeStaging, leased } from '../../deploy/lib/emitted-release.mjs';
import { readRecoveryDatabase } from '../../packages/host/src/recovery/backup.js';
import { connectVault, confirmVault, inspectVault, requireVault } from '../../packages/integrations/vault/connection.js';
import { openDatabase } from '../../packages/storage/src/database.js';

const after: Array<() => void> = [];
afterEach(() => after.splice(0).forEach(fn => fn()));
const now = '2026-11-18T12:00:00.000Z';
test('source CLI still runs directly without importing the installed TypeScript graph', () => {
  const entry = fileURLToPath(new URL('../../deploy/cli/patrick.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, 'doctor'], { encoding: 'utf8' });
  expect(result.status).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({ command: 'doctor', code: 'HOST_REGISTRATION_REQUIRED' });
});
test('installed composition exposes the fixed preflight and approval contract to its trusted owner', async () => {
  const composition = await import('../../deploy/runtime/composition.js');
  expect(composition).toHaveProperty('createVaultInitController');
  expect(composition).toHaveProperty('vaultInitApproval');
});
test('unrelated legacy Vault registrations keep accessor-backed identity and map support', async () => {
  const f = await fixture();
  const target = f.caps.vaults![f.e.vault.vault_id]!;
  class ExistingVaultRegistration {
    get identity() { return target.identity; }
  }
  const existing = Object.assign(new ExistingVaultRegistration(), {
    configRevision: target.configRevision, scopeHash: target.scopeHash, options: target.options, installer: target.installer,
  });
  let mapReads = 0;
  const capabilities = Object.defineProperty({}, 'vaults', { enumerable: true, get() {
    mapReads++;
    return { [f.e.vault.vault_id]: existing };
  } });
  expect(() => createInstalledCli(f.provision(capabilities))).not.toThrow();
  expect(mapReads).toBeGreaterThan(0);
});
function rootAt(path: string) {
  const stat = lstatSync(path);
  return { path, device: stat.dev, inode: stat.ino };
}
async function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 't23-init-cli-'));
  const child = (name: string) => { const path = join(dir, name); mkdirSync(path, { mode: 0o700 }); return path; };
  const root = child('vault');
  const journal = child('journal');
  const staging = child('staging');
  const assets = join(dir, 'assets');
  cpSync(fileURLToPath(new URL('../../assets/vault-kit', import.meta.url)), assets, { recursive: true });
  const db = openDatabase(join(dir, 'source.sqlite'));
  const vaultId = 'test-vault', captureHost = hostname(), deviceId = 'device', accountId = 'owner';
  await connectVault(db, { deviceId, vaultId, captureHost, now, root, accountId, domain: 'fixture' });
  await confirmVault(db, deviceId, vaultId, now);
  const vault = requireVault(db, vaultId);
  const uid = process.geteuid!();
  const journalKey = generateKeyPairSync('ed25519');
  const approval = generateKeyPairSync('ed25519');
  const pub = (key: typeof approval) => key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const identity = { accountId, scopeId: 'scope', deviceId, domains: ['fixture'], configRevision: 'revision-1' };
  const e = { identity, installationId: 'install', operationId: 'init-1', captureHost, serviceUid: uid, editorUid: uid,
    vault, mappingRevision: 1, owner: rootAt(dir), journal: rootAt(journal), assets: rootAt(assets), stage: rootAt(staging),
    kitVersion: '1.0.0', kitSha256: createHash('sha256').update(readFileSync(join(assets, 'manifest.json'))).digest('hex'),
    journalKeyId: 'journal', journalPublicKey: pub(journalKey), approvalPublicKey: pub(approval) };
  const hooks: { after?: () => void; signing?: () => void; read?: () => void; verifyReceiver?: boolean } = {};
  let sourceReads = 0;
  const signer = { async sign(bytes: Uint8Array) { if (hooks.verifyReceiver) expect(this).toBe(signer); hooks.signing?.(); return sign(null, bytes, journalKey.privateKey).toString('base64'); } };
  const options = { assetRoot: assets, stageParent: staging, deviceId, captureHost, serviceUid: uid, editorUid: uid,
    loadVault(id: string) { sourceReads++; if (hooks.verifyReceiver) expect(this).toBe(options); hooks.read?.(); return requireVault(db, id); },
    inspectVault(device: string, id: string) { sourceReads++; if (hooks.verifyReceiver) expect(this).toBe(options); return inspectVault(db, device, id); } };
  const host = { identity, captureHost, serviceUid: uid, minimumFreeBytes: 1, dataRoot: dir, profile: 'test',
    runtime: { createVaultKitInstaller }, vaults: { [vaultId]: { identity, configRevision: vault.config_revision, scopeHash: vault.scope_hash,
      installer: options, options: { ...options, async inspectObsidian(): Promise<never> { throw Error('unexpected application probe'); } } } } };
  const human = Buffer.from([0xef, 0xbb, 0xbf, 35, 32, 65, 13, 10]);
  mkdirSync(join(root, '模板')); writeFileSync(join(root, '模板/知识笔记.md'), human);
  const lock = join(dir, 'fixture.lock');
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
    if (hooks.verifyReceiver) expect(this).toBe(owner);
    const handle = openSync(lock, 'wx', 0o600);
    try { const result = await read(dir); hooks.after?.(); return result; }
    finally { closeSync(handle); unlinkSync(lock); }
  } };
  const plan = await createVaultInitController(() => e, owner, host, signer).preview();
  const approved: VaultInitCliEntry = { format: 'patrick-installed-vault-init-v1', mode: 'approved', enrollment: e,
    owner, signer, plan, approval: sign(null, vaultInitApproval(plan), approval.privateKey).toString('base64') };
  const registry: Record<string, VaultInitCliEntry> = { [e.operationId]: approved };
  const caps: Pick<RegisteredHost, 'vaultInitOperations' | 'vaults' | 'lifecycleReadbacks'> = { vaultInitOperations: registry, vaults: host.vaults };
  const hub = openDatabase(join(dir, 'hub.sqlite'));
  const recoveryAuthority = { ...signer, keyId: 'fixture', async verify() { return false; } };
  const backup = { root: dir, databases: { service: db, hub }, authority: recoveryAuthority, readDatabase: readRecoveryDatabase,
    freeze: { async acquire(): Promise<never> { throw Error('unexpected recovery'); } } };
  const recovery = { root: journal, authority: recoveryAuthority, targets: { backup: { identity,
    backup: { options: backup, scope: { setId: 'set', domains: [], resources: [], versionLocks: {} } } } } };
  const provision = (capabilities = caps, withRecovery = false) => createRuntimeProvisioning({
    registration: { identity, captureHost, serviceUid: uid, profile: 'test', minimumFreeBytes: 1, dataRoot: dir,
      origin: 'http://localhost', rpId: 'localhost', listener: { host: '127.0.0.1', port: 0, origin: 'http://localhost' } },
    hostCapabilities: withRecovery ? Object.assign(capabilities, { recovery }) : capabilities,
    operationalRecoveryHub: withRecovery ? { identity, database: hub, physicalPath: join(dir, 'hub.sqlite'), readDatabase: readRecoveryDatabase } : undefined,
    service: { databasePath: join(dir, 'source.sqlite'), credentialDirectory: dir,
      recoveryRuntime: { attach() { throw Error('unexpected startup'); } }, bindRecoveryOperations() { throw Error('unexpected backup'); } },
  });
  const cli = createInstalledCli(provision());
  const args = (action: string) => ['init', '--vault', vaultId, '--operation', e.operationId, '--' + action];
  after.push(() => { if (db.open) db.close(); if (hub.open) hub.close(); rmSync(dir, { recursive: true }); });
  return { dir, root, journal, db, hub, reads: () => sourceReads, e, plan, approved, registry, caps, provision, cli, args, signer, human, owner, hooks, lock };

}
test('installed preview projects the exact independently retained synthetic plan without creating records', async () => {
  const f = await fixture();
  const result = await f.cli.run(f.args('preview'));
  expect(result).toMatchObject({ status: 'preview', code: 'VAULT_INIT_KIT_PREVIEW',
    vaultInitPreview: { phase: 'vault-kit', operationId: f.e.operationId, vaultId: f.e.vault.vault_id,
      kitVersion: f.e.kitVersion, manifestSha256: f.e.kitSha256, planSha256: JSON.parse(vaultInitApproval(f.plan).toString()).planSha256 } });
  expect(readdirSync(f.journal)).toEqual([]);
  expect(readdirSync(f.root)).toEqual(['模板']);
});

test('installed Vault preview, execution and cold readback retain a genuine recursive derived owner', async () => {
  const f = await fixture();
  expect(await f.cli.run(f.args('preview'))).toMatchObject({ status: 'preview' });
  let expired!: typeof f.owner;
  await leased(f.owner, async parent => {
    const child = deriveRuntimeStaging(parent, f.dir);
    expired = child;
    const directHost = { identity: f.e.identity, captureHost: f.e.captureHost, serviceUid: f.e.serviceUid,
      minimumFreeBytes: 1, dataRoot: f.dir, profile: 'test', runtime: { createVaultKitInstaller }, vaults: f.caps.vaults } as unknown as RegisteredHost;
    expect(await createVaultInitController(() => f.e, child, directHost, f.signer).preview()).toEqual(f.plan);
    f.approved.owner = child;
    expect(await f.cli.run(f.args('preview'))).toMatchObject({ status: 'preview', code: 'VAULT_INIT_KIT_PREVIEW' });
    expect(await f.cli.run(f.args('execute'))).toMatchObject({ status: 'completed', code: 'LIFECYCLE_COMPLETED' });
    await leased(child, async nested => {
      f.approved.owner = deriveRuntimeStaging(nested, f.dir);
      expect(await f.cli.run(f.args('readback'))).toMatchObject({ status: 'completed', code: 'LIFECYCLE_COMPLETED' });
    }, true);
    f.approved.owner = { withExclusiveReadRoot: child.withExclusiveReadRoot };
    expect((await f.cli.run(f.args('readback'))).status).toBe('blocked');
    f.approved.owner = deriveRuntimeStaging(parent, f.root);
    expect((await f.cli.run(f.args('readback'))).status).toBe('blocked');
  }, true);
  f.approved.owner = expired;
  expect((await f.cli.run(f.args('readback'))).status).toBe('blocked');
  expect(readFileSync(join(f.root, '模板/知识笔记.md'))).toEqual(f.human);
}, 120_000);

test('an installed signer getter drift after actual Vault publication stays uncertain', async () => {
  const f = await fixture();
  const original = f.signer.sign;
  let getters = 0, changed = false;
  f.hooks.read = () => {
    if (!changed && existsSync(join(f.root, '模板/判断案例.md'))) {
      changed = true;
      Object.defineProperty(f.signer, 'sign', { configurable: true, get() { getters++; return original; } });
    }
  };
  const result = await f.cli.run(f.args('execute'));
  expect(changed).toBe(true);
  expect(result.status).toBe('uncertain');
  expect(getters).toBe(0);
  expect(existsSync(join(f.root, '模板/判断案例.md'))).toBe(true);
  expect(await f.cli.run(f.args('readback'))).toMatchObject({ status: 'uncertain' });
  expect(getters).toBe(0);
}, 120_000);

test('installed Vault preview stops source inspection after its derived parent exits', async () => {
  const f = await fixture();
  const installer = f.caps.vaults![f.e.vault.vault_id]!.installer!;
  const load = installer.loadVault, inspect = installer.inspectVault;
  let start!: () => void, resume!: () => void, armed = false, released = false, lateInspections = 0;
  const entered = new Promise<void>(resolve => { start = resolve; });
  const continuing = new Promise<void>(resolve => { resume = resolve; });
  installer.loadVault = async function(id: string) {
    const record = await Reflect.apply(load, installer, [id]);
    if (!armed) { armed = true; start(); await continuing; }
    return record;
  };
  installer.inspectVault = async function(device: string, id: string) {
    if (released) lateInspections++;
    return Reflect.apply(inspect, installer, [device, id]);
  };
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
    const pending = read(f.dir); pending.catch(() => {});
    const enteredBeforeExit = await Promise.race([entered.then(() => true), pending.then(() => false, () => false)]);
    if (!enteredBeforeExit) return pending;
    released = true; setImmediate(resume);
    return undefined as T;
  } };
  let status: string | undefined;
  await leased(owner, async parent => {
    f.approved.owner = deriveRuntimeStaging(parent, f.dir);
    status = (await f.cli.run(f.args('preview'))).status;
  }, true).catch(() => {});
  expect(armed).toBe(true);
  expect(released).toBe(true);
  expect(status).toBe('blocked');
  expect(lateInspections).toBe(0);
  expect(readdirSync(f.journal)).toEqual([]);
}, 120_000);

test('preserves class-backed staging, signer and Vault-port receivers without reading function metadata', async () => {
  const f = await fixture();
  const original = f.caps.vaults![f.e.vault.vault_id]!.installer!;
  const { loadVault, inspectVault, ...fields } = original;
  const metadataReads: string[] = [];
  class Owner {
    #original = f.owner;
    async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return this.#original.withExclusiveReadRoot(read); }
  }
  class Signer {
    #original = f.signer;
    async sign(bytes: Uint8Array) { return this.#original.sign(bytes); }
  }
  class Installer {
    #original = original;
    async loadVault(id: string) { return Reflect.apply(loadVault, this.#original, [id]); }
    async inspectVault(device: string, id: string) { return Reflect.apply(inspectVault, this.#original, [device, id]); }
  }
  for (const method of [Owner.prototype.withExclusiveReadRoot, Signer.prototype.sign, Installer.prototype.loadVault, Installer.prototype.inspectVault]) {
    for (const name of ['bind', 'call', 'name', 'length']) Object.defineProperty(method, name, { configurable: true, get() {
      metadataReads.push(name);
      throw Error('unexpected method metadata access');
    } });
  }
  f.approved.owner = new Owner();
  f.approved.signer = new Signer();
  f.caps.vaults![f.e.vault.vault_id]!.installer = Object.assign(new Installer(), fields);
  expect(await f.cli.run(f.args('preview'))).toMatchObject({ status: 'preview' });
  expect(await f.cli.run(f.args('execute'))).toMatchObject({ status: 'completed' });
  expect(metadataReads).toEqual([]);
});

test('executes with original receivers, then reads signed completion in a public-only installation after retiring SQLite', async () => {
  const f = await fixture(), id = f.e.operationId;
  f.hooks.verifyReceiver = true;
  const staleToken = f.provision(f.caps, true);
  const live = createInstalledCli(staleToken);
  expect(await live.run(f.args('readback'))).toMatchObject({ status: 'absent', exitCode: 6 });
  const result = await live.run(f.args('execute'));
  expect(result).toMatchObject({ status: 'completed', code: 'LIFECYCLE_COMPLETED', lifecycleReceipt: { evidenceId: 'installed-vault-kit' } });
  const count = f.reads();
  expect(await live.run(f.args('execute'))).toEqual(result);
  expect(f.reads()).toBe(count);
  expect(readFileSync(join(f.root, '模板/知识笔记.md'))).toEqual(f.human);
  for (const privateValue of [f.dir, f.approved.approval, f.e.journalPublicKey, 'directories', 'signer', 'source.sqlite']) {
    expect(JSON.stringify(result)).not.toContain(privateValue);
  }
  f.db.close(); f.hub.close();
  renameSync(join(f.dir, 'source.sqlite'), join(f.dir, 'retired-source.sqlite'));
  expect(await live.run(f.args('execute'))).toMatchObject({ code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
  expect(await createInstalledCli(staleToken).run(f.args('readback'))).toMatchObject({ status: 'completed', lifecycleReceipt: result.lifecycleReceipt });
  const cold: VaultInitCliEntry = { format: f.approved.format, mode: 'readback', enrollment: f.e, owner: f.owner, plan: f.plan };
  const publicCli = createInstalledCli(f.provision({ vaultInitOperations: { [id]: cold } }));
  expect(await publicCli.run(f.args('readback'))).toMatchObject({ lifecycleReceipt: result.lifecycleReceipt });
  expect(await publicCli.run(f.args('execute'))).toMatchObject({ status: 'unavailable' });
  expect(f.reads()).toBe(count);
  expect(existsSync(join(f.dir, 'source.sqlite'))).toBe(false);
  writeFileSync(join(f.root, '模板/判断案例.md'), 'later edit');
  expect(await publicCli.run(f.args('readback'))).toMatchObject({ status: 'blocked', code: 'LIFECYCLE_READBACK_FAILED' });
});

test('reads an interrupted claimed installation without invoking T06 or the native installer again', async () => {
  const f = await fixture();
  f.hooks.read = () => { if (existsSync(join(f.root, '模板/判断案例.md'))) throw Error('lost after actual file'); };
  expect(await f.cli.run(f.args('execute'))).toMatchObject({ status: 'uncertain', exitCode: 4 });
  const count = f.reads();
  for (const action of ['readback', 'execute']) expect(await f.cli.run(f.args(action))).toMatchObject({ status: 'uncertain' });
  expect(f.reads()).toBe(count);
  expect(readdirSync(f.journal).sort()).toEqual(['lifecycle-v1.init-1.claim.json', 'lifecycle-v1.init-1.reservation.json']);
  expect(existsSync(join(f.root, '模板/标准修订.md'))).toBe(false);
});

test('reconstructs exact public readback after the live Vault registry becomes inaccessible', async () => {
  const f = await fixture();
  const provisioning = f.provision(f.caps, true);
  const installed = createInstalledCli(provisioning);
  expect(await installed.run(f.args('execute'))).toMatchObject({ status: 'completed' });
  const before = f.reads();
  f.db.close(); f.hub.close();
  let attemptedReads = 0;
  Object.defineProperty(f.caps, 'vaults', { configurable: true, enumerable: true, get() {
    attemptedReads++;
    throw Error('retired live Vault registration');
  } });
  const recovered = createInstalledCli(provisioning);
  expect(await recovered.run(f.args('readback'))).toMatchObject({ status: 'completed' });
  expect(attemptedReads).toBe(0);
  expect(f.reads()).toBe(before);
});

test('typed modes, wrong targets, bad approvals and stale retained plans leave the journal empty', async () => {
  const f = await fixture(), id = f.e.operationId;
  const run = (action: string) => f.cli.run(f.args(action));
  f.registry[id] = { mode: 'preview', format: f.approved.format, enrollment: f.e, signer: f.signer, owner: f.owner };
  expect(await run('preview')).toMatchObject({ status: 'preview' });
  expect(await run('execute')).toMatchObject({ status: 'unavailable' });
  expect(await run('readback')).toMatchObject({ status: 'unavailable' });
  f.registry[id] = { ...f.approved, approval: 'forged' };
  expect(await run('execute')).toMatchObject({ status: 'blocked' });
  f.registry[id] = f.approved;
  expect(await f.cli.run(['init','--execute','--operation',id,'--vault','other'])).toMatchObject({ status: 'blocked' });
  expect(await f.cli.run(['init','--execute','--operation','missing','--vault',f.e.vault.vault_id])).toMatchObject({ status: 'unavailable' });
  Object.assign(f.caps, { lifecycleReadbacks: { [id]: {} } });
  expect(await run('readback')).toMatchObject({ status: 'blocked' });
  delete f.caps.lifecycleReadbacks;
  writeFileSync(join(f.root, '模板/知识笔记.md'), 'owner edit after preflight');
  expect(await run('preview')).toMatchObject({ status: 'blocked' });
  expect(await run('execute')).toMatchObject({ status: 'blocked' });
  expect(readdirSync(f.journal)).toEqual([]);
});

test.each(['map', 'target', 'approval', 'entry', 'signer method'] as const)('withdraws a changed %s inside the original signer before publication', async kind => {
  const f = await fixture();
  f.hooks.signing = () => {
    if (kind === 'map') f.caps.vaultInitOperations = { ...f.registry };
    if (kind === 'target') f.caps.vaults = { ...f.caps.vaults };
    if (kind === 'entry') f.registry[f.e.operationId] = { ...f.approved };
    if (kind === 'approval') f.approved.approval = 'substituted';
    if (kind === 'signer method') f.signer.sign = async () => 'invalid';
  };
  expect(await f.cli.run(f.args('execute'))).toMatchObject({ status: 'blocked' });
  expect(readdirSync(f.journal)).toEqual([]);
  expect(readdirSync(f.root)).toEqual(['模板']);
});

test.each(['asset root', 'load method', 'inspect method'] as const)('refuses a changed class-backed Vault %s before claiming', async kind => {
  const f = await fixture();
  const target = f.caps.vaults![f.e.vault.vault_id]!;
  const original = target.installer!;
  const { loadVault, inspectVault, ...fields } = original;
  class Installer {
    #source = original;
    async loadVault(id: string) { return Reflect.apply(loadVault, this.#source, [id]); }
    async inspectVault(device: string, id: string) { return Reflect.apply(inspectVault, this.#source, [device, id]); }
  }
  const installer = Object.assign(new Installer(), fields);
  target.installer = installer;
  f.hooks.signing = () => {
    if (kind === 'asset root') installer.assetRoot = f.dir;
    if (kind === 'load method') installer.loadVault = async () => { throw Error('replacement must not be called'); };
    if (kind === 'inspect method') installer.inspectVault = async () => { throw Error('replacement must not be called'); };
  };
  expect(await f.cli.run(f.args('execute'))).toMatchObject({ status: 'blocked' });
  expect(readdirSync(f.journal)).toEqual([]);
  expect(readdirSync(f.root)).toEqual(['模板']);
});

test.each(['installer', 'identity', 'identity field', 'domain', 'revision', 'scope'] as const)(
  'rejects class-backed Vault row %s drift before reservation publication', async kind => {
    const f = await fixture(), id = f.e.vault.vault_id;
    class Target {}
    class Identity {}
    const target = Object.assign(new Target(), f.caps.vaults![id]!);
    target.identity = Object.assign(new Identity(), target.identity, { domains: [...target.identity.domains] });
    f.caps.vaults![id] = target;
    const installer = target.installer!;
    let calls = 0;
    f.hooks.signing = () => {
      calls++;
      if (kind === 'installer') target.installer = { ...installer };
      if (kind === 'identity') target.identity = { ...target.identity, scopeId: 'withdrawn' };
      if (kind === 'identity field') target.identity.scopeId = 'withdrawn';
      if (kind === 'domain') target.identity.domains[0] = 'withdrawn';
      if (kind === 'revision') target.configRevision++;
      if (kind === 'scope') target.scopeHash = 'withdrawn';
    };
    expect(await f.cli.run(f.args('execute'))).toMatchObject({ status: 'blocked' });
    expect(calls).toBeGreaterThan(0);
    expect(readdirSync(f.journal)).toEqual([]);
    expect(readdirSync(f.root)).toEqual(['模板']);
  },
);

test('keeps class-backed Vault row replacement uncertain after the first native publication without replay', async () => {
  const f = await fixture(), id = f.e.vault.vault_id;
  class Target {}
  const target = Object.assign(new Target(), f.caps.vaults![id]!);
  f.caps.vaults![id] = target;
  const installer = target.installer!;
  let changed = false;
  f.hooks.read = () => {
    if (!changed && existsSync(join(f.root, '模板/判断案例.md'))) {
      changed = true;
      target.installer = { ...installer };
    }
  };
  const result = await f.cli.run(f.args('execute'));
  expect(changed).toBe(true);
  expect(result).toMatchObject({ status: 'uncertain', code: 'LIFECYCLE_OUTCOME_UNCERTAIN' });
  expect(result.lifecycleReceipt).toBeUndefined();
  expect(readdirSync(f.journal).sort()).toEqual(['lifecycle-v1.init-1.claim.json', 'lifecycle-v1.init-1.reservation.json']);
  delete f.hooks.read;
  target.installer = installer;
  const count = f.reads();
  expect(await f.cli.run(f.args('execute'))).toMatchObject({ status: 'uncertain' });
  expect(await f.cli.run(f.args('readback'))).toMatchObject({ status: 'uncertain' });
  expect(f.reads()).toBe(count);
});

test('rejects unrelated enumerable class-row accessors without calling them', async () => {
  const f = await fixture(), id = f.e.vault.vault_id;
  class Target {}
  const target = Object.assign(new Target(), f.caps.vaults![id]!);
  let calls = 0;
  Object.defineProperty(target, 'unrelated', { enumerable: true, get() { calls++; throw Error('unrelated accessor'); } });
  f.caps.vaults![id] = target;
  expect(await f.cli.run(f.args('preview'))).toMatchObject({ status: 'blocked' });
  expect(calls).toBe(0);
  expect(readdirSync(f.journal)).toEqual([]);
});

test('typed selection never invokes a legacy accessor, including after the live source is retired', async () => {
  const f = await fixture();
  const legacy: Record<string, unknown> = {};
  let calls = 0;
  Object.defineProperty(legacy, 'legacy-operation', { enumerable: true, get() { calls++; return undefined; } });
  f.caps.lifecycleReadbacks = legacy as RegisteredHost['lifecycleReadbacks'];
  const provisioning = f.provision(f.caps, true);
  const cli = createInstalledCli(provisioning);
  const args = ['init', '--readback', '--operation', 'legacy-operation', '--vault', f.e.vault.vault_id];
  expect(await cli.run(args)).toMatchObject({ status: 'unavailable' });
  expect(calls).toBe(0);
  f.db.close(); f.hub.close();
  expect(await createInstalledCli(provisioning).run(args)).toMatchObject({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
  expect(calls).toBe(0);
});

test('typed selection falls back to an exact independently signed legacy lifecycle readback after source retirement', async () => {
  const f = await fixture();
  const key = generateKeyPairSync('ed25519');
  const hash = createHash('sha256').update('legacy lifecycle fixture').digest('hex');
  const legacy: LifecycleRegistration = {
    root: rootAt(f.journal), identity: { ...f.e.identity, installationId: 'legacy-install' },
    plan: { command: 'init', targetId: f.e.vault.vault_id, expectedGeneration: null, nextGeneration: 'legacy-generation', releaseSha256: null, planSha256: hash },
    authority: { keyId: 'legacy-key', async verify(bytes, signature) { return verify(null, bytes, key.publicKey, Buffer.from(signature, 'base64')); } },
    evidence: { version: 'legacy-evidence', async observe() { throw Error('unexpected effect observer'); } },
  };
  const operation: LifecycleRequest = { command: 'init', targetId: f.e.vault.vault_id,
    expectedGeneration: null, planSha256: hash, operationId: 'legacy-operation' };
  const writer = createLifecycleJournal(() => legacy, { async sign(bytes) { return sign(null, bytes, key.privateKey).toString('base64'); } });
  await writer.reserve(operation);
  f.caps.lifecycleReadbacks = { [operation.operationId]: legacy };
  const provisioning = f.provision(f.caps, true);
  f.db.close(); f.hub.close();
  const result = await createInstalledCli(provisioning).run(['init', '--readback', '--operation', operation.operationId, '--vault', operation.targetId]);
  expect(result).toMatchObject({ status: 'reserved', code: 'LIFECYCLE_RESERVED' });
});

test('malformed legacy data cannot make a typed unknown operation bypass the stale-source gate', async () => {
  const f = await fixture();
  const malformed = {
    root: {}, identity: { ...f.e.identity, installationId: 'legacy-install' },
    plan: { command: 'init', targetId: f.e.vault.vault_id, expectedGeneration: null, nextGeneration: 'legacy-generation',
      releaseSha256: null, planSha256: createHash('sha256').update('malformed').digest('hex') },
    authority: { keyId: 'legacy-key', async verify() { return true; } },
    evidence: { version: 'legacy-evidence', async observe() { throw Error('unexpected effect observer'); } },
  };
  f.caps.lifecycleReadbacks = { 'legacy-operation': malformed as unknown as LifecycleRegistration };
  const provisioning = f.provision(f.caps, true);
  f.db.close(); f.hub.close();
  expect(await createInstalledCli(provisioning).run(['init', '--readback', '--operation', 'legacy-operation', '--vault', f.e.vault.vault_id]))
    .toMatchObject({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
});

test('non-enumerable legacy registration fields cannot create cold-read eligibility', async () => {
  const f = await fixture();
  const legacy = {
    root: rootAt(f.journal), identity: { ...f.e.identity, installationId: 'legacy-install' },
    plan: { command: 'init', targetId: f.e.vault.vault_id, expectedGeneration: null, nextGeneration: 'legacy-generation',
      releaseSha256: null, planSha256: createHash('sha256').update('legacy').digest('hex') },
    authority: { keyId: 'legacy-key', async verify() { return true; } },
    evidence: { version: 'legacy-evidence', async observe() { throw Error('unexpected effect observer'); } },
  };
  Object.defineProperty(legacy, 'root', { enumerable: false });
  f.caps.lifecycleReadbacks = { 'legacy-operation': legacy as LifecycleRegistration };
  const provisioning = f.provision(f.caps, true);
  f.db.close(); f.hub.close();
  expect(await createInstalledCli(provisioning).run(['init', '--readback', '--operation', 'legacy-operation', '--vault', f.e.vault.vault_id]))
    .toMatchObject({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
});

test('typed selection ignores inherited and nested-accessor legacy rows without evaluating them', async () => {
  const f = await fixture();
  let calls = 0;
  const legacy = Object.create({ inherited: {} });
  const row = Object.defineProperty({}, 'plan', { enumerable: true, get() { calls++; throw Error('nested accessor'); } });
  Object.assign(row, { root: {}, identity: {}, authority: {}, evidence: {} });
  legacy.nested = row;
  f.caps.lifecycleReadbacks = legacy;
  const provisioning = f.provision(f.caps, true);
  const cli = createInstalledCli(provisioning);
  const args = (id: string) => ['init', '--readback', '--operation', id, '--vault', f.e.vault.vault_id];
  expect(await cli.run(args('inherited'))).toMatchObject({ status: 'unavailable' });
  expect(await cli.run(args('nested'))).toMatchObject({ status: 'unavailable' });
  f.db.close(); f.hub.close();
  expect(await createInstalledCli(provisioning).run(args('inherited'))).toMatchObject({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
  expect(await createInstalledCli(provisioning).run(args('nested'))).toMatchObject({ status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH' });
  expect(calls).toBe(0);
});

test.each(['verify', 'keyId', 'observe', 'version', 'verify metadata', 'observe metadata'] as const)(
  'holds original class-backed legacy %s across readback without evaluating accessors', async kind => {
    const f = await fixture();
    const key = generateKeyPairSync('ed25519');
    const hash = createHash('sha256').update('legacy port fixture').digest('hex');
    let armed = false, accessorCalls = 0;
    class Authority {
      keyId = 'legacy-key';
      async verify(bytes: Uint8Array, signature: string) {
        expect(this).toBe(authority);
        if (armed && kind === 'verify') Object.defineProperty(this, 'verify', { configurable: true, get() {
          accessorCalls++; return Authority.prototype.verify;
        } });
        if (armed && kind === 'keyId') Object.defineProperty(this, 'keyId', { configurable: true, get() {
          accessorCalls++; return 'legacy-key';
        } });
        return verify(null, bytes, key.publicKey, Buffer.from(signature, 'base64'));
      }
    }
    class Evidence {
      version = 'legacy-evidence';
      async observe(subject: { claimSha256: string }, evidenceId: string) {
        expect(this).toBe(evidence);
        if (armed && kind === 'observe') Object.defineProperty(this, 'observe', { configurable: true, get() {
          accessorCalls++; return Evidence.prototype.observe;
        } });
        if (armed && kind === 'version') Object.defineProperty(this, 'version', { configurable: true, get() {
          accessorCalls++; return 'legacy-evidence';
        } });
        return { evidenceId, claimSha256: subject.claimSha256, evidenceSha256: hash };
      }
    }
    const authority = new Authority(), evidence = new Evidence();
    const legacy: LifecycleRegistration = { root: rootAt(f.journal), identity: { ...f.e.identity, installationId: 'legacy-install' },
      plan: { command: 'init', targetId: f.e.vault.vault_id, expectedGeneration: null, nextGeneration: 'legacy-generation', releaseSha256: null, planSha256: hash },
      authority, evidence };
    const operation: LifecycleRequest = { command: 'init', targetId: f.e.vault.vault_id,
      expectedGeneration: null, planSha256: hash, operationId: 'legacy-operation' };
    const writer = createLifecycleJournal(() => legacy, { async sign(bytes) { return sign(null, bytes, key.privateKey).toString('base64'); } });
    await writer.reserve(operation);
    const claim = await writer.claim(operation);
    if (claim.status !== 'claimed') throw Error('missing legacy claim');
    await writer.markCompleted(claim.token, 'legacy-observation');
    armed = true;
    if (kind.endsWith('metadata')) {
      const method = kind === 'verify metadata' ? Authority.prototype.verify : Evidence.prototype.observe;
      for (const name of ['call', 'bind', 'name', 'length']) Object.defineProperty(method, name, { configurable: true, get() {
        accessorCalls++; throw Error('unexpected callable metadata');
      } });
    }
    f.caps.lifecycleReadbacks = { [operation.operationId]: legacy };
    const provisioning = f.provision(f.caps, true);
    f.db.close(); f.hub.close();
    const result = await createInstalledCli(provisioning).run(['init', '--readback', '--operation', operation.operationId, '--vault', operation.targetId]);
    expect(accessorCalls).toBe(0);
    expect(result.status).toBe(kind.endsWith('metadata') ? 'completed' : 'blocked');
    if (!kind.endsWith('metadata')) expect(result.lifecycleReceipt).toBeUndefined();
  },
);

test('reconciles lost terminal acknowledgement after registry revocation without leaking a receipt', async () => {
  const f = await fixture();
  f.hooks.after = () => { f.caps.vaultInitOperations = {}; };
  const result = await f.cli.run(f.args('execute'));
  expect(result).toMatchObject({ status: 'uncertain' });
  expect(result.lifecycleReceipt).toBeUndefined();
  delete f.hooks.after;
  f.caps.vaultInitOperations = f.registry;
  expect(await f.cli.run(f.args('readback'))).toMatchObject({ status: 'completed' });
});

test('rejects unsupported, inherited and accessor registrations without invoking their code', async () => {
  const f = await fixture(), id = f.e.operationId;
  let calls = 0;
  Object.defineProperty(f.registry, id, { configurable: true, get() { calls++; throw Error('private fixture'); } });
  expect(await f.cli.run(f.args('readback'))).toMatchObject({ status: 'blocked' });
  expect(calls).toBe(0);
  Object.defineProperty(f.registry, id, { configurable: true, enumerable: true, writable: true, value: { ...f.approved, format: 'future-v99' } });
  expect(await f.cli.run(f.args('execute'))).toMatchObject({ status: 'blocked' });
  f.caps.vaultInitOperations = Object.create({ [id]: f.approved });
  expect(await f.cli.run(f.args('execute'))).toMatchObject({ status: 'blocked' });
  expect(readdirSync(f.journal)).toEqual([]);
});

test('does not use an unapproved or malformed entry to construct a CLI on closed recovery handles', async () => {
  const f = await fixture(), id = f.e.operationId;
  const token = f.provision(f.caps, true);
  f.db.close(); f.hub.close();
  const preview: VaultInitCliEntry = { mode: 'preview', format: f.approved.format, enrollment: f.e, signer: f.signer, owner: f.owner };
  const invalid = [
    preview,
    { ...f.approved, format: 'unsupported' } as unknown as VaultInitCliEntry,
  ];
  for (const entry of invalid) {
    f.registry[id] = entry;
    expect(() => createInstalledCli(token)).toThrow();
  }
  delete f.registry[id];
  expect(() => createInstalledCli(token)).toThrow();
  Object.setPrototypeOf(f.registry, { [id]: f.approved });
  expect(() => createInstalledCli(token)).toThrow();
  Object.setPrototypeOf(f.registry, Object.prototype);
  let calls = 0;
  Object.defineProperty(f.registry, id, { enumerable: true, get() { calls++; throw Error('unexpected getter'); } });
  expect(() => createInstalledCli(token)).toThrow();
  expect(calls).toBe(0);
  expect(readdirSync(f.journal)).toEqual([]);
});

test('concurrent installed attempts have one physical owner', async () => {
  const f = await fixture();
  const results = await Promise.all([f.cli.run(f.args('execute')), f.cli.run(f.args('execute'))]);
  expect(results.map(result => result.status).sort()).toEqual(['blocked', 'completed']);
  expect((await f.cli.run(f.args('readback'))).status).toBe('completed');
  expect(readdirSync(f.journal).sort()).toEqual([
    'lifecycle-v1.init-1.claim.json', 'lifecycle-v1.init-1.reservation.json', 'lifecycle-v1.init-1.terminal.json',
  ]);
});

test('a new typed operation collision withdraws a legacy readback', async () => {
  const f = await fixture();
  const key = generateKeyPairSync('ed25519');
  const hash = createHash('sha256').update('legacy collision fixture').digest('hex');
  let armed = false;
  const authority = { keyId: 'legacy-key', async verify(bytes: Uint8Array, signature: string) {
    if (armed) f.registry['legacy-operation'] = f.approved;
    return verify(null, bytes, key.publicKey, Buffer.from(signature, 'base64'));
  } };
  const legacy: LifecycleRegistration = {
    root: rootAt(f.journal), identity: { ...f.e.identity, installationId: 'legacy-install' },
    plan: { command: 'init', targetId: f.e.vault.vault_id, expectedGeneration: null, nextGeneration: 'legacy-generation', releaseSha256: null, planSha256: hash },
    authority, evidence: { version: 'legacy-evidence', async observe() { throw Error('unexpected observer'); } },
  };
  const operation: LifecycleRequest = { command: 'init', targetId: f.e.vault.vault_id,
    expectedGeneration: null, planSha256: hash, operationId: 'legacy-operation' };
  const writer = createLifecycleJournal(() => legacy, { async sign(bytes) { return sign(null, bytes, key.privateKey).toString('base64'); } });
  await writer.reserve(operation);
  armed = true;
  f.caps.lifecycleReadbacks = { [operation.operationId]: legacy };
  const provisioning = f.provision(f.caps, true);
  f.db.close(); f.hub.close();
  const result = await createInstalledCli(provisioning).run(['init', '--readback', '--operation', operation.operationId, '--vault', operation.targetId]);
  expect(result).toMatchObject({ status: 'blocked', code: 'HOST_IDENTITY_MISMATCH' });
});
