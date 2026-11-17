import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const target = 'https://news.example.test/feed';
const now = () => new Date('2026-11-17T06:00:00.000Z');
const text = new TextEncoder();
const bytes = text.encode(`<rss><channel>
  <item><guid>latest</guid><title>最新</title><pubDate>Mon, 16 Nov 2026 20:00:00 GMT</pubDate>
    <link>https://other.example.test/no-request</link><description>${'旧'.repeat(100)}</description></item>
  <item><guid>older</guid><title>较早</title><pubDate>Sun, 15 Nov 2026 20:00:00 GMT</pubDate></item>
  <item><guid>undated</guid><title>No publication date</title></item>
</channel></rss>`);
const own: BrowserCreationScope = { account_id: 'owner', caller_id: 'web', data_domain: 'personal', permission_epoch: 4 };
const requestLimits = { from: '2026-11-15T00:00:00Z', until: '2026-11-17T00:00:00Z', max_objects: 1, max_bytes: 8192 };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function setup() {
  let clock = now().getTime();
  const currentTime = () => new Date(clock);
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t18-history-flow-'));
  const migrations = new URL('../../packages/storage/migrations/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', migrations), 'utf8')) as MigrationEntry[];
  const file = '0020_http_sources.sql';
  const db = openDatabase(join(dir, 'service.sqlite'), { manifest: [...manifest.filter((entry) => entry.file !== file),
    { file, sha256: hash(readFileSync(new URL(file, migrations))) }].sort((a, b) => a.file.localeCompare(b.file)) });
  const credentials = createCredentialStore(join(dir, 'credentials'), currentTime);
  for (const account of ['owner', 'other']) db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(account, 4, 1, currentTime().toISOString());
  const session = (accountId: string, dataDomain: string, callerId = 'web') =>
    issueCallerSession(db, { accountId, callerId, domain: dataDomain, permissions: ['owner'] }, currentTime, credentials).authorization;
  const authorization = session('owner', 'personal');
  const other = session('other', 'personal');
  const otherDomain = session('owner', 'private', 'private-web');
  const otherCaller = session('owner', 'personal', 'second-web');
  const origin = { status: 200, location: null, contentType: 'application/rss+xml', bytes };
  const httpRequest = vi.fn(async () => origin);
  const resolveHost = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  const store = createBlobStore(join(dir, 'blobs'));
  const putBlob = vi.fn((payload: Uint8Array) => store.putBlob(payload));
  const readBlob = vi.fn((digest: string) => store.readBlob(digest));
  const registry = createSourceRegistry(db, { blobs: { ...store, putBlob, readBlob }, now: () => currentTime().toISOString(),
    http: { approvedUrls: (actor, url) => actor.accountId === 'owner' && url === target ? [target] : null,
      port: { request: httpRequest, resolve: resolveHost } } });
  const app = new Hono();
  app.use('*', async (_c, next) => runWithAuth({ db, now: currentTime, credentials }, next));
  mountSourceRoutes(app, () => ({ db, now: currentTime, registry }));
  mountAuthRoutes(app);
  mountControlRoutes(app);
  const engine = createSettingsChanges({ db, now: currentTime, handlers: sourceSettingsHandlers({ db, now: currentTime, credentials, registry }) });
  mountSettingsRoutes(app, () => ({ db, now: currentTime, credentials, engine }));
  const post = (path: string, client_request_id: string, expected_revision: number, payload: Json, auth = authorization) =>
    app.request('/api/v1' + path, { method: 'POST', headers: { authorization: auth, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ payload, payload_hash: hash(canonicalPayload(payload)), client_request_id, expected_revision }) });
  const get = (path: string, auth = authorization) => app.request(path, { headers: { authorization: auth } });
  const preview = (sourceId: string, id: string, limits = requestLimits, auth = authorization, request_scope = own) =>
    post('/sources/' + sourceId + '/history/preview', id, 1, { ...limits, request_scope }, auth);
  const approve = async (draft: Json, attempt = 'approval') => {
    const validation = await post('/settings/validations', attempt + '-inspect', 1, draft);
    expect(validation.status).toBe(200);
    const { data: { validation_id } } = await validation.json();
    const challenge = await app.request('/api/v1/auth/challenge', { method: 'POST',
      headers: { authorization, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ rp_id: RP_ID }) });
    const { challenge_id } = await challenge.json();
    const staged = await post('/settings/control-proposals', attempt + '-prepare', 1, { draft, validation_id, challenge_id });
    expect(staged.status).toBe(200);
    const { data: { proposal_id, proposal_hash, base_revision } } = await staged.json();
    const confirmed = await post('/control-proposals/' + proposal_id + '/confirm', attempt + '-confirm', base_revision, { proposal_hash, challenge_id });
    expect(confirmed.status).toBe(202);
    const control = await get((await confirmed.json()).receipt_url);
    const { data: { control_receipt_id } } = await control.json();
    return { draft, validation_id, control_receipt_id };
  };
  const enable = () => registry.enableSource({ accountId: 'owner', dataDomain: 'personal' }, { target, type: 'rss' });
  return { db, other, otherDomain, otherCaller, registry, httpRequest, resolveHost, putBlob, readBlob, store, get, post, preview, approve, enable,
    advance(milliseconds: number) { clock += milliseconds; },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('history preview is scoped and replayable, requires existing evidence, and enforces its bytes before creating a plan', async () => {
  const fx = setup();
  try {
    const source = await fx.enable();
    expect((await fx.preview(source.sourceId, 'no-evidence')).status).toBe(409);
    expect(fx.httpRequest).not.toHaveBeenCalled();
    expect((await fx.registry.collectSource(source.sourceId, 1)).accepted).toBe(true);
    expect((await fx.preview(source.sourceId, 'foreign-account', requestLimits, fx.other, { ...own, account_id: 'other' })).status).toBe(403);
    expect((await fx.preview(source.sourceId, 'foreign-domain', requestLimits, fx.otherDomain,
      { ...own, caller_id: 'private-web', data_domain: 'private' })).status).toBe(403);
    const budget = await fx.preview(source.sourceId, 'below-evidence', { ...requestLimits, max_bytes: bytes.byteLength - 1 });
    expect(budget.status).toBe(422);
    expect(await budget.json()).toMatchObject({ params: { reason: 'history_budget' } });
    const plan = await fx.preview(source.sourceId, 'preview');
    expect(plan.status).toBe(200);
    const original = await plan.json();
    expect(original.data).toMatchObject({ source_id: source.sourceId, config_revision: 1, state: 'pending', receipt: null,
      response_hash: hash(bytes), cost: { selected_objects: 1, eligible_objects: 2, omitted_objects: 1, additional_network_requests: 0 } });
    expect(await (await fx.preview(source.sourceId, 'preview')).json()).toEqual(original);
    expect((await fx.preview(source.sourceId, 'preview', { ...requestLimits, max_objects: 2 })).status).toBe(409);
    const path = '/api/v1/sources/' + source.sourceId + '/history/' + original.data.plan_id + '?domain=personal';
    expect((await fx.get(path, fx.other)).status).toBe(404);
    expect((await fx.get(path, fx.otherDomain)).status).toBe(403);
    expect((await fx.get(path, fx.otherCaller)).status).toBe(404);
    expect((await fx.get(path)).status).toBe(200);
    expect(fx.httpRequest).toHaveBeenCalledTimes(1);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM http_source_history_plans').get()).toEqual({ n: 1 });
  } finally { fx.close(); }
});

test('exact T03 approval imports only frozen items once, skips existing revisions, and changes no sweep cursor or work', async () => {
  const fx = setup();
  try {
    const source = await fx.enable();
    await fx.registry.collectSource(source.sourceId, 1);
    const scopePath = '/api/v1/sources/' + source.sourceId + '/history/';
    const { data: plan } = await (await fx.preview(source.sourceId, 'freeze', { ...requestLimits, max_objects: 2 })).json();
    const draft = { operation: 'import_rss_history', domain: 'personal', target: plan.plan_id, input: { plan_hash: plan.plan_hash } };
    const approved = await fx.approve(draft);
    expect((await fx.post('/settings/changes', 'forged-receipt', 1, { ...approved, control_receipt_id: 'not-approved' })).status).toBe(403);
    expect((await fx.post('/settings/changes', 'changed-proof', 1, { ...approved, draft: { ...draft, input: { plan_hash: '0'.repeat(64) } } })).status).toBe(409);
    const changed = text.encode('<rss><channel><item><guid>latest</guid><title>Newer content</title><pubDate>Mon, 16 Nov 2026 20:00:00 GMT</pubDate></item></channel></rss>');
    fx.httpRequest.mockResolvedValueOnce({ status: 200, location: null, contentType: 'application/rss+xml', bytes: changed });
    await fx.registry.collectSource(source.sourceId, 1);
    const cursor = fx.db.prepare('SELECT * FROM source_cursors').get();
    const revisions = fx.db.prepare('SELECT COUNT(*) AS n FROM source_revisions').get();
    const work = fx.db.prepare('SELECT COUNT(*) AS n FROM domain_events').get();
    fx.db.prepare('UPDATE source_configs SET has_trigger_rule = 1').run();
    const applied = await fx.post('/settings/changes', 'apply-frozen-history', 1, approved);
    expect(applied.status).toBe(202);
    const ticket = await applied.json();
    expect(await (await fx.post('/settings/changes', 'apply-frozen-history', 1, approved)).json()).toEqual(ticket);
    expect((await (await fx.get(ticket.receipt_url)).json()).data).toMatchObject({ verified: true, applied_revision: 1 });
    const appliedView = (await (await fx.get(scopePath + plan.plan_id + '?domain=personal')).json()).data;
    expect(appliedView).toMatchObject({ state: 'applied', receipt: { selected_objects: 2, imported_objects: 1, existing_objects: 1 } });
    expect((await (await fx.get(scopePath + plan.plan_id + '?domain=personal')).json()).data.receipt).toEqual(appliedView.receipt);
    expect(fx.db.prepare('SELECT * FROM source_cursors').get()).toEqual(cursor);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM domain_events').get()).toEqual(work);
    expect(fx.db.prepare('SELECT locator FROM source_objects ORDER BY locator').all()).toEqual([{ locator: 'id:latest' }, { locator: 'id:older' }]);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM source_revisions').get()).toEqual({ n: (revisions as { n: number }).n + 1 });
    expect(fx.httpRequest).toHaveBeenCalledTimes(2);
  } finally { fx.close(); }
});

test('configuration changes before or during the import invalidate an otherwise confirmed plan', async () => {
  const fx = setup();
  try {
    const source = await fx.enable();
    await fx.registry.collectSource(source.sourceId, 1);
    const { data: plan } = await (await fx.preview(source.sourceId, 'freeze')).json();
    const draft = { operation: 'import_rss_history', domain: 'personal', target: plan.plan_id, input: { plan_hash: plan.plan_hash } };
    const approval = await fx.approve(draft);
    fx.putBlob.mockImplementationOnce(async (blob) => {
      const digest = await fx.store.putBlob(blob);
      fx.registry.changeHttpSource({ accountId: 'owner', dataDomain: 'personal' }, source.sourceId, 'pause', 1, undefined, () => now().toISOString());
      return digest;
    });
    const changed = await fx.post('/settings/changes', 'apply-stale-history', 1, approval);
    expect(changed.status).toBe(202);
    expect((await (await fx.get((await changed.json()).receipt_url)).json()).data).toMatchObject({
      verified: false, phase: 'observed', effects: [{ outcome: 'blocked' }],
    });
    expect(fx.db.prepare('SELECT 1 FROM source_objects').get()).toBeUndefined();
    expect(fx.db.prepare('SELECT 1 FROM http_source_history_receipts').get()).toBeUndefined();
    expect((await fx.post('/settings/validations', 'revalidate-old-plan', 1, draft)).status).toBe(409);
    expect(fx.httpRequest).toHaveBeenCalledTimes(1);
  } finally { fx.close(); }
});


test('revoking the owner at the final write fence blocks import and leaves no history receipt', async () => {
  const fx = setup();
  try {
    const source = await fx.enable();
    await fx.registry.collectSource(source.sourceId, 1);
    const { data: plan } = await (await fx.preview(source.sourceId, 'freeze')).json();
    const draft = { operation: 'import_rss_history', domain: 'personal', target: plan.plan_id, input: { plan_hash: plan.plan_hash } };
    const approval = await fx.approve(draft);
    fx.putBlob.mockImplementationOnce(async (blob) => {
      const digest = await fx.store.putBlob(blob);
      fx.db.prepare("UPDATE caller_scopes SET revoked_at=? WHERE account_id='owner' AND caller_id='web'").run(now().toISOString());
      return digest;
    });
    const changed = await fx.post('/settings/changes', 'apply-revoked-history', 1, approval);
    expect(changed.status).toBe(202);
    const { command_id } = await changed.json();
    const stored = fx.db.prepare('SELECT receipt FROM settings_changes WHERE change_id=?').get(command_id) as { receipt: string };
    expect(JSON.parse(stored.receipt)).toMatchObject({ verified: false, phase: 'observed', issues: ['confirmation_changed'],
      effects: [{ outcome: 'blocked' }] });
    expect(fx.db.prepare('SELECT 1 FROM source_objects').get()).toBeUndefined();
    expect(fx.db.prepare('SELECT 1 FROM http_source_history_receipts').get()).toBeUndefined();
    expect(fx.httpRequest).toHaveBeenCalledTimes(1);
  } finally { fx.close(); }
});

test.each(['corrupted', 'missing', 'selection_digest', 'changed_range', 'coherent_wrong_cost', 'expires_during_read'] as const)(
  'history validation refuses %s evidence without writing or contacting the feed',
  async (failure) => {
    const fx = setup();
    try {
      const source = await fx.enable();
      await fx.registry.collectSource(source.sourceId, 1);
      const preview = await fx.preview(source.sourceId, 'freeze-for-validation');
      expect(preview.status).toBe(200);
      const { data: plan } = await preview.json();
      const path = fx.store.pathFor(plan.response_hash);
      if (failure === 'corrupted') {
        const changed = text.encode(new TextDecoder().decode(bytes).replace('latest', 'latent'));
        expect(changed.byteLength).toBe(bytes.byteLength);
        writeFileSync(path, changed);
      } else if (failure === 'missing') {
        rmSync(path);
      } else if (failure === 'selection_digest') {
        fx.db.prepare('UPDATE http_source_history_plans SET selection_hash=? WHERE plan_id=?').run('0'.repeat(64), plan.plan_id);
      } else if (failure === 'coherent_wrong_cost') {
        fx.db.prepare("UPDATE http_source_history_plans SET summary=json_set(summary,'$.cost.evidence_bytes',?,'$.cost.total_bytes',?) WHERE plan_id=?")
          .run(plan.cost.evidence_bytes + 1, plan.cost.total_bytes + 1, plan.plan_id);
      } else if (failure === 'changed_range') {
        fx.db.prepare("UPDATE http_source_history_plans SET summary=json_set(summary,'$.range.from',?) WHERE plan_id=?")
          .run('2026-11-16T21:00:00.000Z', plan.plan_id);
      } else {
        fx.readBlob.mockImplementationOnce(async (digest) => {
          const observed = await fx.store.readBlob(digest);
          fx.advance(10 * 60 * 1000);
          return observed;
        });
      }
      const draft = { operation: 'import_rss_history', domain: 'personal', target: plan.plan_id, input: { plan_hash: plan.plan_hash } };
      const response = await fx.post('/settings/validations', 'verify-local-evidence', 1, draft);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION_STALE' });
      expect(fx.db.prepare('SELECT 1 FROM settings_validations').get()).toBeUndefined();
      expect(fx.db.prepare('SELECT 1 FROM source_objects').get()).toBeUndefined();
      expect(fx.db.prepare('SELECT 1 FROM http_source_history_receipts').get()).toBeUndefined();
      expect(fx.httpRequest).toHaveBeenCalledTimes(1);
      expect(fx.putBlob).toHaveBeenCalledTimes(1);
    } finally { fx.close(); }
  },
);
