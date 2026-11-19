import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { openDatabase } from '../../packages/storage/src/database.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';

const io = vi.hoisted(() => ({
  scan: null as null | (() => Promise<void>),
  sample: null as null | (() => Promise<void>),
}));

vi.mock('../../packages/integrations/sources/directory.js', async (load) => {
  const actual = await load<typeof import('../../packages/integrations/sources/directory.js')>();
  return {
    ...actual,
    async listDirectory(...args: Parameters<typeof actual.listDirectory>) {
      const result = await actual.listDirectory(...args);
      const hold = io.scan; io.scan = null;
      if (hold) await hold();
      return result;
    },
    async scanDirectory(...args: Parameters<typeof actual.scanDirectory>) {
      const result = await actual.scanDirectory(...args);
      const hold = io.scan; io.scan = null;
      if (hold) await hold();
      return result;
    },
    async samplePath(...args: Parameters<typeof actual.samplePath>) {
      const sample = await actual.samplePath(...args);
      const hold = io.sample; io.sample = null;
      if (!hold) return sample;
      await hold();
      // A controlled placeholder result; the filesystem read and both connections remain real.
      return { ...sample, placeholder: true };
    },
  };
});

import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';

// Test-only bypass for legacy state-machine assertions; this is not an admitted production reader.
vi.mock('../../packages/integrations/sources/directory-capability.js', async (load) => {
  const actual = await load<typeof import('../../packages/integrations/sources/directory-capability.js')>();
  return { ...actual, assertDirectoryReaderAvailable: () => {} };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-s1a-status-'));
  const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot); writeFileSync(join(sourceRoot, 'demand.md'), 'A');
  const first = openDatabase(join(root, 'state.sqlite')); const second = openDatabase(join(root, 'state.sqlite'));
  const blobs = createBlobStore(join(root, 'blobs'));
  const slow = createSourceRegistry(first, { blobs }); const fast = createSourceRegistry(second, { blobs });
  const source = await slow.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: sourceRoot });
  await slow.collectSource(source.sourceId, 1);
  return { root, sourceRoot, first, second, slow, fast, source,
    close() { io.scan = null; io.sample = null; first.close(); second.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('an old offline scan cannot disable a source after a newer successful scan', async () => {
  const f = await fixture();
  const held = deferred(); const release = deferred();
  let pending: Promise<unknown> | undefined;
  try {
    renameSync(f.sourceRoot, f.sourceRoot + '-offline');
    io.scan = async () => { held.resolve(); await release.promise; };
    pending = f.slow.collectSource(f.source.sourceId, 1);
    await held.promise;
    renameSync(f.sourceRoot + '-offline', f.sourceRoot);
    expect(await f.fast.collectSource(f.source.sourceId, 1)).toMatchObject({ accepted: true, count: 0 });
    const receipts = f.second.prepare('SELECT * FROM collection_receipts').all();
    release.resolve();
    expect(await pending).toMatchObject({ accepted: false, reason: 'STALE_COLLECTION' });
    expect(f.first.prepare('SELECT status,enabled,config_revision FROM source_configs').get())
      .toEqual({ status: 'enabled', enabled: 1, config_revision: 1 });
    expect(f.first.prepare('SELECT * FROM collection_receipts').all()).toEqual(receipts);
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); f.close(); }
});

test('an old placeholder wake result cannot disable a source after a newer successful scan', async () => {
  const f = await fixture();
  const held = deferred(); const release = deferred();
  let pending: Promise<unknown> | undefined;
  try {
    io.sample = async () => { held.resolve(); await release.promise; };
    pending = f.slow.wakeDirectory(f.source.sourceId, 'demand.md');
    await held.promise;
    expect(await f.fast.collectSource(f.source.sourceId, 1)).toMatchObject({ accepted: true, count: 0 });
    release.resolve();
    expect(await pending).toMatchObject({ read: false, receipt: { accepted: false, reason: 'STALE_COLLECTION' } });
    expect(f.first.prepare('SELECT status,enabled,config_revision FROM source_configs').get())
      .toEqual({ status: 'enabled', enabled: 1, config_revision: 1 });
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); f.close(); }
});

test('a stale offline result does not overwrite an explicit newer pause', async () => {
  const f = await fixture();
  const held = deferred(); const release = deferred();
  let pending: Promise<unknown> | undefined;
  try {
    renameSync(f.sourceRoot, f.sourceRoot + '-offline');
    io.scan = async () => { held.resolve(); await release.promise; };
    pending = f.slow.collectSource(f.source.sourceId, 1);
    await held.promise;
    expect(await f.fast.pauseSource(f.source.sourceId)).toMatchObject({ accepted: true, kind: 'pause' });
    release.resolve();
    expect(await pending).toMatchObject({ accepted: false, reason: 'PAUSED' });
    expect(f.first.prepare('SELECT status,enabled,config_revision FROM source_configs').get())
      .toEqual({ status: 'paused', enabled: 0, config_revision: 2 });
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); f.close(); }
});
