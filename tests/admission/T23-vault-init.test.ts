import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { accessSync, chmodSync, constants, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { createVaultInitController, createVaultInitReader, vaultInitApproval } from '../../deploy/runtime/vault-init.js';
import { createInstalledCli } from '../../deploy/runtime/cli.js';
import { createRuntimeProvisioning } from '../../deploy/runtime/composition.js';
import { expect, test } from 'vitest';
import { createVaultKitInstaller } from '../../deploy/obsidian/install.mjs';
import { connectVault, confirmVault, inspectVault, requireVault } from '../../packages/integrations/vault/connection.js';
import { openDatabase } from '../../packages/storage/src/database.js';

const now = '2026-11-18T12:00:00.000Z';
function rootAt(path: string) {
  const stat = lstatSync(path);
  return { path, device: stat.dev, inode: stat.ino };
}
async function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 't23-init-'));
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
  const signer = { async sign(bytes: Uint8Array) { return sign(null, bytes, journalKey.privateKey).toString('base64'); } };
  const options = { assetRoot: assets, stageParent: staging, deviceId, captureHost, serviceUid: uid, editorUid: uid,
    loadVault: (id: string) => requireVault(db, id), inspectVault: (device: string, id: string) => inspectVault(db, device, id) };
  const host = { identity, captureHost, serviceUid: uid, minimumFreeBytes: 1, dataRoot: dir, profile: 'test',
    runtime: { createVaultKitInstaller }, vaults: { [vaultId]: { identity, configRevision: vault.config_revision, scopeHash: vault.scope_hash,
      installer: options, options: { ...options, async inspectObsidian(): Promise<never> { throw Error('unexpected application probe'); } } } } };
  const human = Buffer.from([0xef, 0xbb, 0xbf, 35, 32, 65, 13, 10]);
  mkdirSync(join(root, '模板')); writeFileSync(join(root, '模板/知识笔记.md'), human);
  const lock = join(dir, 'fixture.lock');
  const hooks: { after?: () => void } = {};
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
    const handle = openSync(lock, 'wx', 0o600);
    try { const result = await read(dir); hooks.after?.(); return result; }
    finally { closeSync(handle); unlinkSync(lock); }
  } };
  return { dir, root, journal, db, e, host, options, approval, signer, human, owner, hooks, lock };
}
test('previews a confirmed real Vault without reserving or installing any file', async () => {
  const f = await fixture();
  try {
    const controller = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
    const plan = await controller.preview();
    expect(plan.operationId).toBe(f.e.operationId);
    expect(readdirSync(f.journal)).toEqual([]);
    expect(readdirSync(f.root)).toEqual(['模板']);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test('installs and reads back an explicitly pinned published Vault kit', async () => {
  const f = await fixture();
  const releases = mkdtempSync(join(realpathSync(tmpdir()), 't23-init-releases-'));
  try {
    const release = join(releases, 'a'.repeat(64));
    const assets = join(release, 'assets', 'vault-kit');
    mkdirSync(join(release, 'assets'), { recursive: true, mode: 0o711 });
    cpSync(f.e.assets.path, assets, { recursive: true });
    const enrollment = { ...f.e, assets: rootAt(assets),
      publishedKit: { release: rootAt(release), controllerUid: process.geteuid!() } };
    f.options.assetRoot = assets;

    const controller = createVaultInitController(() => enrollment, f.owner, f.host, f.signer);
    const plan = await controller.preview();
    expect(plan.subject.manifestSha256).toBe(f.e.kitSha256);
    const approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    const origin = 'http://localhost';
    const cli = createInstalledCli(createRuntimeProvisioning({
      registration: { identity: f.e.identity, captureHost: f.e.captureHost, serviceUid: f.e.serviceUid,
        profile: 'test', dataRoot: f.dir, minimumFreeBytes: 1, origin, rpId: 'localhost', listener: { host: '127.0.0.1', port: 0, origin } },
      hostCapabilities: { vaults: f.host.vaults, vaultInitOperations: {
        [f.e.operationId]: { format: 'patrick-installed-vault-init-v1', mode: 'approved', enrollment, owner: f.owner,
          signer: f.signer, plan, approval },
      } },
      service: { databasePath: join(f.dir, 'source.sqlite'), credentialDirectory: f.dir,
        recoveryRuntime: { attach() { throw Error('unexpected startup'); } }, bindRecoveryOperations() { throw Error('unexpected backup'); } },
    }));
    const args = ['init', '--vault', f.e.vault.vault_id, '--operation', f.e.operationId];
    expect(await cli.run([...args, '--preview'])).toMatchObject({ status: 'preview' });
    expect(await cli.run([...args, '--execute'])).toMatchObject({ status: 'completed' });
    expect(await cli.run([...args, '--readback'])).toMatchObject({ status: 'completed' });
    const reader = createVaultInitReader(() => enrollment, f.owner, plan);

    chmodSync(join(release, 'assets'), 0o733);
    await expect(reader.read()).rejects.toThrow('VAULT_INIT_BINDING_INVALID');
    chmodSync(join(release, 'assets'), 0o711);
    const manifest = join(assets, 'manifest.json');
    if (process.platform === 'darwin') {
      const acl = spawnSync('/bin/chmod', ['+a', 'everyone allow write', manifest]);
      expect(acl.status, String(acl.stderr)).toBe(0);
      await expect(reader.read()).rejects.toThrow('VAULT_INIT_BINDING_INVALID');
      expect(spawnSync('/bin/chmod', ['-N', manifest]).status).toBe(0);
    }
    writeFileSync(manifest, '{}');
    await expect(reader.read()).rejects.toThrow('VAULT_INIT_BINDING_INVALID');
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true });
    rmSync(releases, { recursive: true });
  }
}, 120_000);

test('rejects direct Vault owner and signer accessors without executing them during construction', async () => {
  const f = await fixture();
  try {
    let ownerReads = 0, signerReads = 0;
    const owner = Object.defineProperty({}, 'withExclusiveReadRoot', { get() { ownerReads++; return f.owner.withExclusiveReadRoot; } }) as typeof f.owner;
    const signer = Object.defineProperty({}, 'sign', { get() { signerReads++; return f.signer.sign; } }) as typeof f.signer;
    let ownerRejected = false, signerRejected = false;
    try { createVaultInitController(() => f.e, owner, f.host, f.signer); } catch { ownerRejected = true; }
    try { createVaultInitController(() => f.e, f.owner, f.host, signer); } catch { signerRejected = true; }
    console.log(JSON.stringify({ ownerReads, signerReads, ownerRejected, signerRejected }));
    expect(ownerRejected).toBe(true); expect(signerRejected).toBe(true);
    expect(ownerReads).toBe(0); expect(signerReads).toBe(0);
    expect(readdirSync(f.journal)).toEqual([]);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test('preserves a direct class owner and signer receiver without reading function metadata', async () => {
  const f = await fixture();
  try {
    const metadata: string[] = [];
    class Owner {
      async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
        expect(this).toBe(owner);
        return Reflect.apply(f.owner.withExclusiveReadRoot<T>, f.owner, [read]);
      }
    }
    class Signer {
      async sign(bytes: Uint8Array) { expect(this).toBe(signer); return Reflect.apply(f.signer.sign, f.signer, [bytes]); }
    }
    for (const method of [Owner.prototype.withExclusiveReadRoot, Signer.prototype.sign]) {
      for (const key of ['call', 'bind']) Object.defineProperty(method, key, { get() { metadata.push(key); throw Error('metadata'); } });
    }
    const owner = new Owner(), signer = new Signer();
    const controller = createVaultInitController(() => f.e, owner, f.host, signer);
    const plan = await controller.preview();
    const approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    expect(await controller.execute(plan, approval)).toMatchObject({ status: 'completed' });
    expect(metadata).toEqual([]);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
}, 120_000);

test('direct Vault signer getter drift after native publication remains uncertain without invoking it', async () => {
  const f = await fixture();
  try {
    let getters = 0, changed = false;
    class Signer { async sign(bytes: Uint8Array) { expect(this).toBe(signer); return Reflect.apply(f.signer.sign, f.signer, [bytes]); } }
    const signer = new Signer(), original = Signer.prototype.sign;
    const load = f.options.loadVault;
    f.options.loadVault = id => {
      const result = load(id);
      if (!changed && existsSync(join(f.root, '模板/判断案例.md'))) {
        changed = true;
        Object.defineProperty(signer, 'sign', { configurable: true, get() { getters++; return original; } });
      }
      return result;
    };
    const controller = createVaultInitController(() => f.e, f.owner, f.host, signer);
    const plan = await controller.preview();
    const approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    const result = await controller.execute(plan, approval);
    console.log(JSON.stringify({ changed, getters, status: result.status }));
    expect(changed).toBe(true);
    expect(result.status).toBe('running_or_uncertain');
    expect(getters).toBe(0);
    expect(existsSync(join(f.root, '模板/判断案例.md'))).toBe(true);
    expect(await createVaultInitReader(() => f.e, f.owner, plan).read()).toMatchObject({ status: 'running_or_uncertain' });
    expect(getters).toBe(0);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
}, 120_000);


test('publishes only missing templates and binds the observed files to the durable claim', async () => {
  const f = await fixture();
  try {
    const c = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
    const plan = await c.preview();
    const signature = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    const before = lstatSync(join(f.root, '模板/知识笔记.md')).ino;
    const result = await c.execute(plan, signature);
    expect(result.status).toBe('completed');
    const claim = readFileSync(join(f.journal, 'lifecycle-v1.init-1.claim.json'));
    const terminal = JSON.parse(readFileSync(join(f.journal, 'lifecycle-v1.init-1.terminal.json'), 'utf8'));
    expect(terminal.payload.receipt.claimSha256).toBe(createHash('sha256').update(claim).digest('hex'));
    expect(result).toEqual({ status: 'completed', receipt: terminal.payload.receipt });
    expect(readFileSync(join(f.root, '模板/知识笔记.md'))).toEqual(f.human);
    expect(lstatSync(join(f.root, '模板/知识笔记.md')).ino).toBe(before);
    const manifest = JSON.parse(readFileSync(join(f.e.assets.path, 'manifest.json'), 'utf8'));
    for (const file of manifest.files) {
      if (file.path !== '模板/知识笔记.md') expect(createHash('sha256').update(readFileSync(join(f.root, file.path))).digest('hex')).toBe(file.sha256);
    }
    f.db.close();
    renameSync(join(f.dir, 'source.sqlite'), join(f.dir, 'retired.sqlite'));
    const reader = createVaultInitReader(() => f.e, f.owner, plan);
    expect(await reader.read()).toEqual(result);
    expect(await c.execute(plan, signature)).toEqual(result);
    expect(existsSync(join(f.dir, 'source.sqlite'))).toBe(false);
    const installed = join(f.root, '模板/判断案例.md');
    const original = join(f.dir, 'original-template');
    renameSync(installed, original);
    cpSync(original, installed);
    await expect(reader.read()).rejects.toThrow();
    unlinkSync(installed);
    renameSync(original, installed);
    writeFileSync(join(f.root, '模板/判断案例.md'), 'later human change');
    await expect(reader.read()).rejects.toThrow();
    await expect(c.execute(plan, signature)).rejects.toThrow();
    expect(readFileSync(join(f.root, '模板/判断案例.md'), 'utf8')).toBe('later human change');
  } finally { if (f.db.open) f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test('refuses a forged approval, switched operation, stale user baseline and unsafe physical Vault before journaling', async () => {
  const f = await fixture();
  try {
    const controller = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
    const plan = await controller.preview();
    const approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    const foreign = sign(null, vaultInitApproval(plan), generateKeyPairSync('ed25519').privateKey).toString('base64');
    await expect(controller.execute(plan, foreign)).rejects.toThrow();
    const other = { ...plan, operationId: 'different' };
    await expect(controller.execute(other, sign(null, vaultInitApproval(other), f.approval.privateKey).toString('base64'))).rejects.toThrow();
    writeFileSync(join(f.root, '模板/知识笔记.md'), 'changed after preview');
    await expect(controller.execute(plan, approval)).rejects.toThrow();
    expect(readdirSync(f.journal)).toEqual([]);
    renameSync(f.root, f.root + '-original');
    mkdirSync(f.root);
    await expect(controller.preview()).rejects.toThrow();
    expect(readdirSync(f.journal)).toEqual([]);
    expect(readFileSync(join(f.root + '-original', '模板/知识笔记.md'), 'utf8')).toBe('changed after preview');
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test('never dispatches an altered approved kit under an owned claim', async () => {
  const f = await fixture();
  try {
    const claim = join(f.journal, 'lifecycle-v1.init-1.claim.json');
    const inspect = f.options.inspectVault;
    let changed = false;
    f.options.inspectVault = async (device, id) => {
      const value = await inspect(device, id);
      if (!changed && existsSync(claim)) {
        changed = true;
        const path = join(f.e.assets.path, 'manifest.json');
        writeFileSync(path, readFileSync(path, 'utf8') + '\n');
      }
      return value;
    };
    const c = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
    const plan = await c.preview(), approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    expect(await c.execute(plan, approval)).toEqual({ status: 'running_or_uncertain' });
    expect(changed).toBe(true);
    expect(readdirSync(f.root)).toEqual(['模板']);
    expect(await c.execute(plan, approval)).toEqual({ status: 'running_or_uncertain' });
    expect(readdirSync(f.journal).sort()).toEqual(['lifecycle-v1.init-1.claim.json', 'lifecycle-v1.init-1.reservation.json']);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test('retains an interrupted real create-only publication without issuing another native call', async () => {
  const f = await fixture();
  try {
    const inspect = f.options.inspectVault;
    const published = join(f.root, '模板/判断案例.md');
    let calls = 0;
    f.options.inspectVault = async (device, id) => {
      calls++;
      if (existsSync(published)) {
        expect(existsSync(join(f.journal, 'lifecycle-v1.init-1.claim.json'))).toBe(true);
        throw Error('lost response after actual create-only link');
      }
      return inspect(device, id);
    };
    const c = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
    const plan = await c.preview(), approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    expect(await c.execute(plan, approval)).toEqual({ status: 'running_or_uncertain' });
    expect(existsSync(published)).toBe(true);
    expect(existsSync(join(f.root, '模板/标准修订.md'))).toBe(false);
    const inode = lstatSync(published).ino, before = calls;
    f.db.close();
    expect(await c.execute(plan, approval)).toEqual({ status: 'running_or_uncertain' });
    expect(await createVaultInitReader(() => f.e, f.owner, plan).read()).toEqual({ status: 'running_or_uncertain' });
    expect(calls).toBe(before);
    expect(lstatSync(published).ino).toBe(inode);
    expect(readFileSync(join(f.root, '模板/知识笔记.md'))).toEqual(f.human);
    expect(existsSync(join(f.journal, 'lifecycle-v1.init-1.terminal.json'))).toBe(false);
  } finally { if (f.db.open) f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test('blocks a stale mapping across an awaited live check', async () => {
  const f = await fixture();
  try {
    const c = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
    const plan = await c.preview(), approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    f.db.prepare('UPDATE vault_clients SET mapping_revision = mapping_revision + 1 WHERE vault_id = ?').run(f.e.vault.vault_id);
    await expect(c.execute(plan, approval)).rejects.toThrow();
    expect(readdirSync(f.journal)).toEqual([]);
    expect(readdirSync(f.root)).toEqual(['模板']);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});


test('reconciles a lost terminal acknowledgement in a separate public-only process after retiring the source database', async () => {
  const f = await fixture();
  try {
    const c = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
    const plan = await c.preview(), approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    const terminal = join(f.journal, 'lifecycle-v1.init-1.terminal.json');
    f.hooks.after = () => { if (existsSync(terminal)) throw Error('lost post-terminal lease acknowledgement'); };
    const competing = await Promise.allSettled([c.execute(plan, approval), c.execute(plan, approval)]);
    expect(competing[0]).toEqual({ status: 'fulfilled', value: { status: 'running_or_uncertain' } });
    expect(competing[1]).toMatchObject({ status: 'rejected', reason: { code: 'EEXIST' } });
    delete f.hooks.after;
    f.db.close();
    renameSync(join(f.dir, 'source.sqlite'), join(f.dir, 'retired.sqlite'));
    const sealed = readFileSync(terminal);
    const expected = { status: 'completed', receipt: JSON.parse(sealed.toString()).payload.receipt };
    const reader = join(f.dir, 'public-reader.mjs');
    buildSync({ bundle: true, platform: 'node', target: 'node26', format: 'esm', outfile: reader,
      stdin: { resolveDir: process.cwd(), contents: `
        import assert from 'node:assert/strict';
        import { fstatSync, lstatSync } from 'node:fs';
        import { createVaultInitReader } from './deploy/runtime/vault-init.ts';
        const [registration, original, lock] = process.argv.slice(2);
        const e = JSON.parse(registration), plan = JSON.parse(original);
        assert.equal(process.permission.has('fs.write', e.vault.root_path), false);
        const owner = { async withExclusiveReadRoot(read) {
          const held = fstatSync(3, {bigint: true});
          function guard() {
            const named = lstatSync(lock, {bigint:true});
            assert.equal(named.dev, held.dev); assert.equal(named.ino, held.ino);
          }
          guard(); try { return await read(e.owner.path); } finally { guard(); }
        } };
        console.log(JSON.stringify(await createVaultInitReader(() => e, owner, plan).read()));
      ` } });
    const fd = openSync(f.lock, 'wx', 0o600);
    try {
      const child = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', reader, JSON.stringify(f.e), JSON.stringify(plan), f.lock],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 15_000 });
      expect(child.status, child.error?.message ?? child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(expected);
    } finally { closeSync(fd); unlinkSync(f.lock); }
    expect(await c.execute(plan, approval)).toEqual(expected);
    expect(readFileSync(terminal)).toEqual(sealed);
    const bad = JSON.parse(sealed.toString());
    bad.payload.receipt.evidenceSha256 = '0'.repeat(64);
    writeFileSync(terminal, JSON.stringify(bad));
    await expect(createVaultInitReader(() => f.e, f.owner, plan).read()).rejects.toThrow();
    expect(existsSync(join(f.dir, 'source.sqlite'))).toBe(false);
  } finally { if (f.db.open) f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test('rejects a changed live Vault configuration while signing the terminal', async () => {
  const f = await fixture();
  try {
    const signer = { async sign(bytes: Uint8Array) {
      if (JSON.parse(Buffer.from(bytes).toString()).kind === 'terminal') {
        f.db.prepare('UPDATE vaults SET config_revision = config_revision + 1 WHERE vault_id = ?').run(f.e.vault.vault_id);
      }
      return f.signer.sign(bytes);
    } };
    const c = createVaultInitController(() => f.e, f.owner, f.host, signer);
    const plan = await c.preview(), approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    expect(await c.execute(plan, approval)).toEqual({ status: 'running_or_uncertain' });
    expect(existsSync(join(f.root, '系统视图/.patrick-vault-kit-1.0.0-' + f.e.kitSha256.slice(0, 12) + '.json'))).toBe(true);
    expect(existsSync(join(f.journal, 'lifecycle-v1.init-1.terminal.json'))).toBe(false);
    expect(await c.execute(plan, approval)).toEqual({ status: 'running_or_uncertain' });
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});


test('rechecks the owned claim after an awaited native scope lookup and preserves a substituted claim', async () => {
  const f = await fixture();
  try {
    const claimPath = join(f.journal, 'lifecycle-v1.init-1.claim.json');
    const load = f.options.loadVault;
    let claimedReads = 0;
    f.options.loadVault = id => {
      const v = load(id);
      if (existsSync(claimPath) && ++claimedReads === 2) {
        const env = JSON.parse(readFileSync(claimPath, 'utf8'));
        env.payload.binding.plan.targetId = 'other-vault';
        writeFileSync(claimPath, JSON.stringify(env));
      }
      return v;
    };
    const c = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
    const plan = await c.preview(), approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    expect(await c.execute(plan, approval)).toEqual({ status: 'running_or_uncertain' });
    expect(claimedReads).toBe(2);
    const substituted = readFileSync(claimPath);
    expect(JSON.parse(substituted.toString()).payload.binding.plan.targetId).toBe('other-vault');
    await expect(c.execute(plan, approval)).rejects.toThrow();
    expect(readFileSync(claimPath)).toEqual(substituted);
    expect(readdirSync(f.root)).toEqual(['模板']);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test('preserves an existing owner index without attributing it to a new T27 seed', async () => {
  const f = await fixture();
  try {
    const system = join(f.root, '系统视图');
    mkdirSync(system);
    const index = join(system, '索引.md');
    writeFileSync(index, f.human);
    const originalInode = lstatSync(index).ino;
    const c = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
    const plan = await c.preview(), approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    expect((await c.execute(plan, approval)).status).toBe('completed');
    expect(lstatSync(index).ino).toBe(originalInode);
    expect(readFileSync(index)).toEqual(f.human);
    expect(readdirSync(system).filter(path => path.startsWith('.patrick-index-seed'))).toEqual([]);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test('keeps the claim unresolved when the last live lookup changes a file before terminal publication', async () => {
  const f = await fixture();
  try {
    let terminalSigned = false;
    const signer = { async sign(bytes: Uint8Array) {
      if (JSON.parse(Buffer.from(bytes).toString()).kind === 'terminal') terminalSigned = true;
      return f.signer.sign(bytes);
    } };
    const inspect = f.options.inspectVault;
    const target = join(f.root, '模板/判断案例.md');
    let changed = false;
    f.options.inspectVault = async (device, id) => {
      const value = await inspect(device, id);
      if (terminalSigned && !changed) {
        changed = true;
        writeFileSync(target, 'edited during final observation');
      }
      return value;
    };
    const c = createVaultInitController(() => f.e, f.owner, f.host, signer);
    const plan = await c.preview(), approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    expect(await c.execute(plan, approval)).toEqual({ status: 'running_or_uncertain' });
    expect(changed).toBe(true);
    expect(existsSync(join(f.journal, 'lifecycle-v1.init-1.terminal.json'))).toBe(false);
    expect(await c.execute(plan, approval)).toEqual({ status: 'running_or_uncertain' });
    expect(readFileSync(target, 'utf8')).toBe('edited during final observation');
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test.each(['preview', 'last live lookup', 'reservation signer', 'claim signer'] as const)(
  'refuses a stale baseline during %s before spending a claim', async phase => {
    const f = await fixture();
    try {
      const original = join(f.root, '模板/知识笔记.md'), edit = Buffer.from('owner edit during preflight');
      const before = lstatSync(original).ino;
      let armed = false, lookups = 0, changed = false;
      const editOwnerFile = () => { changed = true; writeFileSync(original, edit); };
      const inspect = f.options.inspectVault;
      f.options.inspectVault = async (device, id) => {
        const value = await inspect(device, id);
        if (armed && ++lookups === 2 && (phase === 'preview' || phase === 'last live lookup')) editOwnerFile();
        return value;
      };
      const signer = { async sign(bytes: Uint8Array) {
        expect(this).toBe(signer);
        const kind = JSON.parse(Buffer.from(bytes).toString()).kind;
        if (armed && phase === kind + ' signer') editOwnerFile();
        return f.signer.sign(bytes);
      } };
      const controller = createVaultInitController(() => f.e, f.owner, f.host, signer);
      if (phase === 'preview') {
        armed = true;
        await expect(controller.preview()).rejects.toThrow();
      } else {
        const plan = await controller.preview();
        const approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
        armed = true;
        await expect(controller.execute(plan, approval)).rejects.toThrow();
      }
      expect(changed).toBe(true);
      expect(readdirSync(f.journal)).toEqual(phase === 'claim signer' ? ['lifecycle-v1.init-1.reservation.json'] : []);
      expect(readdirSync(f.root)).toEqual(['模板']);
      expect(readFileSync(original)).toEqual(edit);
      expect(lstatSync(original).ino).toBe(before);
    } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
  });

test.each(['missing proof', 'mismatched seed proof'] as const)(
  'rejects interrupted seed metadata with %s during preflight', async scenario => {
    const f = await fixture();
    try {
      const system = join(f.root, '系统视图');
      mkdirSync(system);
      const index = join(system, '索引.md'), intent = join(system, '.patrick-index-seed.intent.json');
      const contents = scenario === 'missing proof' ? f.human : readFileSync(join(f.e.assets.path, '系统视图/索引.md'));
      writeFileSync(index, contents);
      writeFileSync(intent, 'retained seed intent');
      if (scenario === 'mismatched seed proof') writeFileSync(join(system, '.patrick-index-seed.json'), '{}');
      const original = lstatSync(index).ino;
      const c = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
      await expect(c.preview()).rejects.toThrow();
      expect(readFileSync(index)).toEqual(contents);
      expect(lstatSync(index).ino).toBe(original);
      expect(readFileSync(intent, 'utf8')).toBe('retained seed intent');
      expect(readdirSync(f.journal)).toEqual([]);
    } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
  });

test('checks actual staging creation under child umask 0002 and permits secure existing staging', async () => {
  // Vitest's dedicated fork can set the process mask after all fixture roots are secured.
  if (process.env.PATRICK_VAULT_INIT_MASK_CHILD !== '1') {
    const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--pool=forks',
      '--no-file-parallelism', 'tests/admission/T23-vault-init.test.ts', '-t', 'child umask 0002'], {
      env: { ...process.env, PATRICK_VAULT_INIT_MASK_CHILD: '1' }, encoding: 'utf8', timeout: 20_000 });
    expect(child.status, child.error?.message ?? child.stdout + child.stderr).toBe(0);
    return;
  }
  const f = await fixture();
  const saved = process.umask();
  try {
    const controller = createVaultInitController(() => f.e, f.owner, f.host, f.signer);
    const plan = await controller.preview(), approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    process.umask(0o002);
    const [preflight] = await Promise.allSettled([controller.preview()]);
    const [execution] = await Promise.allSettled([controller.execute(plan, approval)]);
    expect(readdirSync(f.journal)).toEqual([]);
    expect(readdirSync(f.root)).toEqual(['模板']);
    expect(preflight.status).toBe('rejected');
    expect(execution.status).toBe('rejected');

    mkdirSync(join(f.root, '系统视图'), { mode: 0o700 });
    const dirs = ['模板/.patrick-staging', '系统视图/.patrick-staging'].map(p => join(f.root, p));
    for (const dir of dirs) mkdirSync(dir, { mode: 0o700 });
    const inodes = dirs.map(d => lstatSync(d).ino);
    const safe = await controller.preview(), approved = sign(null, vaultInitApproval(safe), f.approval.privateKey).toString('base64');
    expect((await controller.execute(safe, approved)).status).toBe('completed');
    expect(dirs.map(d => lstatSync(d).ino)).toEqual(inodes);
    expect(readFileSync(join(f.root, '模板/知识笔记.md'))).toEqual(f.human);
    expect(process.umask()).toBe(0o002);
  } finally { process.umask(saved); f.db.close(); rmSync(f.dir, { recursive: true }); }
}, 30_000);

test.skipIf(process.geteuid?.() === 0).each([
  '模板/.patrick-staging', '附件/.patrick-staging', '知识笔记', '模板', 'Vault root', 'temporary stage', 'reservation signing',
])('refuses effective directory access denial at %s before journaling', async scenario => {
  const f = await fixture();
  let denied: string | undefined;
  let originalMode = 0;
  try {
    if (scenario.endsWith('.patrick-staging')) {
      // T27 checks these even when every kit target is already present.
      await createVaultKitInstaller(f.options).installVaultKit(f.e.vault.vault_id);
    }
    const target = scenario === 'Vault root' ? f.root : scenario === 'temporary stage' ? f.e.stage.path :
      join(f.root, scenario === 'reservation signing' ? '模板/.patrick-staging' : scenario);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    originalMode = lstatSync(target).mode & 0o777;
    expect(lstatSync(target).uid).toBe(process.geteuid!());
    const refuseWrite = () => {
      chmodSync(target, 0o500);
      denied = target;
      expect(() => accessSync(target, constants.W_OK | constants.X_OK)).toThrow(expect.objectContaining({ code: 'EACCES' }));
      accessSync(target, constants.R_OK | constants.X_OK);
    };
    const signer = { async sign(bytes: Uint8Array) {
      if (scenario === 'reservation signing' && JSON.parse(Buffer.from(bytes).toString()).kind === 'reservation') refuseWrite();
      return f.signer.sign(bytes);
    } };
    const tree = () => readdirSync(f.root, { recursive: true, encoding: 'utf8' }).sort().map(name => {
      const path = join(f.root, name), stat = lstatSync(path);
      return [name, stat.ino, stat.isFile() ? readFileSync(path) : null];
    });
    const before = tree();
    const controller = createVaultInitController(() => f.e, f.owner, f.host, signer);
    const plan = await controller.preview(), approval = sign(null, vaultInitApproval(plan), f.approval.privateKey).toString('base64');
    if (scenario !== 'reservation signing') refuseWrite();
    const [preflight] = await Promise.allSettled([controller.preview()]);
    const [execution] = await Promise.allSettled([controller.execute(plan, approval)]);
    expect(denied).toBe(target);
    expect(readdirSync(f.journal)).toEqual([]);
    expect(tree()).toEqual(before);
    expect(readdirSync(f.e.stage.path)).toEqual([]);
    expect(lstatSync(target).mode & 0o777).toBe(0o500);
    expect(preflight.status).toBe(scenario === 'reservation signing' ? 'fulfilled' : 'rejected');
    expect(execution.status).toBe('rejected');
  } finally {
    if (denied) chmodSync(denied, originalMode);
    f.db.close(); rmSync(f.dir, { recursive: true });
  }
});
