import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { canonicalPayload, type BrowserCreationScope, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { createBlobStore, openDatabase, type MigrationEntry } from '@patrick/storage';
import { createSourceRegistry } from '@patrick/integrations/sources/registry';
import { issueCallerSession, mountAuthRoutes, ORIGIN, RP_ID, runWithAuth } from '../../apps/service/src/auth.js';
import { mountControlRoutes } from '../../apps/service/src/control.js';
import { mountSettingsRoutes } from '../../apps/service/src/routes/settings.js';
import { createSettingsChanges } from '../../apps/service/src/settings/changes.js';
import { sourceSettingsHandlers } from '../../apps/service/src/settings/sources.js';
import { mountSourceRoutes } from '../../apps/service/src/routes/sources.js';

const url = 'https://feed.example.test/news';
const next = 'https://feed.example.test/next';
const now = () => new Date('2026-11-17T05:20:00.000Z');
const response = { status: 200, location: null as string | null, contentType: 'application/rss+xml',
  bytes: new TextEncoder().encode('<rss><channel><item><guid>post-1</guid><title>First item</title></item></channel></rss>') };
const own = { account_id: 'owner', caller_id: 'web', data_domain: 'personal', permission_epoch: 1 };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t18-routes-'));
  const migrations = new URL('../../packages/storage/migrations/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', migrations), 'utf8')) as MigrationEntry[];
  const file = '0020_http_sources.sql';
  const sha256 = createHash('sha256').update(readFileSync(new URL(file, migrations))).digest('hex');
  const db = openDatabase(join(dir, 'service.sqlite'), { manifest: [...manifest.filter((entry) => entry.file !== file), { file, sha256 }] });
  const credentials = createCredentialStore(join(dir, 'credentials'), now);
  for (const account of ['owner', 'other']) db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(account, 1, 1, now().toISOString());
  const session = (accountId: string, domain: string, permissions: string[], callerId = 'web') =>
    issueCallerSession(db, { accountId, callerId, domain, permissions }, now, credentials).authorization;
  const authorization = session('owner', 'personal', ['owner']);
  const other = session('other', 'personal', ['owner']);
  const reader = session('owner', 'private', ['sources.read'], 'readonly');
  const request = vi.fn(async () => response);
  const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  const registry = createSourceRegistry(db, { blobs: createBlobStore(join(dir, 'blobs')), now: () => now().toISOString(),
    http: { approvedUrls: (actor, target) => actor.accountId === 'owner' && target === url ? [url, next] : null, port: { request, resolve } } });
  const app = new Hono();
  app.use('*', async (_c, next) => runWithAuth({ db, now, credentials }, next));
  mountSourceRoutes(app, () => ({ db, now, registry }));
  mountAuthRoutes(app);
  mountControlRoutes(app);
  const engine = createSettingsChanges({ db, now, handlers: sourceSettingsHandlers({ db, now, credentials, registry }) });
  mountSettingsRoutes(app, () => ({ db, now, credentials, engine }));
  const post = (route: string, client_request_id: string, expected_revision: number, payload: Json) =>
    app.request('/api/v1' + route, { method: 'POST', headers: { authorization, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ payload, payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex'),
        client_request_id, expected_revision }) });
  const challenge = () => app.request('/api/v1/auth/challenge', { method: 'POST',
    headers: { authorization, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ rp_id: RP_ID }) });
  const get = (path: string) => app.request(path, { headers: { authorization } });
  const detect = (id: string, data: Partial<{ target: string; type: 'rss' | 'webpage'; request_scope: BrowserCreationScope }> = {},
    auth = authorization) => {
    const payload = { target: url, type: 'rss', request_scope: own, ...data };
    const payload_hash = createHash('sha256').update(canonicalPayload(payload)).digest('hex');
    return app.request('/api/v1/sources/detect', { method: 'POST',
      headers: { authorization: auth, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ payload, payload_hash, expected_revision: null, client_request_id: id }) });
  };
  const read = (tail: string, auth = authorization) => app.request('/api/v1/sources' + tail, { headers: { authorization: auth } });
  return { db, detect, other, reader, post, challenge, get, request, resolve, registry, read, dispose() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('preview commands bind caller and domain, serialize concurrent retries and never enable a source', async () => {
  const fx = setup();
  try {
    expect((await fx.detect('scope', {}, fx.other)).status).toBe(403);
    expect((await fx.detect('scope', { request_scope: { ...own, caller_id: 'readonly', data_domain: 'private' } }, fx.reader)).status).toBe(403);
    expect((await fx.detect('target', { target: 'https://unregistered.example.test/' })).status).toBe(422);
    expect(fx.resolve).not.toHaveBeenCalled();
    const [first, retry] = await Promise.all([fx.detect('real-preview'), fx.detect('real-preview')]);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    const receipt = await first.json();
    expect(await retry.json()).toEqual(receipt);
    expect(receipt).toMatchObject({ scope: { account_id: 'owner', data_domain: 'personal' },
      data: { preview_id: expect.stringMatching(/^preview_/u), type: 'rss', target: url, duplicate_source_id: null,
        samples: [{ locator: 'id:post-1', byteLength: expect.any(Number) }] } });
    expect(await (await fx.detect('real-preview')).json()).toEqual(receipt);
    expect((await fx.detect('real-preview', { type: 'webpage' })).status).toBe(409);
    expect(fx.request).toHaveBeenCalledTimes(1);
    expect(fx.db.prepare('SELECT 1 FROM source_configs').get()).toBeUndefined();
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM source_preview_receipts').get()).toEqual({ n: 1 });
  } finally { fx.dispose(); }
});

test('revocation while DNS resolves prevents both the outbound HTTP request and its preview receipt', async () => {
  const fx = setup();
  try {
    let release!: (value: Array<{ address: string; family: number }>) => void;
    fx.resolve.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const reading = fx.detect('revoked');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    fx.db.prepare("UPDATE caller_scopes SET revoked_at=? WHERE account_id='owner' AND caller_id='web'").run(now().toISOString());
    release([{ address: '8.8.8.8', family: 4 }]);
    expect((await reading).status).toBe(403);
    expect(fx.request).not.toHaveBeenCalled();
    expect(fx.db.prepare('SELECT 1 FROM source_preview_receipts').get()).toBeUndefined();
  } finally { fx.dispose(); }
});

test('sources and actual collection receipts stay within the authenticated account and selected domain', async () => {
  const fx = setup();
  try {
    const enabled = await fx.registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { target: url, type: 'rss' });
    await fx.registry.collectSource(enabled.sourceId, enabled.configRevision);
    expect(await (await fx.read('?domain=personal')).json()).toMatchObject({ data: {
      items: [{ source_id: enabled.sourceId, status: 'enabled' }], next_cursor: null } });
    expect((await fx.read('?domain=personal&domain=private')).status).toBe(422);
    expect((await fx.read('/' + enabled.sourceId, fx.other)).status).toBe(403);
    expect((await fx.read('/' + enabled.sourceId + '/receipts?domain=personal', fx.reader)).status).toBe(403);
    const receipts = await fx.read('/' + enabled.sourceId + '/receipts?domain=personal');
    expect(receipts.status).toBe(200);
    expect((await receipts.json()).data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: enabled.eventId, kind: 'enable', accepted: true }),
      expect.objectContaining({ kind: 'first_collection', accepted: true, object_count: 0 }),
    ]));
  } finally { fx.dispose(); }
});

test('the actual T03 settings command enables a saved preview and emits an independently readable receipt', async () => {
  const fx = setup();
  try {
    const preview = await (await fx.detect('before-enable')).json();
    const draft: Json = { operation: 'enable_http_source', domain: 'personal', target: preview.data.preview_id, input: { frequency: '1h' } };
    const validation = await fx.post('/settings/validations', 'inspect-enable', 0, draft);
    expect(validation.status).toBe(200);
    const { data: { validation_id } } = await validation.json();
    expect((await fx.post('/settings/changes', 'guess', 0, { draft, validation_id, control_receipt_id: 'guess' })).status).toBe(403);
    expect(fx.db.prepare('SELECT 1 FROM source_configs').get()).toBeUndefined();
    const challenge = await fx.challenge();
    expect(challenge.status).toBe(200);
    const { challenge_id } = await challenge.json();
    const staged = await fx.post('/settings/control-proposals', 'prepare-enable', 0, { draft, validation_id, challenge_id });
    expect(staged.status).toBe(200);
    const { data: { proposal_id, proposal_hash, base_revision } } = await staged.json();
    const confirmed = await fx.post('/control-proposals/' + proposal_id + '/confirm', 'confirm-enable', base_revision,
      { proposal_hash, challenge_id });
    expect(confirmed.status).toBe(202);
    const control = await fx.get((await confirmed.json()).receipt_url);
    const { data: { control_receipt_id } } = await control.json();
    const payload = { draft, validation_id, control_receipt_id };
    const applied = await fx.post('/settings/changes', 'approved-enable', 0, payload);
    expect(applied.status).toBe(202);
    const accepted = await applied.json();
    expect(await (await fx.post('/settings/changes', 'approved-enable', 0, payload)).json()).toEqual(accepted);
    const receipt = await fx.get(accepted.receipt_url);
    expect((await receipt.json()).data).toMatchObject({ verified: true, applied_revision: 1, effects: [{ item: 'source_enable', outcome: 'applied' }] });
    const list = await fx.read('?domain=personal');
    expect((await list.json()).data.items).toMatchObject([{ frequency: '1h', status: 'enabled' }]);
    expect(fx.request).toHaveBeenCalledTimes(1);
    expect(fx.db.prepare('SELECT entries FROM http_source_baselines').get()).toEqual({
      entries: (fx.db.prepare('SELECT baseline FROM source_preview_receipts').get() as { baseline: string }).baseline,
    });
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM collection_receipts WHERE kind='enable'").get()).toEqual({ n: 1 });
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM collection_receipts WHERE kind='first_collection'").get()).toEqual({ n: 0 });
    const newPayload = new TextEncoder().encode('<rss><channel><item><guid>post-1</guid><title>First item</title></item><item><guid>post-new</guid><title>New after preview</title></item></channel></rss>');
    fx.request.mockResolvedValueOnce({ ...response, bytes: newPayload });
    const enabled = fx.db.prepare('SELECT source_id,config_revision FROM source_configs').get() as { source_id: string; config_revision: number };
    expect(await fx.registry.collectSource(enabled.source_id, enabled.config_revision)).toMatchObject({
      kind: 'first_collection', count: 1, accepted: true,
    });
    expect(fx.db.prepare('SELECT locator FROM source_objects').all()).toEqual([{ locator: 'id:post-new' }]);
  } finally { fx.dispose(); }
});
