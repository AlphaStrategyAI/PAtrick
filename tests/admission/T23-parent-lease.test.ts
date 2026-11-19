import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import * as emitted from '../../deploy/lib/emitted-release.mjs';
import type { ExclusiveRuntimeStaging } from '../../deploy/lib/emitted-release.mjs';

type Lease = { root: string; guard(): void };
type Runtime = { leased<T>(owner: ExclusiveRuntimeStaging, work: (lease: Lease) => Promise<T>, join?: boolean, validate?: () => void): Promise<T>;
  deriveRuntimeStaging?: (parent: Lease, root: string, publication?: { stagingRoot: string; releasesRoot: string }) => ExclusiveRuntimeStaging };
const runtime = emitted as unknown as Runtime;
const cleanups: string[] = [];
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }); });
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 20));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'patrick-parent-lease-'));
  cleanups.push(root);
  const child = join(root, 'child'), sibling = join(root, 'sibling');
  mkdirSync(child, { mode: 0o700 }); mkdirSync(sibling, { mode: 0o700 });
  return { root, child, sibling };
}
function borrow(parent: Lease, root: string, publication?: { stagingRoot: string; releasesRoot: string }) {
  if (runtime.deriveRuntimeStaging) return runtime.deriveRuntimeStaging(parent, root, publication);
  // The original implementation has no derived capability. This is the independently
  // reproduced borrowing pattern: it checks only before and after the awaited callback.
  return { publication, async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
    parent.guard(); try { return await read(root); } finally { parent.guard(); }
  } };
}

test.each(['sync', 'async', 'async-microtask', 'async-timer', 'throw', 'duplicate'] as const)(
  'a %s parent callback violation cannot authorize a later child step', async mode => {
    const { root, child } = fixture();
    let released = false, late = 0;
    const owner = { withExclusiveReadRoot<T>(read: (path: string) => Promise<T>): Promise<T> {
      expect(this).toBe(owner);
      const pending = read(root);
      pending.catch(() => {});
      if (mode === 'sync') { released = true; return undefined as unknown as Promise<T>; }
      if (mode === 'throw') { released = true; throw Error('owner exited'); }
      if (mode === 'duplicate') { void read(root).catch(() => {}); released = true; return Promise.resolve(undefined as T); }
      return (async () => {
        if (mode === 'async-microtask') await Promise.resolve();
        if (mode === 'async-timer') await new Promise(resolve => setTimeout(resolve, 2));
        released = true;
        return undefined as T;
      })();
    } };
    const result = runtime.leased(owner, async parent => {
      const childOwner = borrow(parent, child);
      await runtime.leased(childOwner, async inner => {
        inner.guard();
        await pause();
        inner.guard();
        if (released) late++;
      }, true);
    }, true);
    await expect(result).rejects.toThrow();
    expect(late).toBe(0);
  },
);

test.each(['sync', 'async', 'async-microtask'] as const)(
  'a %s early owner cannot release before a queued child microtask and permit a later effect', async mode => {
    const { root, child } = fixture();
    let released = false, late = 0;
    const owner = { withExclusiveReadRoot<T>(read: (path: string) => Promise<T>): Promise<T> {
      const pending = read(root); pending.catch(() => {});
      if (mode === 'sync') { released = true; return undefined as unknown as Promise<T>; }
      return (async () => {
        if (mode === 'async-microtask') await Promise.resolve();
        released = true;
        return undefined as T;
      })();
    } };
    const run = runtime.leased(owner, async parent => runtime.leased(borrow(parent, child), async inner => {
      inner.guard();
      await Promise.resolve();
      inner.guard();
      if (released) late++;
    }, true), true);
    await expect(run).rejects.toThrow();
    expect(late).toBe(0);
  },
);

test('only a live genuine parent can create a fixed child capability', async () => {
  const { root, child, sibling } = fixture();
  expect(runtime.deriveRuntimeStaging).toBeTypeOf('function');
  const fake: Lease = { root, guard() {} };
  expect(() => runtime.deriveRuntimeStaging!(fake, child)).toThrow();
  let saved!: ExclusiveRuntimeStaging;
  let parentLease!: Lease;
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return read(root); } };
  await runtime.leased(owner, async parent => {
    parentLease = parent;
    expect(Object.isFrozen(parent)).toBe(true);
    expect(Reflect.set(parent, 'root', sibling)).toBe(false);
    expect(Reflect.set(parent, 'guard', () => {})).toBe(false);
    expect(() => runtime.deriveRuntimeStaging!(Object.create(parent), child)).toThrow();
    expect(() => runtime.deriveRuntimeStaging!(parent, join(root, '..'))).toThrow();
    expect(() => runtime.deriveRuntimeStaging!(parent, join(root, 'missing'))).toThrow();
    const link = join(root, 'alias'); symlinkSync(sibling, link);
    expect(() => runtime.deriveRuntimeStaging!(parent, link)).toThrow();
    saved = runtime.deriveRuntimeStaging!(parent, child);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(await runtime.leased(saved, async lease => { lease.guard(); return lease.root; }, true)).toBe(child);
  }, true);
  expect(() => runtime.deriveRuntimeStaging!(parentLease, child)).toThrow();
  let called = false;
  await expect(runtime.leased(saved, async () => { called = true; }, true)).rejects.toThrow();
  expect(called).toBe(false);
});

test('publication roots are fixed, disjoint, canonical own data and never selected by getters', async () => {
  const { root, child, sibling } = fixture();
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return read(root); } };
  await runtime.leased(owner, async parent => {
    const publication = { stagingRoot: child, releasesRoot: sibling };
    const derived = borrow(parent, root, publication);
    expect(derived.publication).toEqual(publication);
    expect(Object.isFrozen(derived.publication)).toBe(true);
    expect(Reflect.set(derived.publication!, 'stagingRoot', root)).toBe(false);
    let calls = 0;
    const malicious = Object.defineProperty({ releasesRoot: sibling }, 'stagingRoot', { enumerable: true, get() { calls++; return child; } });
    expect(() => runtime.deriveRuntimeStaging!(parent, root, malicious as typeof publication)).toThrow();
    expect(() => runtime.deriveRuntimeStaging!(parent, root, { stagingRoot: child, releasesRoot: child })).toThrow();
    expect(() => runtime.deriveRuntimeStaging!(parent, child, { stagingRoot: sibling, releasesRoot: child })).toThrow();
    expect(calls).toBe(0);
    await runtime.leased(derived, async inner => { inner.guard(); }, true);
  }, true);
});

test('a borrowed owner cannot be rewrapped to strip its parent guard', async () => {
  const { root, child } = fixture();
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return read(root); } };
  await runtime.leased(owner, async parent => {
    const derived = borrow(parent, child);
    let calls = 0;
    const wrappers: ExclusiveRuntimeStaging[] = [
      { withExclusiveReadRoot: derived.withExclusiveReadRoot },
      { withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return derived.withExclusiveReadRoot(read); } },
      { withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return derived.withExclusiveReadRoot(path => read(path)); } },
    ];
    for (const wrapper of wrappers) await expect(runtime.leased(wrapper, async () => { calls++; }, true)).rejects.toThrow();
    await expect(derived.withExclusiveReadRoot(async () => { calls++; })).rejects.toThrow();
    expect(calls).toBe(0);
    await runtime.leased(derived, async lease => { lease.guard(); calls++; }, true);
    expect(calls).toBe(1);
  }, true);
});

test('keeps class owner method descriptors stable without executing a later getter', async () => {
  const { root } = fixture();
  let getterCalls = 0, rejected = false;
  class Owner { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { expect(this).toBe(owner); return read(root); } }
  const owner = new Owner();
  const method = Owner.prototype.withExclusiveReadRoot;
  const run = runtime.leased(owner, async parent => {
    Object.defineProperty(owner, 'withExclusiveReadRoot', { configurable: true, get() { getterCalls++; return method; } });
    try { parent.guard(); } catch { rejected = true; }
  }, true);
  await run.catch(() => {});
  expect(rejected).toBe(true);
  expect(getterCalls).toBe(0);
});

test('refuses a pre-existing owner accessor without executing it', async () => {
  const { root } = fixture();
  let getterCalls = 0;
  const owner = Object.defineProperty({}, 'withExclusiveReadRoot', { get() {
    getterCalls++; return async (read: (path: string) => Promise<unknown>) => read(root);
  } }) as ExclusiveRuntimeStaging;
  await expect(runtime.leased(owner, async () => {}, true)).rejects.toThrow();
  expect(getterCalls).toBe(0);
});

test('propagates an additional parent admission check through every derived guard', async () => {
  const { root } = fixture();
  let changed = false, rejected = false;
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return read(root); } };
  const run = runtime.leased(owner, async parent => {
    await runtime.leased(borrow(parent, root), async child => {
      changed = true;
      try { child.guard(); } catch { rejected = true; }
    }, true);
  }, true, () => { if (changed) throw Error('registration changed'); });
  await run.catch(() => {});
  expect(rejected).toBe(true);
});

test('a replacement child or publication boundary invalidates the derived capability', async () => {
  const { root, child, sibling } = fixture();
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return read(root); } };
  await runtime.leased(owner, async parent => {
    const narrow = borrow(parent, child);
    const publication = borrow(parent, root, { stagingRoot: child, releasesRoot: sibling });
    renameSync(child, join(root, 'old-child'));
    mkdirSync(child, { mode: 0o700 });
    let ran = false;
    await expect(runtime.leased(narrow, async () => { ran = true; }, true)).rejects.toThrow();
    await expect(runtime.leased(publication, async () => { ran = true; }, true)).rejects.toThrow();
    expect(ran).toBe(false);
  }, true);
});

test('a detected child replacement stays invalid even after the original inode is restored', async () => {
  const { root, child } = fixture();
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return read(root); } };
  await runtime.leased(owner, async parent => {
    const derived = borrow(parent, child);
    const prior = join(root, 'parked-child');
    renameSync(child, prior); mkdirSync(child, { mode: 0o700 });
    await expect(runtime.leased(derived, async () => {}, true)).rejects.toThrow();
    rmSync(child, { recursive: true }); renameSync(prior, child);
    let ran = false;
    await expect(runtime.leased(derived, async () => { ran = true; }, true)).rejects.toThrow();
    expect(ran).toBe(false);
  }, true);
});

test('a detected parent replacement stays invalid after the original inode is restored', async () => {
  const { root } = fixture();
  const prior = root + '-parked';
  cleanups.push(prior);
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return read(root); } };
  let firstRefused = false, secondRefused = false;
  const run = runtime.leased(owner, async parent => {
    renameSync(root, prior); mkdirSync(root, { mode: 0o700 });
    try { parent.guard(); } catch { firstRefused = true; }
    rmSync(root, { recursive: true }); renameSync(prior, root);
    try { parent.guard(); } catch { secondRefused = true; }
  }, true);
  await run.catch(() => {});
  expect(firstRefused).toBe(true);
  expect(secondRefused).toBe(true);
});

test('concurrent derived borrowers do not overlap under one parent lease', async () => {
  const { root, child } = fixture();
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) { return read(root); } };
  const entered = deferred(), leave = deferred();
  await runtime.leased(owner, async parent => {
    const first = borrow(parent, child), second = borrow(parent, child);
    const running = runtime.leased(first, async lease => { lease.guard(); entered.resolve(); await leave.promise; lease.guard(); }, true);
    await entered.promise;
    let rivalRan = false;
    try { await expect(runtime.leased(second, async () => { rivalRan = true; }, true)).rejects.toThrow(); }
    finally { leave.resolve(); }
    await running;
    expect(rivalRan).toBe(false);
  }, true);
});

test('an in-flight effect can finish but no second effect starts after parent invalidation', async () => {
  const { root, child } = fixture();
  const started = deferred(), resume = deferred();
  const first = join(child, 'first'), second = join(child, 'second');
  const owner = { async withExclusiveReadRoot<T>(read: (path: string) => Promise<T>) {
    const pending = read(root); pending.catch(() => {});
    await started.promise;
    resume.resolve();
    return undefined as T;
  } };
  const run = runtime.leased(owner, async parent => runtime.leased(borrow(parent, child), async inner => {
    inner.guard();
    writeFileSync(first, 'dispatched');
    started.resolve();
    await resume.promise;
    await pause();
    inner.guard();
    writeFileSync(second, 'must not start');
  }, true), true);
  await expect(run).rejects.toThrow();
  expect(existsSync(first)).toBe(true);
  expect(existsSync(second)).toBe(false);
});

const signedFixture = process.env.PATRICK_TEST_SIGNED_INSTALL_FIXTURE;
test.skipIf(!signedFixture).each(['fstat', 'short-read', 'directory', 'write-stat'] as const)(
  'stops a real signed fixture %s after observed parent invalidation', async scenario => {
  const { root, child } = fixture();
  const archive = join(child, 'signed-candidate.json');
  copyFileSync(join(signedFixture!, 'candidate.json'), archive);
  const module = new URL('../../deploy/lib/emitted-release.mjs', import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { createHash } from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import { basename, join } from 'node:path';
    const [root,tree,archive,scenario]=process.argv.slice(1);
    const target=join(root,'target');
    const signedBytes=fs.readFileSync(archive);
    let started,resume,released=false,armed=false,lateReads=0,lateStats=0,lateDirReads=0,lateWrites=0,closed=0,created;
    const entered=new Promise(resolve=>started=resolve), continuing=new Promise(resolve=>resume=resolve);
    const open=fs.promises.open, opendir=fs.promises.opendir;
    fs.promises.open=async function(path,...args){
      const handle=await Reflect.apply(open,this,[path,...args]);
      if(path===archive || (scenario==='write-stat' && basename(String(path)).startsWith('.candidate-'))){
        const stat=handle.stat, read=handle.read, write=handle.writeFile, close=handle.close;
        handle.close=async function(...values){closed++;return Reflect.apply(close,this,values);};
        handle.stat=async function(...values){
          if(released)lateStats++;
          const result=await Reflect.apply(stat,this,values);
          if(scenario==='fstat' && !armed){armed=true;started();await continuing;}
          return result;
        };
        handle.read=async function(buffer,offset,length,position){
          if(released)lateReads++;
          if(scenario==='short-read' && !armed){armed=true;const result=await Reflect.apply(read,this,[buffer,offset,Math.min(length,1),position]);started();await continuing;return result;}
          return Reflect.apply(read,this,[buffer,offset,length,position]);
        };
        handle.writeFile=async function(...values){if(released)lateWrites++;return Reflect.apply(write,this,values);};
        if(scenario==='write-stat' && path!==archive){created=String(path);armed=true;started();await continuing;}
      }
      return handle;
    };
    fs.promises.opendir=async function(path,...args){
      const dir=await Reflect.apply(opendir,this,[path,...args]);
      if(scenario==='directory' && path===tree){
        const read=dir.read, close=dir.close, make=dir[Symbol.asyncIterator];
        dir.read=async function(...values){if(released)lateDirReads++;return Reflect.apply(read,this,values);};
        dir.close=async function(...values){closed++;return Reflect.apply(close,this,values);};
        Object.defineProperty(dir,Symbol.asyncIterator,{value(){const iterator=Reflect.apply(make,dir,[]);return {
          async next(){if(released)lateDirReads++;return iterator.next();},
          async return(){return iterator.return?iterator.return():{done:true};}
        };}});
        armed=true;started();await continuing;
      }
      return dir;
    };
    syncBuiltinESMExports();
    const {leased,deriveRuntimeStaging,readLeased,readTree,publishPackage}=await import(${JSON.stringify(module)});
    const owner={async withExclusiveReadRoot(read){const pending=read(root);pending.catch(()=>{});await entered;released=true;setImmediate(resume);}};
    let failure, writeFailure;
    try { await leased(owner,async parent=>{
      const staging=deriveRuntimeStaging(parent,root);
      if(scenario==='write-stat'){
        try{await publishPackage(staging,target,signedBytes,createHash('sha256').update(signedBytes).digest('hex'));}
        catch(error){writeFailure=error.code;throw error;}
      } else await leased(staging,async child=>{
        if(scenario==='directory')await readTree(child,tree);
        else await readLeased(child,archive,signedBytes.length+1);
      },true);
    },true); } catch(error){failure=error.message;}
    const evidence={scenario,released,armed,lateReads,lateStats,lateDirReads,lateWrites,closed,writeFailure,
      preserved:!!created&&fs.existsSync(created),failure};
    console.log(JSON.stringify(evidence));
    assert(released && armed && failure);
    assert.equal(lateReads,0);assert.equal(lateStats,0);assert.equal(lateDirReads,0);assert.equal(lateWrites,0);
    assert.equal(closed,1);
    if(scenario==='write-stat'){assert.equal(writeFailure,'EMITTED_WRITE_UNCERTAIN');assert(evidence.preserved);}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, root, child, archive, scenario],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 90_000);

test.skipIf(!signedFixture)('does not inspect a signed material tree after owner exits during directory EOF', () => {
  const { root, child } = fixture();
  const pins = JSON.parse(readFileSync(join(signedFixture!, 'fixture-pins.json'), 'utf8')) as { expected: { packageSha256: string } };
  copyFileSync(join(signedFixture!, 'releases', pins.expected.packageSha256, 'deploy', 'Caddyfile'), join(child, 'Caddyfile'));
  const module = new URL('../../deploy/lib/emitted-release.mjs', import.meta.url).href;
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [root,tree]=process.argv.slice(1);
    let start,resume,released=false,armed=false,lateTreeStats=0,closed=0;
    const entered=new Promise(resolve=>start=resolve),continuing=new Promise(resolve=>resume=resolve);
    const opendir=fs.promises.opendir,lstat=fs.lstatSync;
    fs.lstatSync=function(path,...args){if(released && path===tree)lateTreeStats++;return Reflect.apply(lstat,this,[path,...args]);};
    fs.promises.opendir=async function(path,...args){
      const dir=await Reflect.apply(opendir,this,[path,...args]);
      if(path===tree){
        const read=dir.read,close=dir.close,make=dir[Symbol.asyncIterator];
        dir.close=async function(...values){closed++;return Reflect.apply(close,this,values);};
        dir.read=async function(...values){const item=await Reflect.apply(read,this,values);
          if(item===null && !armed){armed=true;start();await continuing;}return item;};
        Object.defineProperty(dir,Symbol.asyncIterator,{value(){const iterator=Reflect.apply(make,dir,[]);return {
          async next(){const result=await iterator.next();if(result.done&&!armed){armed=true;start();await continuing;}return result;},
          async return(){return iterator.return?iterator.return():{done:true};}
        };}});
      }
      return dir;
    };
    syncBuiltinESMExports();
    const {leased,deriveRuntimeStaging,readTree}=await import(${JSON.stringify(module)});
    const owner={async withExclusiveReadRoot(read){const pending=read(root);pending.catch(()=>{});await entered;released=true;setImmediate(resume);}};
    let failure;
    try{await leased(owner,async parent=>leased(deriveRuntimeStaging(parent,root),async child=>readTree(child,tree),true),true);}
    catch(error){failure=error.message;}
    console.log(JSON.stringify({released,armed,lateTreeStats,closed,failure}));
    assert(released && armed && failure);assert.equal(lateTreeStats,0);assert.equal(closed,1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, root, child],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 90_000);
