import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Hono } from 'hono';
import { createLocalHubPort } from '@patrick/integrations/autoloop/answers';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { channelTestSchema } from '@patrick/contracts/resources';
import { createCredentialStore } from '@patrick/host';
import { openDatabase } from '@patrick/storage';
import { issueCallerSession, mountAuthRoutes, runWithAuth } from '../../apps/service/src/auth.js';
import { createApp } from '../../apps/service/src/app.js';
import { mountFeishuRoutes } from '../../apps/service/src/routes/feishu.js';
import { mountControlRoutes } from '../../apps/service/src/control.js';
import { mountSettingsRoutes } from '../../apps/service/src/routes/settings.js';
import { createSettingsChanges } from '../../apps/service/src/settings/changes.js';
import { builtinSettingsHandlers } from '../../apps/service/src/settings/builtin.js';
import { configureFeishuConnection } from '../support/settings-change.js';

const stamp = '2026-11-17T05:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function setup(withAdmittedProvider = true) {
  const root = mkdtempSync(join(tmpdir(), 'patrick-feishu-'));
  const databasePath = join(root, 'local.sqlite');
  const credentialDirectory = join(root, 'credentials');
  const now = () => new Date(stamp);
  const db = openDatabase(databasePath);
  db.prepare("INSERT INTO accounts VALUES ('owner', 1, 1, ?)").run(stamp);
  const credentials = createCredentialStore(credentialDirectory, now);
  const session = issueCallerSession(db, { accountId: 'owner', callerId: 'web', domain: 'personal', permissions: ['owner'] }, now, credentials);
  const app = withAdmittedProvider ? new Hono() : createApp({ databasePath, credentialDirectory, now });
  const hub = withAdmittedProvider ? createLocalHubPort(join(root, 'hub.sqlite')) : undefined;
  if (hub) {
    app.use('*', (_context, next) => runWithAuth({ db, credentials, now }, next));
    mountFeishuRoutes(app, () => ({ db, now, hub, feishuCredentials: credentials }));
    mountAuthRoutes(app);
    // The connection is configured by a trusted change, so the fixture offers
    // the same settings flow the browser uses.
    const engine = createSettingsChanges({ db, now, handlers: builtinSettingsHandlers(
      { db, credentials, now, hub: () => hub, feishuCredentials: credentials }) });
    mountControlRoutes(app);
    mountSettingsRoutes(app, () => ({ db, now, credentials, engine }));
  }
  const request = (path: string, payload?: unknown, origin = 'https://localhost', authorization = session.authorization) =>
    app.request(origin + '/api/v1/channels/feishu' + path, {
    method: payload === undefined ? 'GET' : 'POST', headers: {
      authorization, origin, 'content-type': 'application/json',
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const command = (path: string, id: string, payload: Json = {}) => request(path, {
    client_request_id: id, expected_revision: null, payload_hash: hash(canonicalPayload(payload)), payload,
  });
  return { db, credentialDirectory, credentials, request, command,
    configure(appId: string, appSecret: string, id: string) {
      return configureFeishuConnection(app, { authorization: session.authorization, appId, appSecret, id });
    },
    issue(accountId: string, domain: string) {
      db.prepare('INSERT OR IGNORE INTO accounts VALUES (?, 1, 1, ?)').run(accountId, stamp);
      return issueCallerSession(db, { accountId, callerId: 'web', domain, permissions: ['owner'] }, now, credentials).authorization;
    },
    close() { hub?.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('the default service does not treat its session directory as a Feishu credential provider', async () => {
  const fx = setup(false);
  try {
    const before = readdirSync(fx.credentialDirectory);
    const blocked = await fx.request('/credentials', credentials);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ params: { reason: 'credential_provider_not_configured' } });
    expect(readdirSync(fx.credentialDirectory)).toEqual(before);
    expect(await (await fx.request('/bindings/current')).json()).toMatchObject({
      data: { credential_setup_available: false, transport_available: false, app_id: null },
    });
  } finally { fx.close(); }
});

const credentials = { app_id: 'cli_test_fixture', app_secret: 'synthetic-only' };

test('Feishu credentials require authenticated TLS and cannot replace an existing connection', async () => {
  const fx = setup();
  try {
    const before = readdirSync(fx.credentialDirectory);
    const insecure = await fx.request('/credentials', credentials, 'http://localhost');
    expect(insecure.status).toBe(409);
    expect(readdirSync(fx.credentialDirectory)).toEqual(before);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM channel_connections').get()).toEqual({ n: 0 });
    const accepted = await fx.request('/credentials', credentials);
    expect(accepted.status).toBe(200);
    const ref = await accepted.json() as { credential_ref: string; version: number };
    expect(JSON.stringify(ref)).not.toContain(credentials.app_secret);
    expect(fx.credentials.resolve(ref.credential_ref)).toEqual(new TextEncoder().encode(credentials.app_secret));
    // The staged secret only becomes a connection through a trusted change.
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM channel_connections').get()).toEqual({ n: 0 });
    const configured = await fx.configure(credentials.app_id, credentials.app_secret, 'configure-first');
    expect(configured.applied?.status).toBe(202);
    fx.db.prepare("UPDATE channel_connections SET status = 'ready', transport_mode = 'active', connection_epoch = 8").run();
    const baseline = fx.db.prepare('SELECT * FROM channel_connections').get();
    // A second secret cannot replace the connection. It is only staged as a
    // candidate; the rotation applies it after the owner proves the change.
    const replacement = await fx.request('/credentials', { app_id: 'cli_replacement', app_secret: 'different-synthetic-only' });
    expect(replacement.status).toBe(200);
    const candidate = await replacement.json() as { credential_ref: string; version: number };
    expect(JSON.stringify(candidate)).not.toContain('different-synthetic-only');
    expect(fx.credentials.resolve(candidate.credential_ref)).toEqual(new TextEncoder().encode('different-synthetic-only'));
    expect((await fx.command('/bindings', 'old-tab-start-pair')).status).toBe(409);
    const after = fx.db.prepare('SELECT * FROM channel_connections').get();
    expect(after).toEqual(baseline);
    expect((after as { credential_ref: string }).credential_ref).toBe((baseline as { credential_ref: string }).credential_ref);
  } finally { fx.close(); }
});

test('a scoped pairing discloses the code once, and a preview cannot simulate delivery', async () => {
  const fx = setup();
  try {
    expect((await fx.request('/credentials', credentials)).status).toBe(200);
    await fx.configure(credentials.app_id, credentials.app_secret, 'configure-preview');
    expect((await fx.command('/bindings', 'unverified-probe')).status).toBe(409);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM channel_pairings').get()).toEqual({ n: 0 });
    // Model an admitted native probe before advancing. The fixture never runs Feishu.
    fx.db.prepare("UPDATE channel_connections SET tenant_key = 'tenant_fixture', reason_code = NULL").run();
    const started = await fx.command('/bindings', 'pair-once');
    expect(started.status).toBe(202);
    const { receipt_url } = await started.json() as { receipt_url: string };
    const path = receipt_url.replace('/api/v1/channels/feishu', '');
    const first = await fx.request(path);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const { data: pairing } = await first.json() as { data: {
      pairing_id: string; code: string; account_id?: string; data_domain: string; candidate_open_id: string | null;
    } };
    expect(pairing).toMatchObject({ data_domain: 'personal', candidate_open_id: null, code: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/u) });
    expect(pairing).not.toHaveProperty('account_id');
    expect(fx.db.prepare('SELECT code_hash FROM channel_pairings').get()).toEqual({ code_hash: hash(pairing.code) });
    expect(await (await fx.request('/bindings/current')).json()).toMatchObject({ data: { pairing_id: pairing.pairing_id, code: null } });
    expect(JSON.stringify(await (await fx.command('/bindings', 'pair-once')).json())).not.toContain(pairing.code);
    // Feed a local candidate into the T10 persistence boundary; there is no SDK or transport.
    fx.db.prepare("UPDATE channel_pairings SET status='candidate', candidate_open_id='ou_fixture', candidate_chat_id='oc_fixture'").run();
    expect((await fx.command(path + '/confirm', 'confirm-candidate')).status).toBe(202);
    const previewResponse = await fx.command('/tests', 'preview-test', { destination: 'ou_fixture' });
    expect(previewResponse.status).toBe(202);
    const previewUrl = (await previewResponse.json() as { receipt_url: string }).receipt_url.replace('/api/v1/channels/feishu', '');
    const previewSnapshot = await (await fx.request(previewUrl)).json() as { data: unknown };
    const preview = channelTestSchema.parse(previewSnapshot.data);
    expect(preview).toMatchObject({ status: 'previewed', destination: 'ou_fixture', message_id: null, inbound_evidence: null,
      preview_hash: hash('PAtrick 连接测试，不含业务资料。') });
    const attempted = await fx.command(previewUrl + '/send', 'explicit-send', {
      test_id: preview.test_id, preview_hash: preview.preview_hash, destination: preview.destination,
    });
    expect(attempted.status).toBe(503);
    expect(await attempted.json()).toMatchObject({ params: { reason: 'transport_not_configured' } });
    expect(fx.db.prepare('SELECT status, message_id, inbound_evidence FROM channel_tests').get()).toEqual({
      status: 'previewed', message_id: null, inbound_evidence: null,
    });
    expect(fx.db.prepare('SELECT status, transport_mode FROM channel_connections').get()).toEqual({ status: 'needs_test', transport_mode: 'probe' });
  } finally { fx.close(); }
});

test('pairing confirmation replays only for the path of the confirmed pairing', async () => {
  const fx = setup();
  try {
    expect((await fx.request('/credentials', credentials)).status).toBe(200);
    await fx.configure(credentials.app_id, credentials.app_secret, 'configure-replay');
    fx.db.prepare("UPDATE channel_connections SET tenant_key = 'tenant_fixture', reason_code = NULL").run();
    const original = await fx.command('/bindings', 'original-pair');
    const oldPath = (await original.json() as { receipt_url: string }).receipt_url.replace('/api/v1/channels/feishu', '');
    const replacement = await fx.command('/bindings', 'replacement-pair');
    const path = (await replacement.json() as { receipt_url: string }).receipt_url.replace('/api/v1/channels/feishu', '');
    expect(path).not.toBe(oldPath);
    fx.db.prepare(`UPDATE channel_pairings SET status='candidate', candidate_open_id='ou_fixture', candidate_chat_id='oc_fixture'
      WHERE pairing_id = (SELECT current_pairing_id FROM channel_connections)`).run();
    const confirmed = await fx.command(path + '/confirm', 'confirm-pairing-once');
    expect(confirmed.status).toBe(202);
    const receipt = await confirmed.json();
    const replay = await fx.command(path + '/confirm', 'confirm-pairing-once');
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(receipt);
    const mismatch = await fx.command(oldPath + '/confirm', 'confirm-pairing-once');
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: 'CONFLICT', params: { reason: 'idempotency' } });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM channel_bindings').get()).toEqual({ n: 1 });
  } finally { fx.close(); }
});

test('re-opening pairing preserves the expired receipt and never discloses its unclaimed code', async () => {
  const fx = setup();
  try {
    expect((await fx.request('/credentials', credentials)).status).toBe(200);
    await fx.configure(credentials.app_id, credentials.app_secret, 'configure-expired');
    fx.db.prepare("UPDATE channel_connections SET tenant_key = 'tenant_fixture', reason_code = NULL").run();
    const original = await fx.command('/bindings', 'original-undisclosed');
    const originalReceipt = await original.json() as { receipt_url: string };
    const oldPath = originalReceipt.receipt_url.replace('/api/v1/channels/feishu', '');
    const replacement = await fx.command('/bindings', 'replacement-code');
    const newPath = (await replacement.json() as { receipt_url: string }).receipt_url.replace('/api/v1/channels/feishu', '');
    expect(newPath).not.toBe(oldPath);
    const originalReplay = await fx.command('/bindings', 'original-undisclosed');
    expect(originalReplay.status).toBe(202);
    expect(await originalReplay.json()).toEqual(originalReceipt);
    const expired = await fx.request(oldPath);
    expect(expired.status).toBe(200);
    expect(expired.headers.get('cache-control')).toBe('no-store');
    expect(await expired.json()).toMatchObject({
      data: { pairing_id: oldPath.split('/').at(-1), data_domain: 'personal', status: 'expired', code: null },
    });
    const outsider = fx.issue('another-owner', 'personal');
    expect((await fx.request(oldPath, undefined, 'https://localhost', outsider)).status).toBe(404);
    expect((await fx.request(newPath, undefined, 'https://localhost', outsider)).status).toBe(404);
    expect(await (await fx.request(newPath)).json()).toMatchObject({
      data: { pairing_id: newPath.split('/').at(-1), status: 'open', code: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/u) },
    });
    expect(await (await fx.request(newPath)).json()).toMatchObject({ data: { status: 'open', code: null } });
  } finally { fx.close(); }
});
