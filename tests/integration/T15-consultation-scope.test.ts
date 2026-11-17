import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../apps/service/src/app.js';
import { issueBootstrapTicket, issueCallerSession, ORIGIN } from '../../apps/service/src/auth.js';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { openDatabase } from '../../packages/storage/src/database.js';

const now = () => new Date('2026-11-17T05:00:00Z');
let directory: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let credentials: ReturnType<typeof createCredentialStore>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'patrick-t15-consult-scope-'));
  const databasePath = join(directory, 'patrick.sqlite');
  const credentialDirectory = join(directory, 'credentials');
  db = openDatabase(databasePath);
  credentials = createCredentialStore(credentialDirectory, now);
  app = createApp({ databasePath, credentialDirectory, now });
  issueBootstrapTicket(db, { accountId: 'personal-owner' }, now);
  issueBootstrapTicket(db, { accountId: 'different-owner' }, now);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function session(accountId: string, callerId: string, domain: string, permissions: readonly string[]) {
  return issueCallerSession(db, { accountId, callerId, domain, permissions }, now, credentials).token;
}

function submit(token: string, key: string, payload: Json, path = '/api/v1/consultations') {
  const payload_hash = createHash('sha256').update(canonicalPayload(payload)).digest('hex');
  return app.request(path, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie: 'patrick_session=' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ client_request_id: key, expected_revision: null, payload_hash, payload }),
  });
}

const scoped = {
  text: '只问这个资料域', parent_work_id: null,
  request_scope: { account_id: 'personal-owner', caller_id: 'web', data_domain: 'personal', permission_epoch: 1 },
};
const counts = () => Object.fromEntries(['consultations', 'conversations', 'command_inbox', 'business_budgets', 'domain_events']
  .map((table) => [table, db.prepare('SELECT COUNT(*) AS n FROM ' + table).pluck().get()]));

test('resource-free commands reject an absent scope, and cannot silently use another permitted domain', async () => {
  const token = session('personal-owner', 'web', 'personal', ['work.read']);
  session('personal-owner', 'web', 'work-company', ['consultations.write', 'conversations.write']);
  const baseline = counts();
  expect((await submit(token, 'no-scope', { text: '没有绑定', parent_work_id: null })).status).toBe(422);
  expect((await submit(token, 'wrong-domain', scoped)).status).toBe(403);
  expect((await submit(token, 'wrong-chat-domain', { text: scoped.text, request_scope: scoped.request_scope }, '/api/v1/conversations')).status).toBe(403);
  expect(counts()).toEqual(baseline);

  const domain = 'work-company';
  const accepted = await submit(token, 'company-confirmed', { ...scoped, request_scope: { ...scoped.request_scope, data_domain: domain } });
  expect(accepted.status).toBe(202);
  expect(db.prepare('SELECT account_id,caller_id,data_domain FROM consultations').all())
    .toEqual([{ account_id: 'personal-owner', caller_id: 'web', data_domain: domain }]);
});

test('an already fetched tab cannot write into a replacement account, caller, or permission epoch', async () => {
  const original = session('personal-owner', 'web', 'personal', ['owner']);
  const otherAccount = session('different-owner', 'web', 'personal', ['owner']);
  const otherCaller = session('personal-owner', 'web-other', 'personal', ['owner']);
  const observed = await app.request('/api/v1/session', { headers: { cookie: 'patrick_session=' + original } });
  expect(observed.status).toBe(200);
  expect(await observed.json()).toMatchObject({ scope: { account_id: 'personal-owner', data_domain: 'personal', permission_epoch: 1 } });
  const baseline = counts();
  expect((await submit(otherAccount, 'stale-account', scoped)).status).toBe(403);
  expect((await submit(otherCaller, 'stale-caller', scoped)).status).toBe(403);

  db.prepare("UPDATE accounts SET auth_epoch=2 WHERE account_id='personal-owner'").run();
  const replacement = session('personal-owner', 'web', 'personal', ['owner']);
  expect((await submit(replacement, 'stale-epoch', scoped)).status).toBe(403);
  expect(counts()).toEqual(baseline);
});
