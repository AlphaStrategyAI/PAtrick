import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { createCredentialStore } from '@patrick/host';
import { openDatabase } from '@patrick/storage';
import { createApp } from '../../apps/service/src/app.js';
import { issueCallerSession, ORIGIN } from '../../apps/service/src/auth.js';

const at = '2040-03-20T17:00:00.000Z';
const now = () => new Date(at);
const future = '2040-03-21T17:00:00.000Z';
const owner = 'fixture-notification-owner';
const caller = 'fixture-notification-caller';
const selected = 'fixture-notification-selected';
const foreign = 'fixture-notification-foreign';
const otherOwner = 'fixture-notification-other-owner';
const request_scope = { account_id: owner, caller_id: caller, data_domain: selected, permission_epoch: 1 };
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const binding = digest('non-exported-fixture-binding');
const evidence = digest('non-exported-fixture-evidence');
const emptySummary = { pending: 0, quiet: 0, digest: 0, checking: 0, retrying: 0, blocked: 0 };

function setup() {
  const path = mkdtempSync(join(tmpdir(), 'patrick-t20-notification-routes-'));
  const databasePath = join(path, 'patrick.sqlite');
  const credentialDirectory = join(path, 'credentials');
  const app = createApp({ databasePath, credentialDirectory, now });
  const db = openDatabase(databasePath);
  const credentials = createCredentialStore(credentialDirectory, now);
  db.prepare('INSERT INTO accounts VALUES (?,1,1,?),(?,1,1,?)').run(owner, at, otherOwner, at);
  const own = { accountId: owner, callerId: caller, domain: selected, permissions: ['owner'] };
  const session = (override: Partial<typeof own> = {}) =>
    issueCallerSession(db, { ...own, ...override }, now, credentials).authorization;
  const authorization = session();
  const reader = session({ permissions: ['work.read'], callerId: 'fixture-notification-reader' });
  // The same caller has owner permission somewhere, but is a reader in this domain.
  session({ domain: foreign, permissions: ['work.read'] });
  const other = session({ accountId: otherOwner });
  const put = db.prepare(`INSERT INTO notification_intents(intent_id,account_id,data_domain,object_id,event_version,kind,channel,auth_epoch,
    binding_hash,expires_at,status,evidence_hash,updated_at) VALUES (?,?,?,?,?,?,'feishu',?,?,?,?,?,?)`);
  function intent(name: string, kind: string, status: string, options: Partial<{
    account: string; domain: string; expires: string; epoch: number; version: number;
  }> = {}) {
    put.run('private-intent-' + name + '-' + (options.version ?? 1), options.account ?? owner, options.domain ?? selected,
      'private-object-' + name, options.version ?? 1, kind, options.epoch ?? 1, binding, options.expires ?? future, status, evidence, at);
  }
  function summary(domain = selected, auth = authorization) {
    return app.request('/api/v1/notifications/summary?domain=' + encodeURIComponent(domain), { headers: { authorization: auth } });
  }
  function preview(payload: Json = { request_scope }, options: { auth?: string; origin?: string; revision?: number; hash?: string } = {}) {
    return app.request('/api/v1/notifications/preview', { method: 'POST',
      headers: { authorization: options.auth ?? authorization, origin: options.origin ?? ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ client_request_id: 'preview-current', expected_revision: options.revision ?? null,
        payload_hash: options.hash ?? digest(canonicalPayload(payload)), payload }),
    });
  }
  return { db, reader, other, summary, preview, intent, session, close() { db.close(); rmSync(path, { recursive: true, force: true }); } };
}

test('notification summary contains coarse counts for the live owner scope only', async () => {
  const f = setup();
  try {
    f.intent('decision', 'decision', 'pending');
    f.intent('blocker', 'blocker', 'quiet');
    f.intent('progress', 'progress', 'digest');
    f.intent('outstanding', 'decision', 'uncertain');
    f.intent('attempt', 'decision', 'sending');
    f.intent('retry', 'decision', 'retry_wait');
    f.intent('blocked', 'blocker', 'blocked');
    f.intent('expired', 'progress', 'digest', { expires: at });
    f.intent('withdrawn', 'decision', 'superseded');
    f.intent('sent', 'delivered', 'sent');
    f.intent('stale-epoch', 'progress', 'digest', { epoch: 2 });
    f.intent('other-domain', 'progress', 'digest', { domain: foreign });
    f.intent('other-account', 'progress', 'digest', { account: otherOwner });
    f.db.prepare(`INSERT INTO product_view_checkpoints(account_id,data_domain,epoch,hub_seq,domain_seq,notification_seq,
      notification_floor,observed_at,trusted_as_of,freshness) VALUES (?,?,1,12,27,5,0,?,?,'fresh')`).run(owner, selected, at, at);
    const response = await f.summary();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bytes = await response.text();
    for (const secret of ['private-intent-', 'private-object-', binding, evidence, otherOwner, foreign]) expect(bytes).not.toContain(secret);
    expect(JSON.parse(bytes)).toEqual({ schema_version: '1.0', scope: { account_id: owner, data_domain: selected, permission_epoch: 1 },
      as_of: at, freshness: 'fresh', watermark: { hub_seq: 12, domain_seq: 27 },
      data: { pending: 1, quiet: 1, digest: 1, checking: 2, retrying: 1, blocked: 1 } });
    expect(await (await f.summary(selected, f.other)).json()).toMatchObject({ data: { ...emptySummary, digest: 1 } });
  } finally { f.close(); }
});

test('local preview groups live digest items without creating delivery or business records', async () => {
  const f = setup();
  try {
    f.intent('digest-a', 'progress', 'digest');
    f.intent('digest-b', 'progress', 'digest');
    f.intent('digest-c', 'delivered', 'digest');
    f.intent('past-revision', 'progress', 'digest');
    f.intent('past-revision', 'progress', 'superseded', { version: 2 });
    f.intent('expired', 'progress', 'digest', { expires: at });
    f.intent('other-domain', 'progress', 'digest', { domain: foreign });
    f.intent('other-account', 'progress', 'digest', { account: otherOwner });
    f.intent('waiting', 'decision', 'quiet');
    f.intent('sent', 'blocker', 'sent');
    const before = f.db.prepare('SELECT intent_id,status,attempts,updated_at FROM notification_intents ORDER BY intent_id').all();
    const response = await f.preview();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      scope: { account_id: owner, data_domain: selected, permission_epoch: 1 }, freshness: 'fresh',
      data: { decision: 0, blocker: 0, delivered: 1, progress: 2 },
    });
    expect(f.db.prepare('SELECT intent_id,status,attempts,updated_at FROM notification_intents ORDER BY intent_id').all()).toEqual(before);
    for (const table of ['notification_attempts', 'outbox', 'command_inbox', 'domain_events']) {
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()).toEqual({ n: 0 });
    }
  } finally { f.close(); }
});

test('summary and preview recheck selected-domain owner permission, session and payload', async () => {
  const f = setup();
  try {
    expect((await f.summary(selected, '')).status).toBe(401);
    expect((await f.summary(selected, f.reader)).status).toBe(403);
    expect((await f.summary(foreign)).status).toBe(403);
    expect((await f.preview({ request_scope: { ...request_scope, data_domain: foreign } })).status).toBe(403);
    expect((await f.preview({ request_scope }, { origin: 'https://fixture.invalid' })).status).toBe(403);
    expect((await f.preview({ request_scope }, { auth: f.other })).status).toBe(403);
    expect((await f.preview({ request_scope }, { auth: f.reader })).status).toBe(403);
    expect((await f.preview({ request_scope: { ...request_scope, caller_id: 'forged' } })).status).toBe(403);
    expect((await f.preview({ request_scope, recipient: 'recipient' })).status).toBe(422);
    expect((await f.preview({ request_scope }, { revision: 0 })).status).toBe(422);
    expect((await f.preview({ request_scope }, { hash: '0'.repeat(64) })).status).toBe(422);
    f.db.prepare('UPDATE caller_scopes SET revoked_at=? WHERE account_id=? AND caller_id=? AND data_domain=?').run(at, owner, caller, selected);
    expect((await f.summary()).status).toBe(403);
    expect((await f.preview()).status).toBe(403);
    f.db.prepare('UPDATE accounts SET auth_epoch=2 WHERE account_id=?').run(owner);
    expect((await f.summary()).status).toBe(401);
    expect((await f.preview({ request_scope }, { auth: f.session() })).status).toBe(403);
  } finally { f.close(); }
});
