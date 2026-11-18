import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { closeSync, cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { canonicalize } from '../../deploy/lib/release.mjs';
import { publishStagedDeployment, stageVerifiedEmittedRuntime, verifyEmittedRuntimeCandidate } from '../../deploy/lib/emitted-release.mjs';
import type { ExclusiveRuntimeStaging } from '../../deploy/lib/emitted-release.mjs';
import { canRestoreOldRelease, createGenerationReader, createGenerationStore } from '../../deploy/runtime/lifecycle-generation';
import type { GenerationEnrollment, GenerationOrder, InstalledGeneration } from '../../deploy/runtime/lifecycle-generation';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(parent: string, name: string) {
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  return path;
}
function node(path: string) {
  const info = lstatSync(path, { bigint: true });
  return { device: String(info.dev), inode: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
}
type Release = GenerationEnrollment['releases'][number];
function host(releases: Release[] = []) {
  const fixture = mkdtempSync(join(realpathSync.native(tmpdir()), 'generation-'));
  temporary.push(fixture);
  const root = directory(fixture, 'owner');
  const keys = generateKeyPairSync('ed25519');
  const lock = join(fixture, 'owner.lock');
  const hooks: { after?: () => void } = {};
  const owner: ExclusiveRuntimeStaging = { async withExclusiveReadRoot(use) {
    const fd = openSync(lock, 'wx', 0o600);
    try { const result = await use(root); hooks.after?.(); return result; }
    finally { closeSync(fd); unlinkSync(lock); }
  } };
  const stores = {
    releases: node(directory(root, 'releases')), packages: node(directory(root, 'packages')),
    data: node(directory(root, 'data')), history: node(directory(root, 'history')),
  };
  const e: GenerationEnrollment = {
    root, rootNode: node(root), stores, installationId: 'test-install', hostId: 'test-host',
    identity: { accountId: 'account', scopeId: 'scope', deviceId: 'device', configRevision: '1', domains: ['personal'] },
    target: { os: 'darwin', arch: 'arm64' }, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    releases, generations: [],
  };
  const signed = (order: GenerationOrder) => canonicalize({
    order, signature: sign(null, Buffer.from(canonicalize(order)), keys.privateKey).toString('base64'),
  });
  const signer = { async signRecord(bytes: Uint8Array) { return sign(null, bytes, keys.privateKey).toString('base64'); } };
  return { fixture, root, lock, hooks, owner, e, signed, signer, privateKey: keys.privateKey };
}
function addGeneration(h: ReturnType<typeof host>, id: string, digest: string, schema: number) {
  const data = directory(join(h.root, 'data'), id);
  function database(role: string) {
    const path = join(data, role);
    const db = new DatabaseSync(path);
    try {
      db.exec('create table generation_marker (id text not null)');
      db.prepare('insert into generation_marker values (?)').run(id);
    } finally { db.close(); }
    return node(path);
  }
  const g: InstalledGeneration = {
    id, schema, packageSha256: digest, releaseRoot: node(join(h.root, 'releases', digest)), dataRoot: node(data),
    roles: { 'service.sqlite': database('service.sqlite'), 'hub.sqlite': database('hub.sqlite'), 'answers.sqlite': database('answers.sqlite'),
      credentials: node(directory(data, 'credentials')), projections: node(directory(data, 'projections')), blobs: node(directory(data, 'blobs')) },
  };
  h.e.generations.push(g);
}
function signedOnlyFixture() {
  // A proposed package with no release evidence must be refused by the real gate.
  const digest = 'a'.repeat(64);
  const draft = { expected: { profile: 'deployment-complete', target: { os: 'darwin', arch: 'arm64' },
    packageSha256: digest, schema: { min: 1, max: 2 } }, policy: {} } as Release;
  const h = host([draft]);
  directory(join(h.root, 'releases'), digest);
  writeFileSync(join(h.root, 'packages', digest + '.json'), '{}');
  addGeneration(h, 'one', digest, 1);
  return h;
}

test('requires exact zero generation writes and both verified prerequisites', () => {
  for (const writesSinceSwitch of [1, -1, '0', null, undefined, NaN, Infinity]) {
    expect(canRestoreOldRelease({ snapshotVerified: true, writerStopped: true, writesSinceSwitch })).toBe(false);
  }
  for (const invalid of [false, 1, 'true', null]) {
    expect(canRestoreOldRelease({ snapshotVerified: invalid, writerStopped: true, writesSinceSwitch: 0 })).toBe(false);
    expect(canRestoreOldRelease({ snapshotVerified: true, writerStopped: invalid, writesSinceSwitch: 0 })).toBe(false);
  }
  expect(canRestoreOldRelease({ snapshotVerified: true, writerStopped: true, writesSinceSwitch: 0 })).toBe(true);
});

test('checks physical enrollment on authenticated absence, including after root replacement', async () => {
  const h = host();
  const reader = createGenerationReader(h.e, h.owner);
  expect(Object.keys(reader)).toEqual(['observe']);
  await expect(reader.observe()).resolves.toEqual({ current: null, pending: null, historical: null });
  renameSync(h.root, h.root + '-retained');
  cpSync(h.root + '-retained', h.root, { recursive: true });
  await expect(reader.observe()).rejects.toThrow();
  expect(readdirSync(join(h.root + '-retained', 'history'))).toEqual([]);
});

test('refuses an unsigned transition, changed binding, incompatible schema and unverified release', async () => {
  const h = signedOnlyFixture();
  const store = createGenerationStore(h.e, h.owner, h.signer);
  const order = store.order('install', null, 'one');
  expect(store.order('Install_2', null, 'one').operationId).toBe('Install_2');
  const good = h.signed(order);
  const forged = signedOnlyFixture().signed(order);
  for (const envelope of [canonicalize(order), forged, h.signed({ ...order, previous: '0'.repeat(64) }),
    h.signed({ ...order, generation: { ...order.generation, packageSha256: 'b'.repeat(64) } }), good]) {
    await expect(store.select(envelope)).rejects.toThrow();
    expect(readdirSync(join(h.root, 'history'))).toEqual([]);
  }
  const incompatible = JSON.parse(JSON.stringify(h.e)) as GenerationEnrollment;
  incompatible.generations[0].schema = 3;
  expect(() => createGenerationStore(incompatible, h.owner, h.signer)).toThrow();
  const changed = JSON.parse(JSON.stringify(h.e)) as GenerationEnrollment;
  changed.identity.domains = ['work'];
  await expect(createGenerationStore(changed, h.owner, h.signer).select(good)).rejects.toThrow();
});

test('preserves a foreign current and an operation authorization substituted for the physical record', async () => {
  const h = signedOnlyFixture();
  const store = createGenerationStore(h.e, h.owner, h.signer);
  const signed = h.signed(store.order('install', null, 'one'));
  const pointer = join(h.root, 'current');
  writeFileSync(pointer, signed, { mode: 0o600 });
  const prior = node(pointer);
  await expect(store.select(signed)).rejects.toThrow();
  writeFileSync(join(h.root, 'history/install.json'), signed, { mode: 0o600 });
  await expect(store.observe()).rejects.toThrow();
  expect(node(pointer)).toEqual(prior);
  expect(readFileSync(pointer, 'utf8')).toBe(signed);
  renameSync(pointer, join(h.root, 'foreign-preserved'));
  await expect(store.select(h.signed(store.order('other', null, 'one')))).rejects.toThrow();
  expect(readdirSync(join(h.root, 'history'))).toEqual(['install.json']);
});

// The complete native release is supplied by the release-evidence job, independently
// of the selection signer. The portable refusal tests above require no native fixture.
const inputs: { archive: string; pins: string }[] = JSON.parse(process.env.PATRICK_GENERATION_TEST_RELEASES ?? '[]');
async function nativeHost() {
  expect(inputs).toHaveLength(2);
  const releases = inputs.map(input => JSON.parse(readFileSync(input.pins, 'utf8')) as Release);
  const h = host(releases);
  const stageRoot = directory(h.root, 'staging');
  const staging = { publication: { stagingRoot: stageRoot, releasesRoot: join(h.root, 'releases') },
    withExclusiveReadRoot: h.owner.withExclusiveReadRoot };
  for (const [index, release] of releases.entries()) {
    const digest = release.expected.packageSha256;
    const archive = join(h.root, 'packages', digest + '.json');
    cpSync(inputs[index].archive, archive);
    const receipt = await verifyEmittedRuntimeCandidate(archive, { ...release, staging });
    const staged = await stageVerifiedEmittedRuntime(receipt, { staging, destination: join(stageRoot, 'candidate') });
    await publishStagedDeployment(receipt, staged);
    addGeneration(h, index === 0 ? 'one' : 'two', digest, index + 1);
  }
  addGeneration(h, 'three', releases[1].expected.packageSha256, 2);
  return h;
}
test.skipIf(inputs.length === 0)('selects both real releases and data generations, reconciles loss and refuses replay', async () => {
  const h = await nativeHost();
  const store = createGenerationStore(h.e, h.owner, h.signer);
  const install = h.signed(store.order('install', null, 'one'));
  const first = await store.select(install);
  expect(first.current?.order.generation).toEqual(h.e.generations[0]);
  const pointer = join(h.root, 'current');
  const oldNode = node(pointer);
  expect(oldNode).toEqual(node(join(h.root, 'history/install.json')));
  await expect(store.select(h.signed(store.order('INSTALL', first.current!.sha256, 'two')))).rejects.toThrow();
  const upgrade = h.signed(store.order('upgrade', first.current!.sha256, 'two'));
  const rival = h.signed(store.order('rival', first.current!.sha256, 'two'));
  const lockFd = openSync(h.lock, 'wx', 0o600);
  try { await expect(store.select(upgrade)).rejects.toMatchObject({ code: 'EEXIST' }); }
  finally { closeSync(lockFd); unlinkSync(h.lock); }
  h.hooks.after = () => { throw Error('lost controller acknowledgement'); };
  await expect(store.select(upgrade)).rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'upgrade' });
  delete h.hooks.after;
  const newNode = node(pointer);
  expect(newNode).toEqual(node(join(h.root, 'history/upgrade.json')));
  expect(newNode).not.toEqual(oldNode);
  expect(node(join(h.root, 'history/install.json'))).toEqual(oldNode);
  const state = await store.observe('install');
  expect(state.current?.order.generation).toEqual(h.e.generations[1]);
  expect(state.historical).toEqual(first.current);
  expect(state.pending).toBeNull();
  for (const g of h.e.generations) {
    const db = new DatabaseSync(join(h.root, 'data', g.id, 'service.sqlite'), { readOnly: true });
    try { expect(db.prepare('select id from generation_marker').get()?.id).toBe(g.id); } finally { db.close(); }
  }
  await expect(store.select(rival)).rejects.toThrow();
  await expect(store.select(h.signed(store.order('back', state.current!.sha256, 'one')))).rejects.toThrow();
  expect(await store.select(install)).toEqual(state);
  expect((await store.select(upgrade)).current).toEqual(state.current);
  expect(node(pointer)).toEqual(newNode);
  const historyNames = readdirSync(join(h.root, 'history'));
  expect(historyNames.filter(name => name.endsWith('.json')).sort()).toEqual(['install.json', 'upgrade.json']);
  expect(historyNames.filter(name => name.endsWith('.durable'))).toHaveLength(2);

  // A fresh ordinary Node process gets a separately provisioned public registration,
  // read access only, and an inherited descriptor for the fixture parent's held lock.
  const enrollment = join(h.fixture, 'enrollment.json');
  writeFileSync(enrollment, JSON.stringify(h.e), { mode: 0o600 });
  const product = new URL('../../deploy/runtime/lifecycle-generation.ts', import.meta.url);
  const code = `
    import assert from 'node:assert/strict';
    import { fstatSync, lstatSync, readFileSync } from 'node:fs';
    import { createGenerationReader } from ${JSON.stringify(product.href)};
    const [registration, lock] = process.argv.slice(1);
    const e = JSON.parse(readFileSync(registration));
    const owner = { async withExclusiveReadRoot(read) {
      const validate = () => {
        const a = fstatSync(3, { bigint: true }), b = lstatSync(lock, { bigint: true });
        assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino);
      };
      validate(); try { return await read(e.root); } finally { validate(); }
    } };
    console.log(JSON.stringify(await createGenerationReader(e, owner).observe('install')));
  `;
  const fd = openSync(h.lock, 'wx', 0o600);
  try {
    const child = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--input-type=module',
      '-e', code, enrollment, h.lock], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd], cwd: dirname(fileURLToPath(product)) });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(state);
  } finally { closeSync(fd); unlinkSync(h.lock); }
  // A copied signed record stays foreign even if current and history are replaced together.
  const retainedRecord = join(h.root, 'history/upgrade.json');
  const originalRecord = join(h.fixture, 'original-history');
  const originalPointer = join(h.fixture, 'original-current');
  renameSync(retainedRecord, originalRecord);
  renameSync(pointer, originalPointer);
  cpSync(originalRecord, retainedRecord);
  linkSync(retainedRecord, pointer);
  await expect(store.observe()).rejects.toThrow('GENERATION_BINDING_INVALID');
  await expect(store.select(rival)).rejects.toThrow('GENERATION_BINDING_INVALID');
  expect(node(pointer)).toEqual(node(retainedRecord));
  unlinkSync(pointer);
  unlinkSync(retainedRecord);
  renameSync(originalRecord, retainedRecord);
  renameSync(originalPointer, pointer);
  // Lose acknowledgement of the actual durable history link before the pointer rename.
  const interrupted = h.signed(store.order('interrupted', state.current!.sha256, 'three'));
  const failSync = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { sign } from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import { createGenerationStore } from ${JSON.stringify(product.href)};
    const [registration, envelope, lock] = process.argv.slice(1);
    const e = JSON.parse(fs.readFileSync(registration));
    const sync = fs.fsyncSync;
    let lost = false;
    fs.fsyncSync = fd => {
      sync(fd);
      if (String(fs.fstatSync(fd, { bigint: true }).ino) === e.stores.history.inode) {
        lost = true; throw Error('acknowledgement lost after actual history fsync');
      }
    };
    syncBuiltinESMExports();
    const owner = { async withExclusiveReadRoot(read) {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { return await read(e.root); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    } };
    const key = fs.readFileSync(0);
    const signer = { async signRecord(bytes) { return sign(null, bytes, key).toString('base64'); } };
    await assert.rejects(createGenerationStore(e, owner, signer).select(envelope), { code: 'GENERATION_SELECTION_UNCERTAIN' });
    assert(lost);
  `;
  const interruptedProcess = spawnSync(process.execPath, ['--input-type=module', '-e', failSync, enrollment, interrupted, h.lock],
    { encoding: 'utf8', input: h.privateKey.export({ format: 'pem', type: 'pkcs8' }) });
  expect(interruptedProcess.status, interruptedProcess.stderr).toBe(0);
  const pending = await store.observe('interrupted');
  expect(pending.current).toEqual(state.current);
  expect(pending.historical).toBeNull();
  expect(pending.pending?.order.generation).toEqual(h.e.generations[2]);
  await expect(store.select(interrupted)).rejects.toThrow();
  expect(node(pointer)).toEqual(newNode);
  expect(node(join(h.root, '.selection-interrupted'))).toEqual(node(join(h.root, 'history/interrupted.json')));
  const dbPath = join(h.root, 'data/two/service.sqlite');
  renameSync(dbPath, dbPath + '.original');
  cpSync(dbPath + '.original', dbPath);
  await expect(store.observe()).rejects.toThrow();
  unlinkSync(dbPath);
  renameSync(dbPath + '.original', dbPath);
  const file = join(h.root, 'releases', h.e.generations[1].packageSha256, 'deploy/Caddyfile');
  writeFileSync(file, 'replacement');
  await expect(store.observe()).rejects.toThrow();
  expect(node(pointer)).toEqual(newNode);
  expect(node(join(h.root, 'history/install.json'))).toEqual(oldNode);
}, 180_000);


test.skipIf(inputs.length === 0).each(['owner-before-fsync', 'confirmation-before-history-fsync'] as const)(
  'reconciles a real rename across %s failure without repeating publication', async fault => {
  const h = await nativeHost();
  const store = createGenerationStore(h.e, h.owner, h.signer);
  const first = await store.select(h.signed(store.order('install', null, 'one')));
  const upgrade = h.signed(store.order('upgrade', first.current!.sha256, 'two'));
  const enrollment = join(h.fixture, 'enrollment.json');
  writeFileSync(enrollment, JSON.stringify(h.e), { mode: 0o600 });
  const product = new URL('../../deploy/runtime/lifecycle-generation.ts', import.meta.url).href;
  const writer = `
    import assert from 'node:assert/strict';
    import { sign } from 'node:crypto';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createGenerationStore } from ${JSON.stringify(product)};
    const [registration, lock, envelope, fault] = process.argv.slice(1);
    const e = JSON.parse(fs.readFileSync(registration));
    const key = fs.readFileSync(0);
    const owner = { async withExclusiveReadRoot(read) {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { return await read(e.root); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    } };
    const sync = fs.fsyncSync, rename = fs.renameSync, link = fs.linkSync;
    const counts = { renames: 0, links: 0, syncs: 0, signatures: 0 };
    let failed = false;
    fs.renameSync = (from, to) => { rename(from, to); if (to === e.root + '/current') counts.renames++; };
    fs.linkSync = (from, to) => { link(from, to); counts.links++; };
    fs.fsyncSync = fd => {
      counts.syncs++;
      const inode = String(fs.fstatSync(fd, { bigint: true }).ino);
      const ownerBarrier = fault === 'owner-before-fsync' && inode === e.rootNode.inode;
      const receiptBarrier = fault === 'confirmation-before-history-fsync' && inode === e.stores.history.inode && counts.links === 2;
      if (ownerBarrier || receiptBarrier) {
        assert.equal(counts.renames, 1);
        failed = true;
        throw Error('before actual ' + fault);
      }
      sync(fd);
    };
    syncBuiltinESMExports();
    const signer = { async signRecord(bytes) { counts.signatures++; return sign(null, bytes, key).toString('base64'); } };
    const store = createGenerationStore(e, owner, signer);
    await assert.rejects(store.select(envelope), { code: 'GENERATION_SELECTION_UNCERTAIN' });
    assert(failed);
    assert.equal(counts.renames, 1);
    const before = { ...counts };
    if (fault === 'owner-before-fsync') {
      await assert.rejects(store.select(envelope), { code: 'GENERATION_SELECTION_UNCERTAIN' });
    } else {
      const observed = await store.select(envelope);
      assert.equal(observed.pending, null);
      assert.equal(observed.current.order.operationId, 'upgrade');
    }
    assert.deepEqual(counts, before);
  `;
  const write = spawnSync(process.execPath, ['--input-type=module', '-e', writer, enrollment, h.lock, upgrade, fault],
    { encoding: 'utf8', input: h.privateKey.export({ format: 'pem', type: 'pkcs8' }) });
  expect(write.status, write.stderr).toBe(0);
  const pointer = join(h.root,'current');
  const visible = node(pointer);
  expect(visible).toEqual(node(join(h.root,'history/upgrade.json')));
  const read = `
    import assert from 'node:assert/strict';
    import { readFileSync, fstatSync, lstatSync } from 'node:fs';
    import { createGenerationReader } from ${JSON.stringify(product)};
    const [registration,lock] = process.argv.slice(1);
    const e = JSON.parse(readFileSync(registration));
    const owner = { async withExclusiveReadRoot(use) {
      const held = fstatSync(3,{bigint:true});
      const guard = () => {
        const named = lstatSync(lock,{bigint:true});
        assert.equal(named.ino,held.ino); assert.equal(named.dev,held.dev);
      };
      guard(); try { return await use(e.root); } finally { guard(); }
    } };
    console.log(JSON.stringify(await createGenerationReader(e,owner).observe('upgrade')));
  `;
  const fd = openSync(h.lock, 'wx', 0o600);
  try {
    const child = spawnSync(process.execPath, ['--permission','--allow-fs-read=*','--input-type=module','-e',read,enrollment,h.lock],
      {encoding:'utf8',stdio:['ignore','pipe','pipe',fd]});
    expect(child.status,child.stderr).toBe(0);
    const state = JSON.parse(child.stdout);
    expect(state.current.order.generation.id).toBe('two');
    if (fault === 'owner-before-fsync') {
      expect(state.pending?.sha256).toBe(state.current.sha256);
      expect(state.historical).toBeNull();
    } else {
      expect(state.pending).toBeNull();
      expect(state.historical).toEqual(state.current);
    }
  } finally { closeSync(fd); unlinkSync(h.lock); }
  const history = join(h.root, 'history');
  if (fault === 'confirmation-before-history-fsync') {
    // A valid visible confirmation proves the earlier pointer barrier. Its own
    // directory entry can still disappear; retain uncertainty if it does.
    const markers = readdirSync(history).filter(name => name.endsWith('.durable'));
    const oldName = markers.find(name => name.startsWith('install.'))!;
    const newName = markers.find(name => name.startsWith('upgrade.'))!;
    const marker = join(history, newName);
    expect(node(marker)).toEqual(visible);
    const held = join(h.fixture, 'held-confirmation');
    renameSync(marker, held);
    cpSync(held, marker);
    await expect(store.observe('upgrade')).rejects.toThrow();
    unlinkSync(marker);
    const crossed = join(history, oldName.replace('install.', 'upgrade.'));
    renameSync(held, crossed);
    await expect(store.observe('upgrade')).rejects.toThrow();
    unlinkSync(crossed);
  }
  const before = readdirSync(history).sort();
  await expect(store.select(upgrade)).rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'upgrade' });
  const uncertain = await store.observe('upgrade');
  expect(uncertain.pending?.sha256).toBe(uncertain.current?.sha256);
  expect(uncertain.historical).toBeNull();
  await expect(store.select(h.signed(store.order('later', uncertain.current!.sha256, 'three')))).rejects.toThrow();
  expect(readdirSync(history).sort()).toEqual(before);
  expect(node(pointer)).toEqual(visible);
}, 120_000);
