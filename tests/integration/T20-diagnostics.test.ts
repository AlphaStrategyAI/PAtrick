import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { openDatabase, type MigrationEntry } from '@patrick/storage';
import { issueCallerSession, ORIGIN, runWithAuth } from '../../apps/service/src/auth.js';
import { mountDiagnosticsRoutes } from '../../apps/service/src/routes/diagnostics.js';

const at = '2040-03-20T17:00:00.000Z';
const account = 'fixture-private-account';
const caller = 'fixture-private-caller';
const domain = 'fixture-restricted-domain';
const ownScope = { account_id: account, caller_id: caller, data_domain: domain, permission_epoch: 1 };
const restrictedMarkers = [account, caller, domain, 'fixture-password-marker', 'fixture-execution-account',
  'fixture-other-work', 'fixture-hidden-work', '/fixture/private/file.md', 'fixture-raw-text'];

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t20-diagnostics-case-'));
  const dbPath = join(root, 'service.sqlite');
  const migrations = new URL('../../packages/storage/migrations/', import.meta.url);
  const file = '0021_notifications.sql';
  const base = JSON.parse(readFileSync(new URL('manifest.json', migrations), 'utf8')) as MigrationEntry[];
  const manifest = [...base.filter((entry) => entry.file !== file), { file, sha256: digest(readFileSync(new URL(file, migrations), 'utf8')) }];
  let db = openDatabase(dbPath, { manifest });
  let time = Date.parse(at);
  const now = () => new Date(time);
  const credentials = createCredentialStore(join(root, 'credentials'), now);
  const scopes = { accountId: account, callerId: caller, domain, permissions: ['owner'] };
  const session = (overrides: Partial<typeof scopes> = {}) =>
    issueCallerSession(db, { ...scopes, ...overrides }, now, credentials).authorization;
  for (const id of [account, 'fixture-other-account']) db.prepare('INSERT INTO accounts VALUES (?,1,1,?)').run(id, at);
  const authorization = session();
  const otherDomain = 'fixture-other-domain';
  session({ domain: otherDomain });
  const otherCaller = session({ callerId: 'fixture-other-caller' });
  const otherAccount = session({ accountId: 'fixture-other-account' });
  const reader = session({ callerId: 'fixture-reader', permissions: ['work.read'] });
  const checkpoint = db.prepare(`INSERT INTO product_view_checkpoints
    (account_id,data_domain,epoch,hub_seq,domain_seq,notification_seq,notification_floor,observed_at,trusted_as_of,freshness,health_payload)
    VALUES (?,?,1,12,27,5,0,?,?,'fresh',?)`);
  const health = JSON.stringify({
    connections: { vault: { status: 'connected', revision: 1, epoch: 1, root: restrictedMarkers[6] },
      feishu: { status: restrictedMarkers[3], revision: 1, epoch: 0, identity: restrictedMarkers[4] } },
    edits: { pending: 1, failed: 0, raw: restrictedMarkers[7] },
    log: restrictedMarkers[7],
  });
  checkpoint.run(account, domain, at, at, health);
  checkpoint.run(account, otherDomain, at, at, health);
  checkpoint.run('fixture-other-account', domain, at, at, health);
  const insert = db.prepare('INSERT INTO product_work_views VALUES (?,?,?,1,?,?,?,?)');
  const raw = JSON.stringify({ text: restrictedMarkers[7], execution_identity: restrictedMarkers[4],
    credential_ref: restrictedMarkers[3], absolute_path: restrictedMarkers[6] });
  insert.run(account, domain, 'fixture-own-work-1', 1, 'awaiting_answer', at, raw);
  insert.run(account, domain, 'fixture-own-work-2', 1, 'blocked', at, raw);
  insert.run(account, domain, 'fixture-hidden-work', 0, 'blocked', at, raw);
  insert.run(account, otherDomain, 'fixture-other-work', 1, 'blocked', at, raw);
  insert.run('fixture-other-account', domain, 'fixture-other-work', 1, 'blocked', at, raw);
  function server() {
    const app = new Hono();
    app.use('*', async (_c, next) => runWithAuth({ db, now, credentials }, next));
    mountDiagnosticsRoutes(app, () => ({ db, now }));
    return app;
  }
  let app = server();
  const post = (kind: 'preview' | 'export', id: string, payload: Json, revision: number | null,
    auth = authorization, origin = ORIGIN, hash = digest(canonicalPayload(payload))) =>
    app.request('/api/v1/diagnostics/' + kind, { method: 'POST', headers: { authorization: auth, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ client_request_id: id, expected_revision: revision, payload_hash: hash, payload }) });
  const preview = (id = 'preview-1') => post('preview', id, { request_scope: ownScope }, null);
  return { get db() { return db; }, post, preview, otherCaller, otherAccount, reader, otherDomain, now, session,
    advance(ms: number) { time += ms; }, restart() { db.close(); db = openDatabase(dbPath, { manifest }); app = server(); },
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

type Preview = { preview_id: string; manifest_hash: string; revision: number;
  watermark: { hub_seq: number; domain_seq: number }; expires_at: string; report: Json };
const exportPayload = (value: Preview) => ({ request_scope: ownScope, preview_id: value.preview_id,
  manifest_hash: value.manifest_hash, watermark: value.watermark });

async function readPreview(fx: ReturnType<typeof setup>) {
  const response = await fx.preview();
  expect(response.status).toBe(200);
  return await response.json() as Preview;
}

test('preview presents only allowlisted facts from the selected domain and makes no business or network changes', async () => {
  const fx = setup();
  try {
    const before = fx.db.prepare('SELECT COUNT(*) AS n FROM domain_events').get();
    const res = await fx.preview();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    for (const marker of restrictedMarkers) expect(text).not.toContain(marker);
    const preview = JSON.parse(text) as Preview;
    expect(preview).toMatchObject({ preview_id: expect.stringMatching(/^diagnostic_/u),
      manifest_hash: expect.stringMatching(/^[a-f0-9]{64}$/u), revision: 5, watermark: { hub_seq: 12, domain_seq: 27 },
      report: { schema_version: '1.0', projection: { freshness: 'fresh', as_of: at,
        work: { open: 2, awaiting_answer: 1, blocked: 1 },
        connections: { vault: 'connected', feishu: 'unknown' }, edits: { pending: 1, failed: 0 } } } });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM domain_events').get()).toEqual(before);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
  } finally { fx.close(); }
});

test('only exact current preview bytes can be downloaded and retries survive reopening the database', async () => {
  const fx = setup();
  try {
    const preview = await readPreview(fx);
    const payload = exportPayload(preview);
    expect((await fx.post('export', 'download', { ...payload, manifest_hash: '0'.repeat(64) }, preview.revision)).status).toBe(409);
    expect((await fx.post('export', 'download', payload, preview.revision + 1)).status).toBe(409);
    expect((await fx.post('export', 'download', { ...payload, watermark: { ...payload.watermark, hub_seq: 99 } }, preview.revision)).status).toBe(409);
    const response = await fx.post('export', 'download', payload, preview.revision);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="patrick-diagnostics.json"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bytes = await response.text();
    expect(digest(bytes)).toBe(preview.manifest_hash);
    expect(JSON.parse(bytes)).toEqual(preview.report);
    for (const marker of restrictedMarkers) expect(bytes).not.toContain(marker);
    fx.restart();
    expect(await (await fx.preview()).json()).toEqual(preview);
    expect(await (await fx.post('export', 'download', payload, preview.revision)).text()).toBe(bytes);
    expect((await fx.post('export', 'preview-1', payload, preview.revision)).status).toBe(409);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM command_inbox').get()).toEqual({ n: 2 });
  } finally { fx.close(); }
});

test('preview and downloads cannot cross accounts, callers, domains, revoked scopes or auth epochs', async () => {
  const fx = setup();
  try {
    const preview = await readPreview(fx);
    const payload = exportPayload(preview);
    expect((await fx.post('preview', 'forged', { request_scope: ownScope }, null, fx.reader)).status).toBe(403);
    expect((await fx.post('preview', 'forged', { request_scope: ownScope }, null, undefined, 'https://fixture.invalid')).status).toBe(403);
    expect((await fx.post('preview', 'forged', { request_scope: ownScope }, null, undefined, undefined, '0'.repeat(64))).status).toBe(422);
    for (const [auth, change] of [
      [fx.otherCaller, { caller_id: 'fixture-other-caller' }], [fx.otherAccount, { account_id: 'fixture-other-account' }],
      [undefined, { data_domain: fx.otherDomain }],
    ] as const) {
      expect((await fx.post('export', 'forged', { ...payload, request_scope: { ...ownScope, ...change } }, preview.revision, auth)).status).toBe(403);
    }
    fx.db.prepare('UPDATE caller_scopes SET revoked_at=? WHERE account_id=? AND caller_id=? AND data_domain=?').run(at, account, caller, domain);
    expect((await fx.post('export', 'download', payload, preview.revision)).status).toBe(403);
    fx.db.prepare('UPDATE accounts SET auth_epoch=2 WHERE account_id=?').run(account);
    const refreshed = fx.session();
    expect((await fx.post('export', 'download', { ...payload, request_scope: { ...ownScope, permission_epoch: 2 } },
      preview.revision, refreshed)).status).toBe(403);
  } finally { fx.close(); }
});

test('expiry and changes to the selected projection invalidate preview replay and export; unrelated domains do not', async () => {
  const fx = setup();
  try {
    const preview = await readPreview(fx);
    fx.db.prepare('UPDATE product_view_checkpoints SET hub_seq=99 WHERE account_id=? AND data_domain=?').run(account, fx.otherDomain);
    expect((await fx.post('export', 'download', exportPayload(preview), preview.revision)).status).toBe(200);
    fx.db.prepare('UPDATE product_view_checkpoints SET domain_seq=28,notification_seq=6 WHERE account_id=? AND data_domain=?').run(account, domain);
    expect((await fx.preview()).status).toBe(409);
    expect((await fx.post('export', 'download', exportPayload(preview), preview.revision)).status).toBe(409);
    const second = await (await fx.preview('preview-2')).json() as Preview;
    expect(second.preview_id).not.toBe(preview.preview_id);
    fx.advance(Date.parse(second.expires_at) - +fx.now());
    expect((await fx.preview('preview-2')).status).toBe(409);
    expect((await fx.post('export', 'new-download', exportPayload(second), second.revision)).status).toBe(409);
  } finally { fx.close(); }
});

test('missing and stale projection facts are reported as unknown, not zeros or old healthy states', async () => {
  const fx = setup();
  try {
    fx.db.prepare("UPDATE product_view_checkpoints SET freshness='stale' WHERE account_id=? AND data_domain=?").run(account, domain);
    const stale = await readPreview(fx);
    expect(stale.report).toMatchObject({ projection: { freshness: 'stale', work: null,
      connections: { vault: 'unknown', feishu: 'unknown' }, edits: null } });
    fx.db.prepare('DELETE FROM product_view_checkpoints WHERE account_id=? AND data_domain=?').run(account, domain);
    const missing = await (await fx.preview('preview-missing')).json() as Preview;
    expect(missing.report).toMatchObject({ projection: { freshness: 'unknown', as_of: null, work: null, edits: null } });
  } finally { fx.close(); }
});

test('a same-watermark projection reset or altered archive cannot download a previously confirmed preview', async () => {
  const fx = setup();
  try {
    const first = await readPreview(fx);
    const wrong = { ...first.report as Record<string, Json>, unexpected: 'fixture-must-not-export' };
    fx.db.prepare('UPDATE diagnostic_previews SET report_json=? WHERE preview_id=?').run(JSON.stringify(wrong), first.preview_id);
    const rejected = await fx.post('export', 'tampered', exportPayload(first), first.revision);
    expect(rejected.status).toBe(409);
    expect(await rejected.text()).not.toContain('fixture-must-not-export');

    const second = await (await fx.preview('preview-reset')).json() as Preview;
    fx.db.prepare('UPDATE product_view_checkpoints SET epoch=epoch+1 WHERE account_id=? AND data_domain=?').run(account, domain);
    expect((await fx.post('export', 'old-epoch', exportPayload(second), second.revision)).status).toBe(409);
    const current = await (await fx.preview('preview-current')).json() as Preview;
    expect(current).toMatchObject({ watermark: second.watermark, revision: second.revision, manifest_hash: second.manifest_hash });
    expect((await fx.post('export', 'current-epoch', exportPayload(current), current.revision)).status).toBe(200);
  } finally { fx.close(); }
});
