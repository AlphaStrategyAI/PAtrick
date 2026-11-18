import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createBlobStore, openDatabase, type MigrationEntry } from '@patrick/storage';
import { createHttpCollectionWorker } from '../../apps/service/src/source-collection.js';
import { createSourceRegistry, type SourceDraft } from '../../packages/integrations/sources/registry.js';

const url = 'https://feed.example.test/news';
const principal = { accountId: 'owner', dataDomain: 'personal' };
const feedDraft: SourceDraft = { type: 'rss', target: url };
const payload = new TextEncoder().encode('<rss><channel><item><guid>post-1</guid><title>First item</title><link>/article</link></item></channel></rss>');
const secondPayload = new TextEncoder().encode('<rss><channel><item><guid>post-1</guid><title>First item</title><link>/article</link></item><item><guid>post-2</guid><title>New item</title></item></channel></rss>');
const response = { status: 200, location: null, contentType: 'application/rss+xml', bytes: payload };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t18-registry-'));
  const migrations = new URL('../../packages/storage/migrations/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', migrations), 'utf8')) as MigrationEntry[];
  const path = join(dir, 'source.sqlite');
  const db = openDatabase(path, { manifest });
  const blobs = createBlobStore(join(dir, 'blobs'));
  const request = vi.fn(async () => response);
  const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  const registry = createSourceRegistry(db, { blobs, http: {
    approvedUrls(owner, origin) { return owner.accountId === principal.accountId && owner.dataDomain === principal.dataDomain && origin === url ? [url] : null; },
    port: { request, resolve },
  } });
  return { db, registry, request, resolve, blobs, path, manifest, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('preview, enable and first successful RSS collection are independent; duplicates share the original source', async () => {
  const fx = setup();
  try {
    await expect(fx.registry.detectSource({ ...principal, dataDomain: 'other' }, feedDraft)).rejects.toThrow('SOURCE_TARGET_OUTSIDE_SCOPE');
    expect(fx.resolve).not.toHaveBeenCalled();
    expect(await fx.registry.detectSource(principal, feedDraft)).toMatchObject({ sourceId: null,
      samples: [{ locator: 'id:post-1', byteLength: expect.any(Number) }] });
    expect(fx.db.prepare('SELECT 1 FROM source_configs').get()).toBeUndefined();
    const enabled = await fx.registry.enableSource(principal, feedDraft);
    expect(enabled).toMatchObject({ accepted: true, kind: 'enable', count: 0 });
    expect(fx.request).toHaveBeenCalledTimes(1);
    expect(await fx.registry.enableSource(principal, feedDraft)).toEqual(enabled);
    expect(fx.db.prepare("SELECT 1 FROM collection_receipts WHERE kind='first_collection'").get()).toBeUndefined();
    const first = await fx.registry.collectSource(enabled.sourceId, enabled.configRevision);
    expect(first).toMatchObject({ accepted: true, kind: 'first_collection', count: 0, cursor: 'sweep:1' });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM source_revisions').get()).toEqual({ n: 0 });
    fx.request.mockResolvedValueOnce({ ...response, bytes: secondPayload });
    expect(await fx.registry.collectSource(enabled.sourceId, enabled.configRevision)).toMatchObject({ kind: 'success', count: 1, cursor: 'sweep:2' });
    expect(fx.db.prepare('SELECT locator FROM source_objects').all()).toEqual([{ locator: 'id:post-2' }]);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM source_revisions').get()).toEqual({ n: 1 });
    const observed = fx.db.prepare('SELECT response_url,response_hash FROM http_source_response_evidence WHERE event_id=?')
      .get(first.eventId) as { response_url: string; response_hash: string };
    expect(observed.response_url).toBe(url);
    expect(Buffer.from(await fx.blobs.readBlob(observed.response_hash))).toEqual(Buffer.from(payload));
  } finally { fx.close(); }
});

test('a failed login and a late collection for a paused source never advance the checked cursor', async () => {
  const fx = setup();
  try {
    const enabled = await fx.registry.enableSource(principal, feedDraft);
    fx.request.mockResolvedValueOnce({ ...response, status: 403, bytes: new Uint8Array(0) });
    const failed = await fx.registry.collectSource(enabled.sourceId, enabled.configRevision);
    expect(failed).toMatchObject({ accepted: false, kind: 'failure', reason: 'SOURCE_REQUIRES_LOGIN', cursor: enabled.cursor });
    let release!: (value: typeof response) => void;
    fx.request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const started = fx.registry.collectSource(enabled.sourceId, enabled.configRevision);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await fx.registry.pauseSource(enabled.sourceId);
    release(response);
    expect(await started).toMatchObject({ accepted: false, reason: 'PAUSED' });
    expect(fx.db.prepare("SELECT 1 FROM collection_receipts WHERE kind='first_collection'").get()).toBeUndefined();
    expect(fx.db.prepare('SELECT 1 FROM source_revisions').get()).toBeUndefined();
    expect(fx.db.prepare('SELECT cursor FROM source_cursors WHERE source_id=?').get(enabled.sourceId)).toEqual({ cursor: enabled.cursor });
  } finally { fx.close(); }
});

test('frequency, pause, resume and disconnect preserve evidence and fence any previously started collection', async () => {
  const fx = setup();
  try {
    const enabled = await fx.registry.enableSource(principal, feedDraft);
    const initial = await fx.registry.collectSource(enabled.sourceId, 1);
    expect(initial.kind).toBe('first_collection');
    fx.request.mockResolvedValueOnce({ ...response, bytes: secondPayload });
    const first = await fx.registry.collectSource(enabled.sourceId, 1);
    expect(first.count).toBe(1);
    let release!: (value: typeof response) => void;
    fx.request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const started = fx.registry.collectSource(enabled.sourceId, 1);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const stamp = () => new Date().toISOString();
    expect(() => fx.registry.changeHttpSource(principal, enabled.sourceId, 'modify', 1, '1h', () => {
      throw new Error('authority revoked');
    })).toThrow('authority revoked');
    expect(fx.registry.changeHttpSource(principal, enabled.sourceId, 'modify', 1, '1h', stamp)).toEqual({
      changed: true, revision: 2, status: 'enabled',
    });
    release(response);
    expect(await started).toMatchObject({ accepted: false, reason: 'STALE_REVISION', cursor: first.cursor });
    expect(() => fx.registry.changeHttpSource(principal, enabled.sourceId, 'pause', 1, undefined, stamp)).toThrow('SOURCE_REVISION_CONFLICT');
    expect(() => fx.registry.changeHttpSource({ ...principal, dataDomain: 'other' }, enabled.sourceId, 'pause', 2, undefined, stamp))
      .toThrow('SOURCE_NOT_FOUND');
    expect(fx.registry.changeHttpSource(principal, enabled.sourceId, 'pause', 2, undefined, stamp)).toMatchObject({ revision: 3, status: 'paused' });
    expect(fx.registry.changeHttpSource(principal, enabled.sourceId, 'resume', 3, undefined, stamp)).toMatchObject({ revision: 4, status: 'enabled' });
    expect(fx.registry.changeHttpSource(principal, enabled.sourceId, 'disconnect', 4, undefined, stamp)).toMatchObject({ revision: 5, status: 'disconnected' });
    expect(await fx.registry.collectSource(enabled.sourceId, 5)).toMatchObject({ accepted: false, reason: 'DISCONNECTED', cursor: first.cursor });
    expect(fx.request).toHaveBeenCalledTimes(3);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM source_revisions').get()).toEqual({ n: 1 });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM http_source_response_evidence').get()).toEqual({ n: 2 });
    expect(fx.db.prepare('SELECT kind,cursor FROM http_source_config_receipts ORDER BY config_revision').all()).toEqual(
      ['modify', 'pause', 'resume', 'disconnect'].map((kind) => ({ kind, cursor: first.cursor })));
  } finally { fx.close(); }
});

test('two background workers share a durable schedule and an expired worker cannot publish late', async () => {
  const fx = setup();
  const peer = openDatabase(fx.path, { manifest: fx.manifest });
  try {
    const enable = await fx.registry.enableSource(principal, { ...feedDraft, frequency: '1h' });
    let clock = Date.now();
    const now = () => new Date(clock);
    const options = { signal: new AbortController().signal };
    const worker = createHttpCollectionWorker(fx.db, fx.registry, now, options);
    const other = createHttpCollectionWorker(peer, fx.registry, now, options);
    let release!: (value: typeof response) => void;
    fx.request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = worker.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await other.tick()).toBe(false);
    clock += 46_000;
    expect(await other.tick()).toBe(true);
    release(response);
    expect(await first).toBe(true);
    expect(await other.tick()).toBe(false);
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM collection_receipts WHERE kind IN ('first_collection','success')").get()).toEqual({ n: 1 });
    expect(fx.db.prepare('SELECT lease_token,next_at FROM http_source_schedule WHERE source_id=?').get(enable.sourceId)).toEqual({
      lease_token: null, next_at: new Date(clock + 3_600_000).toISOString(),
    });
    clock += 3_600_000 - 1;
    expect(await worker.tick()).toBe(false);
    clock += 1;
    expect(await worker.tick()).toBe(true);
    expect(fx.request).toHaveBeenCalledTimes(3);
    expect(fx.db.prepare('SELECT sweep_count FROM source_cursors WHERE source_id=?').get(enable.sourceId)).toEqual({ sweep_count: 2 });
  } finally { peer.close(); fx.close(); }
});

test('parallel internal first sweeps do not commit using a baseline that lost initialization', async () => {
  const fx = setup();
  try {
    const enabled = await fx.registry.enableSource(principal, feedDraft);
    let release!: () => void;
    let delayNext = true;
    const putBlob = fx.blobs.putBlob.bind(fx.blobs);
    vi.spyOn(fx.blobs, 'putBlob').mockImplementation(async (bytes) => {
      if (delayNext && Buffer.from(bytes).equals(Buffer.from(secondPayload))) {
        delayNext = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return putBlob(bytes);
    });
    fx.request.mockResolvedValueOnce({ ...response, bytes: secondPayload });
    const delayed = fx.registry.collectSource(enabled.sourceId, enabled.configRevision);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await fx.registry.collectSource(enabled.sourceId, enabled.configRevision)).toMatchObject({ accepted: true, cursor: 'sweep:1' });
    release();
    expect(await delayed).toMatchObject({ accepted: false, reason: 'SOURCE_BASELINE_CHANGED', cursor: 'sweep:1' });
    fx.request.mockResolvedValueOnce({ ...response, bytes: secondPayload });
    expect(await fx.registry.collectSource(enabled.sourceId, enabled.configRevision)).toMatchObject({
      accepted: true, cursor: 'sweep:2', count: 1,
    });
    expect(fx.db.prepare('SELECT locator FROM source_objects').all()).toEqual([{ locator: 'id:post-2' }]);
  } finally { fx.close(); }
});
