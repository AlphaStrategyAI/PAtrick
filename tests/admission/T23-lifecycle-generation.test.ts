import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { closeSync, cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { canonicalize } from '../../deploy/lib/release.mjs';
import { deriveRuntimeStaging, leased, publishStagedDeployment, stageVerifiedEmittedRuntime, verifyEmittedRuntimeCandidate } from '../../deploy/lib/emitted-release.mjs';
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

test('refuses pre-existing owner and signer accessors without invoking them', () => {
  const h = host();
  let calls = 0;
  const owner = Object.defineProperty({}, 'withExclusiveReadRoot', { get() { calls++; return h.owner.withExclusiveReadRoot; } });
  const signer = Object.defineProperty({}, 'signRecord', { get() { calls++; return h.signer.signRecord; } });
  expect(() => createGenerationReader(h.e, owner as ExclusiveRuntimeStaging)).toThrow();
  expect(() => createGenerationStore(h.e, h.owner, signer as typeof h.signer)).toThrow();
  expect(calls).toBe(0);
});

test('refuses a changed owner prototype even when the old method is still inherited', async () => {
  const h = host();
  class Owner {
    async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
      Object.setPrototypeOf(this, Object.create(Owner.prototype));
      return Reflect.apply(h.owner.withExclusiveReadRoot<T>, h.owner, [read]);
    }
  }
  await expect(createGenerationReader(h.e, new Owner()).observe()).rejects.toThrow();
  expect(readdirSync(join(h.root, 'history'))).toEqual([]);
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

test.skipIf(inputs.length === 0)('reads a completed signed generation through its genuine recursive derived owner', async () => {
  const h = await nativeHost();
  const store = createGenerationStore(h.e, h.owner, h.signer);
  await store.select(h.signed(store.order('install', null, 'one')));
  let expired!: ExclusiveRuntimeStaging;
  await leased(h.owner, async parent => {
    const child = deriveRuntimeStaging(parent, h.root);
    expired = child;
    const state = await createGenerationReader(h.e, child).observe('install');
    expect(state.current?.order.operationId).toBe('install');
    expect(state.pending).toBeNull();
    await leased(child, async nested => {
      const grandchild = deriveRuntimeStaging(nested, h.root);
      expect((await createGenerationReader(h.e, grandchild).observe('install')).current).toEqual(state.current);
    }, true);
    const forged = { withExclusiveReadRoot: child.withExclusiveReadRoot };
    await expect(createGenerationReader(h.e, forged).observe('install')).rejects.toThrow();
    const unrelated = host();
    await expect(createGenerationReader(unrelated.e, child).observe()).rejects.toThrow();
  }, true);
  await expect(createGenerationReader(h.e, expired).observe('install')).rejects.toThrow();
}, 120_000);

test.skipIf(inputs.length === 0)('keeps a genuine derived selection uncertain when a class signer drifts', async () => {
  const h = await nativeHost();
  let getterCalls = 0, signatures = 0;
  class Signer {
    async signRecord(bytes: Uint8Array) {
      expect(this).toBe(signer);
      signatures++;
      const original = Signer.prototype.signRecord;
      Object.defineProperty(this, 'signRecord', { configurable: true, get() { getterCalls++; return original; } });
      return h.signer.signRecord(bytes);
    }
  }
  const signer = new Signer();
  await leased(h.owner, async parent => {
    const derived = deriveRuntimeStaging(parent, h.root);
    const store = createGenerationStore(h.e, derived, signer);
    const envelope = h.signed(store.order('install', null, 'one'));
    await expect(store.select(envelope)).rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'install' });
    expect(signatures).toBe(1);
    expect(getterCalls).toBe(0);
    expect(lstatSync(join(h.root, '.selection-install')).size).toBe(0);
    expect(readdirSync(join(h.root, 'history'))).toEqual([]);
  }, true);
}, 120_000);

test.skipIf(inputs.length === 0)('stops the real generation release verifier when its parent owner returns early', async () => {
  const h = await nativeHost();
  const store = createGenerationStore(h.e, h.owner, h.signer);
  await store.select(h.signed(store.order('initial', null, 'one')));
  const module = pathToFileURL(fileURLToPath(new URL('../../deploy/runtime/lifecycle-generation.ts', import.meta.url))).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const e=JSON.parse(process.argv[1]);
    const archive=join(e.root,'packages',e.generations[0].packageSha256+'.json');
    let start, resume, released=false, lateReads=0, opens=0;
    const entered=new Promise(resolve=>start=resolve);
    const continuing=new Promise(resolve=>resume=resolve);
    const original=fs.promises.open;
    fs.promises.open=async function(path,...args) {
      const handle=await Reflect.apply(original,this,[path,...args]);
      if(path===archive && ++opens===1) {
        const read=handle.read;
        handle.read=async function(...values){if(released) lateReads++;return Reflect.apply(read,this,values);};
        start(); await continuing;
      }
      return handle;
    };
    syncBuiltinESMExports();
    const {createGenerationReader}=await import(${JSON.stringify(module)});
    const owner={async withExclusiveReadRoot(read){const pending=read(e.root);pending.catch(()=>{});await entered;released=true;setImmediate(resume);}};
    await assert.rejects(createGenerationReader(e,owner).observe());
    assert.equal(opens,1);
    assert.equal(lateReads,0);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(h.e)],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}, 120_000);

test.skipIf(inputs.length === 0)('stops generation file writes when the owner exits during a signed history read', async () => {
  const h = await nativeHost();
  const store = createGenerationStore(h.e, h.owner, h.signer);
  const initial = await store.select(h.signed(store.order('initial', null, 'one')));
  const upgrade = h.signed(store.order('upgrade', initial.current!.sha256, 'two'));
  const rival = h.signed(store.order('rival', initial.current!.sha256, 'three'));
  const privateKey = h.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const module = pathToFileURL(fileURLToPath(new URL('../../deploy/runtime/lifecycle-generation.ts', import.meta.url))).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { sign } from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const e=JSON.parse(process.argv[1]), envelope=process.argv[2], key=process.argv[3], rival=process.argv[4];
    const record=join(e.root,'history','initial.json');
    let start, resume, armed=false, intercepted=false, released=false, lateWrites=0;
    const entered=new Promise(resolve=>start=resolve);
    const continuing=new Promise(resolve=>resume=resolve);
    const originalOpen=fs.promises.open, originalWrite=fs.writeFileSync;
    fs.promises.open=async function(path,...args) {
      const handle=await Reflect.apply(originalOpen,this,[path,...args]);
      if(path===record && armed && !intercepted) {
        intercepted=true;
        const close=handle.close;
        handle.close=async function(...values){const result=await Reflect.apply(close,this,values);start();await continuing;return result;};
      }
      return handle;
    };
    fs.writeFileSync=function(...args){if(armed && released) lateWrites++;return Reflect.apply(originalWrite,this,args);};
    syncBuiltinESMExports();
    const {createGenerationStore,createGenerationReader}=await import(${JSON.stringify(module)});
    const owner={async withExclusiveReadRoot(read){const pending=read(e.root);pending.catch(()=>{});await entered;released=true;setImmediate(resume);}};
    const signer={async signRecord(bytes){armed=true;return sign(null,bytes,key).toString('base64');}};
    const failure=await createGenerationStore(e,owner,signer).select(envelope).catch(error=>error);
    assert(intercepted && released);
    assert.equal(lateWrites,0);
    assert.equal(failure.code,'GENERATION_SELECTION_UNCERTAIN');
    const scratch=join(e.root,'.selection-upgrade');
    const before=fs.lstatSync(scratch,{bigint:true});
    assert.equal(before.size,0n);
    const owner2={async withExclusiveReadRoot(read){return await read(e.root);}};
    const readback=await createGenerationReader(e,owner2).observe('upgrade').catch(error=>error);
    assert.equal(readback.code,'GENERATION_SELECTION_UNCERTAIN');
    const repeated=await createGenerationStore(e,owner2,signer).select(envelope).catch(error=>error);
    assert.equal(repeated.code,'GENERATION_SELECTION_UNCERTAIN');
    const competing=await createGenerationStore(e,owner2,signer).select(rival).catch(error=>error);
    assert.equal(competing.code,'GENERATION_SELECTION_UNCERTAIN');
    assert.equal(competing.operationId,'upgrade');
    const global=await createGenerationReader(e,owner2).observe().catch(error=>error);
    assert.equal(global.code,'GENERATION_SELECTION_UNCERTAIN');
    assert.equal(global.operationId,'upgrade');
    const after=fs.lstatSync(scratch,{bigint:true});
    assert.equal(after.ino,before.ino);assert.equal(after.size,before.size);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(h.e), upgrade, privateKey, rival],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const readback = `
    import assert from 'node:assert/strict';
    import { fstatSync, lstatSync } from 'node:fs';
    import { createGenerationReader } from ${JSON.stringify(module)};
    const e=JSON.parse(process.argv[1]), lock=process.argv[2];
    const owner={async withExclusiveReadRoot(read){
      const check=()=>{const a=fstatSync(3,{bigint:true}),b=lstatSync(lock,{bigint:true});
        assert.equal(a.dev,b.dev);assert.equal(a.ino,b.ino);};
      check();try{return await read(e.root);}finally{check();}
    }};
    const reader=createGenerationReader(e,owner);
    await assert.rejects(reader.observe('upgrade'),{code:'GENERATION_SELECTION_UNCERTAIN',operationId:'upgrade'});
    await assert.rejects(reader.observe(),{code:'GENERATION_SELECTION_UNCERTAIN',operationId:'upgrade'});
    process.stdout.write('public-only uncertain');
  `;
  const fd = openSync(h.lock, 'wx', 0o600);
  try {
    const child = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--input-type=module', '-e', readback,
      JSON.stringify(h.e), h.lock], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 60_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('public-only uncertain');
    expect(lstatSync(join(h.root, '.selection-upgrade')).size).toBe(0);
  } finally { closeSync(fd); unlinkSync(h.lock); }
}, 120_000);

test.skipIf(inputs.length === 0).each(['file', 'directory', 'symlink'] as const)(
  'preserves a foreign %s at the reserved selection scratch name', async kind => {
  const h = await nativeHost();
  const bootstrap = createGenerationStore(h.e, h.owner, h.signer);
  const first = await bootstrap.select(h.signed(bootstrap.order('initial', null, 'one')));
  const scratch = join(h.root, '.selection-foreign');
  const sentinel = join(h.fixture, 'foreign-sentinel');
  writeFileSync(sentinel, 'outside-content', { mode: 0o600 });
  if (kind === 'file') writeFileSync(scratch, 'foreign-content', { mode: 0o600 });
  if (kind === 'directory') { mkdirSync(scratch, { mode: 0o700 }); writeFileSync(join(scratch, 'sentinel'), 'directory-content'); }
  if (kind === 'symlink') symlinkSync(sentinel, scratch);
  const before = lstatSync(scratch, { bigint: true });
  const history = readdirSync(join(h.root, 'history')).sort();
  let signatures = 0;
  const signer = { async signRecord(bytes: Uint8Array) { signatures++; return h.signer.signRecord(bytes); } };
  const store = createGenerationStore(h.e, h.owner, signer);
  const reader = createGenerationReader(h.e, h.owner);
  await expect(reader.observe('foreign')).rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'foreign' });
  await expect(reader.observe()).rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'foreign' });
  for (const id of ['foreign', 'other']) {
    await expect(store.select(h.signed(store.order(id, first.current!.sha256, 'two'))))
      .rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'foreign' });
  }
  const after = lstatSync(scratch, { bigint: true });
  expect([after.dev, after.ino, after.mode, after.size]).toEqual([before.dev, before.ino, before.mode, before.size]);
  if (kind === 'file') expect(readFileSync(scratch, 'utf8')).toBe('foreign-content');
  if (kind === 'directory') expect(readFileSync(join(scratch, 'sentinel'), 'utf8')).toBe('directory-content');
  if (kind === 'symlink') expect(readlinkSync(scratch)).toBe(sentinel);
  expect(readFileSync(sentinel, 'utf8')).toBe('outside-content');
  expect(readdirSync(join(h.root, 'history')).sort()).toEqual(history);
  expect(signatures).toBe(0);
}, 120_000);

test.skipIf(inputs.length === 0)('preserves both inodes when an owned selection scratch is replaced during signing', async () => {
  const h = await nativeHost();
  const bootstrap = createGenerationStore(h.e, h.owner, h.signer);
  const first = await bootstrap.select(h.signed(bootstrap.order('initial', null, 'one')));
  const scratch = join(h.root, '.selection-upgrade');
  const retained = join(h.fixture, 'retained-original-scratch');
  let original: ReturnType<typeof node> | undefined;
  let signatures = 0;
  const signer = { async signRecord(bytes: Uint8Array) {
    signatures++;
    original = node(scratch);
    renameSync(scratch, retained);
    writeFileSync(scratch, 'foreign-replacement', { mode: 0o600 });
    return h.signer.signRecord(bytes);
  } };
  const store = createGenerationStore(h.e, h.owner, signer);
  const envelope = h.signed(store.order('upgrade', first.current!.sha256, 'two'));
  const history = readdirSync(join(h.root, 'history')).sort();
  await expect(store.select(envelope)).rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'upgrade' });
  expect(signatures).toBe(1);
  expect(node(retained)).toEqual(original);
  expect(lstatSync(retained).size).toBe(0);
  const foreign = node(scratch);
  expect(foreign).not.toEqual(original);
  expect(readFileSync(scratch, 'utf8')).toBe('foreign-replacement');
  await expect(createGenerationReader(h.e, h.owner).observe('upgrade'))
    .rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'upgrade' });
  await expect(store.select(envelope)).rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'upgrade' });
  await expect(store.select(h.signed(store.order('other', first.current!.sha256, 'three'))))
    .rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'upgrade' });
  expect(signatures).toBe(1);
  expect(node(scratch)).toEqual(foreign);
  expect(node(retained)).toEqual(original);
  expect(readFileSync(scratch, 'utf8')).toBe('foreign-replacement');
  expect(lstatSync(retained).size).toBe(0);
  expect(readdirSync(join(h.root, 'history')).sort()).toEqual(history);
}, 120_000);

test.skipIf(inputs.length === 0).each(['signer-instance', 'signer-prototype', 'owner-instance', 'owner-prototype'] as const)(
  'rejects a class-backed %s accessor installed during a real signature', async kind => {
  const h = await nativeHost();
  let getterCalls = 0, signatures = 0;
  class Owner {
    async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
      expect(this).toBe(owner);
      return Reflect.apply(h.owner.withExclusiveReadRoot<T>, h.owner, [read]);
    }
  }
  class Signer {
    async signRecord(bytes: Uint8Array) {
      expect(this).toBe(signer);
      signatures++;
      const object = kind.startsWith('owner') ? (kind.endsWith('instance') ? owner : Owner.prototype)
        : (kind.endsWith('instance') ? signer : Signer.prototype);
      const key = kind.startsWith('owner') ? 'withExclusiveReadRoot' : 'signRecord';
      const original = kind.startsWith('owner') ? Owner.prototype.withExclusiveReadRoot : Signer.prototype.signRecord;
      Object.defineProperty(object, key, { configurable: true, get() { getterCalls++; return original; } });
      return h.signer.signRecord(bytes);
    }
  }
  const owner = new Owner(), signer = new Signer();
  const store = createGenerationStore(h.e, owner, signer);
  const envelope = h.signed(store.order('install', null, 'one'));
  await expect(store.select(envelope)).rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'install' });
  expect(signatures).toBe(1);
  expect(getterCalls).toBe(0);
  expect(readdirSync(join(h.root, 'history'))).toEqual([]);
  const scratch = join(h.root, '.selection-install');
  const before = node(scratch);
  expect(lstatSync(scratch).size).toBe(0);
  await expect(createGenerationReader(h.e, h.owner).observe('install'))
    .rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'install' });
  await expect(store.select(envelope)).rejects.toThrow();
  expect(getterCalls).toBe(0);
  expect(node(scratch)).toEqual(before);
  expect(lstatSync(scratch).size).toBe(0);
  expect(readdirSync(join(h.root, 'history'))).toEqual([]);
}, 120_000);

test.skipIf(inputs.length === 0)('retains the original class owner and signer receivers for a real selection', async () => {
  const h = await nativeHost();
  let ownerCalls = 0, signatures = 0;
  class Owner {
    async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
      expect(this).toBe(owner); ownerCalls++;
      return Reflect.apply(h.owner.withExclusiveReadRoot<T>, h.owner, [read]);
    }
  }
  class Signer {
    async signRecord(bytes: Uint8Array) { expect(this).toBe(signer); signatures++; return h.signer.signRecord(bytes); }
  }
  for (const method of [Owner.prototype.withExclusiveReadRoot, Signer.prototype.signRecord]) {
    for (const key of ['call', 'bind']) Object.defineProperty(method, key, { get() { throw Error('callable metadata accessed'); } });
  }
  const owner = new Owner(), signer = new Signer();
  const store = createGenerationStore(h.e, owner, signer);
  const result = await store.select(h.signed(store.order('install', null, 'one')));
  expect(result.current?.order.operationId).toBe('install');
  expect(result.pending).toBeNull();
  expect(ownerCalls).toBeGreaterThan(0);
  expect(signatures).toBe(2);
}, 120_000);

test.skipIf(inputs.length === 0).each(['owner', 'signer'] as const)(
  'preserves a pending visible selection when class %s changes during completion signing', async kind => {
  const h = await nativeHost();
  let getters = 0, signatures = 0;
  class Owner {
    async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
      expect(this).toBe(owner);
      return Reflect.apply(h.owner.withExclusiveReadRoot<T>, h.owner, [read]);
    }
  }
  class Signer {
    async signRecord(bytes: Uint8Array) {
      expect(this).toBe(signer);
      signatures++;
      if (signatures === 2) {
        const target = kind === 'owner' ? owner : signer;
        const key = kind === 'owner' ? 'withExclusiveReadRoot' : 'signRecord';
        const original = kind === 'owner' ? Owner.prototype.withExclusiveReadRoot : Signer.prototype.signRecord;
        Object.defineProperty(target, key, { configurable: true, get() { getters++; return original; } });
      }
      return h.signer.signRecord(bytes);
    }
  }
  const owner = new Owner(), signer = new Signer();
  const store = createGenerationStore(h.e, owner, signer);
  const envelope = h.signed(store.order('install', null, 'one'));
  await expect(store.select(envelope)).rejects.toMatchObject({ code: 'GENERATION_SELECTION_UNCERTAIN', operationId: 'install' });
  expect(signatures).toBe(2);
  expect(getters).toBe(0);
  const history = readdirSync(join(h.root, 'history')).sort();
  expect(history).toEqual(['install.json']);
  const current = node(join(h.root, 'current'));
  const observed = await createGenerationReader(h.e, h.owner).observe('install');
  expect(observed.current?.order.operationId).toBe('install');
  expect(observed.pending?.order.operationId).toBe('install');
  await expect(store.select(envelope)).rejects.toThrow();
  expect(signatures).toBe(2);
  expect(getters).toBe(0);
  expect(node(join(h.root, 'current'))).toEqual(current);
  expect(readdirSync(join(h.root, 'history')).sort()).toEqual(history);
}, 120_000);

test.skipIf(inputs.length === 0)('keeps a created scratch uncertain when open acknowledgement is lost', async () => {
  const h = await nativeHost();
  const store = createGenerationStore(h.e, h.owner, h.signer);
  const first = await store.select(h.signed(store.order('initial', null, 'one')));
  const envelope = h.signed(store.order('upgrade', first.current!.sha256, 'two'));
  const module = pathToFileURL(fileURLToPath(new URL('../../deploy/runtime/lifecycle-generation.ts', import.meta.url))).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const e=JSON.parse(process.argv[1]), envelope=process.argv[2], lock=process.argv[3];
    const scratch=join(e.root,'.selection-upgrade');
    const open=fs.openSync;
    let attempts=0, signatures=0;
    fs.openSync=function(path,...args){
      const fd=Reflect.apply(open,this,[path,...args]);
      if(path===scratch){attempts++;fs.closeSync(fd);throw Error('lost acknowledgement after actual exclusive create');}
      return fd;
    };
    syncBuiltinESMExports();
    const {createGenerationStore,createGenerationReader}=await import(${JSON.stringify(module)});
    const owner={async withExclusiveReadRoot(read){const fd=fs.openSync(lock,'wx',0o600);
      try{return await read(e.root);}finally{fs.closeSync(fd);fs.unlinkSync(lock);}}};
    const signer={async signRecord(){signatures++;throw Error('must not sign');}};
    const store=createGenerationStore(e,owner,signer);
    await assert.rejects(store.select(envelope),{code:'GENERATION_SELECTION_UNCERTAIN',operationId:'upgrade'});
    const before=fs.lstatSync(scratch,{bigint:true});
    assert.equal(before.size,0n);
    await assert.rejects(createGenerationReader(e,owner).observe('upgrade'),{code:'GENERATION_SELECTION_UNCERTAIN',operationId:'upgrade'});
    await assert.rejects(store.select(envelope),{code:'GENERATION_SELECTION_UNCERTAIN',operationId:'upgrade'});
    const after=fs.lstatSync(scratch,{bigint:true});
    assert.equal(after.ino,before.ino);assert.equal(after.size,before.size);
    assert.equal(attempts,1);assert.equal(signatures,0);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(h.e), envelope, h.lock],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}, 120_000);

test.skipIf(inputs.length === 0).each(['visible', 'completion'] as const)(
  'stops generation %s processing when the parent exits during history read', async phase => {
  const h = await nativeHost();
  const store = createGenerationStore(h.e, h.owner, h.signer);
  const first = await store.select(h.signed(store.order('initial', null, 'one')));
  const envelope = h.signed(store.order('upgrade', first.current!.sha256, 'two'));
  const privateKey = h.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const module = pathToFileURL(fileURLToPath(new URL('../../deploy/runtime/lifecycle-generation.ts', import.meta.url))).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { sign } from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const e=JSON.parse(process.argv[1]), envelope=process.argv[2], key=process.argv[3], phase=process.argv[4];
    const record=join(e.root,'history','upgrade.json'), current=join(e.root,'current');
    let start,resume,released=false,renamed=false,intercepted=false,signatures=0,lateSignatures=0,lateReads=0,lateLinks=0;
    const entered=new Promise(resolve=>start=resolve), continuing=new Promise(resolve=>resume=resolve);
    const originalOpen=fs.promises.open, originalRename=fs.renameSync, originalLstat=fs.lstatSync, originalLink=fs.linkSync;
    fs.promises.open=async function(path,...args){
      const handle=await Reflect.apply(originalOpen,this,[path,...args]);
      if(path===record && !intercepted && renamed && signatures===(phase==='visible'?1:2)){
        intercepted=true;
        const close=handle.close;
        handle.close=async function(...values){const result=await Reflect.apply(close,this,values);start();await continuing;return result;};
      }
      return handle;
    };
    fs.renameSync=function(from,to){const result=Reflect.apply(originalRename,this,[from,to]);if(to===current)renamed=true;return result;};
    fs.lstatSync=function(path,...args){if(released && path===current)lateReads++;return Reflect.apply(originalLstat,this,[path,...args]);};
    fs.linkSync=function(from,to){if(released && String(to).endsWith('.durable'))lateLinks++;return Reflect.apply(originalLink,this,[from,to]);};
    syncBuiltinESMExports();
    const {createGenerationStore,createGenerationReader}=await import(${JSON.stringify(module)});
    const owner={async withExclusiveReadRoot(read){const pending=read(e.root);pending.catch(()=>{});await entered;released=true;setImmediate(resume);}};
    const signer={async signRecord(bytes){if(released)lateSignatures++;signatures++;return sign(null,bytes,key).toString('base64');}};
    const failure=await createGenerationStore(e,owner,signer).select(envelope).catch(error=>error);
    assert(intercepted && released && renamed);
    assert.equal(failure.code,'GENERATION_SELECTION_UNCERTAIN');
    assert.equal(lateSignatures,0);assert.equal(lateReads,0);assert.equal(lateLinks,0);
    assert.equal(signatures,phase==='visible'?1:2);
    fs.lstatSync=originalLstat;syncBuiltinESMExports();
    const owner2={async withExclusiveReadRoot(read){return await read(e.root);}};
    const reader=createGenerationReader(e,owner2);
    const observed=await reader.observe('upgrade');
    assert.equal(observed.current.order.operationId,'upgrade');
    assert.equal(observed.pending.order.operationId,'upgrade');
    const before=fs.readdirSync(join(e.root,'history')).sort();
    await assert.rejects(createGenerationStore(e,owner2,signer).select(envelope),{code:'GENERATION_SELECTION_UNCERTAIN',operationId:'upgrade'});
    assert.deepEqual(fs.readdirSync(join(e.root,'history')).sort(),before);
    assert.equal(signatures,phase==='visible'?1:2);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(h.e), envelope, privateKey, phase],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}, 120_000);

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
