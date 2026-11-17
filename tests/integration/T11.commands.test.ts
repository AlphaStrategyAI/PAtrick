import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createApp } from '../../apps/service/src/app.js';
import { issueBootstrapTicket, issueCallerSession, ORIGIN } from '../../apps/service/src/auth.js';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import { createConsultationApi } from '../../packages/domain/src/consultations.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { openDatabase } from '../../packages/storage/src/database.js';

const account = 'account';
const caller = 'caller';
const primary = 'alpha';
const secondary = 'beta';
const now = () => new Date('2026-11-17T04:00:00Z');
const consultBase = '/api/v1/consultations';
const conversationBase = '/api/v1/conversations';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'patrick-t11-commands-'));
  const databasePath = join(directory, 'patrick.sqlite');
  const credentialDirectory = join(directory, 'credentials');
  const db = openDatabase(databasePath);
  const credentials = createCredentialStore(credentialDirectory, now);
  const app = createApp({ databasePath, credentialDirectory, now });
  const api = createConsultationApi(db, { now });
  const owner = { account_id: account, caller_id: caller, auth_epoch: 1, domains: [primary, secondary], operations: ['owner'] };
  issueBootstrapTicket(db, { accountId: account }, now);
  function session(domain: string, permissions: readonly string[]) {
    return issueCallerSession(db, { accountId: account, callerId: caller, domain, permissions }, now, credentials).authorization;
  }
  async function openWork(domain: string, id: string) {
    const delegation = createDelegationApi(db, owner, { now, domain });
    const scope = { actions: ['judge'], resources: ['work'], effects: ['publish_pr'], domains: [domain], risk: 'low' as const, level: 'L1' as const };
    await delegation.registerMandateType({
      ...scope, type_id: `type-${id}`, budget_micros: 10000, config_version: 1,
    });
    await delegation.openMandate({
      ...scope, mandate_id: `mandate-${id}`, type_id: `type-${id}`, budget_micros: 10000, expires_at: '2027-01-01T00:00:00Z',
    });
    await delegation.openWork({
      work_id: id, generation: 1, mandate_id: `mandate-${id}`, phase: 'judgment', next_action: 'judge', budget_micros: 10000,
    });
  }
  return {
    db, app, api, session, openWork, context: () => ({ db, credentials, now }),
    newConversation: (id: string, domain = primary) => api.createConversation(owner, {
      client_request_id: id, data_domain: domain, text: id,
    }),
    newConsultation: (id: string, domain = primary) => api.createConsultation(owner, {
      client_request_id: id, data_domain: domain, text: id, parent_work_id: null,
    }),
    post(authorization: string, path: string, clientRequestId: string, payload: Json, revision: number | null = null) {
      return app.request(path, {
        method: 'POST',
        headers: { authorization, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          client_request_id: clientRequestId, expected_revision: revision, payload,
          payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex'),
        }),
      });
    },
    counts() {
      return {
        consultations: db.prepare('SELECT * FROM consultations ORDER BY request_id').all(),
        conversations: db.prepare('SELECT * FROM conversations ORDER BY conversation_id').all(),
        messages: db.prepare('SELECT * FROM messages ORDER BY message_id').all(),
        events: db.prepare('SELECT * FROM domain_events ORDER BY event_id').all(),
        outbox: db.prepare('SELECT * FROM outbox ORDER BY event_id').all(),
        budgets: db.prepare('SELECT * FROM business_budgets ORDER BY business_id').all(),
        commands: db.prepare('SELECT * FROM command_inbox ORDER BY command_id').all(),
        receipts: db.prepare('SELECT * FROM command_records ORDER BY command_id').all(),
      };
    },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test.each(['consult', 'cancel', 'conversation', 'message', 'link'] as const)(
  '%s rolls back all writes when the receipt fails and safely retries',
  async (operation) => {
    const fx = fixture();
    try {
      const auth = fx.session(primary, ['owner']);
      const conversation = await fx.newConversation('initial-conversation');
      const consult = await fx.newConsultation('initial-consultation');
      if (operation === 'link') await fx.openWork(primary, 'W-link');
      const submit = {
        consult: () => fx.post(auth, consultBase, 'test-command', { text: 'Question', parent_work_id: null }),
        cancel: () => fx.post(auth, `${consultBase}/${consult.request_id}/cancel`, 'test-command', {}, 0),
        conversation: () => fx.post(auth, conversationBase, 'test-command', { text: 'New conversation' }),
        message: () => fx.post(auth, `${conversationBase}/${conversation.conversation_id}/messages`, 'test-command', { text: 'New message' }),
        link: () => fx.post(auth, `${conversationBase}/${conversation.conversation_id}/work-links`, 'test-command', { work_id: 'W-link' }, 0),
      }[operation];
      const baseline = fx.counts();
      fx.db.exec(`CREATE TRIGGER reject_test_receipt BEFORE INSERT ON command_records
        BEGIN SELECT RAISE(ABORT, 'test receipt write failure'); END`);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect((await submit()).status).toBe(503);
      } finally {
        log.mockRestore();
        fx.db.exec('DROP TRIGGER reject_test_receipt');
      }
      expect(fx.counts()).toEqual(baseline);
      const retry = await submit();
      expect(retry.status).toBe(202);
      const receipt = await retry.json() as { command_id: string };
      const read = await fx.app.request(`/api/v1/commands/${receipt.command_id}`, { headers: { authorization: auth } });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ data: { command_id: receipt.command_id } });
      const after = fx.counts();
      expect(after).not.toEqual(baseline);
      expect(after.receipts).toHaveLength(1);
      const replay = await submit();
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(receipt);
      expect(fx.counts()).toEqual(after);
      fx.db.prepare(`UPDATE caller_scopes SET revoked_at = ?
        WHERE account_id = ? AND caller_id = ? AND data_domain = ? AND permission = 'owner'`)
        .run(now().toISOString(), account, caller, primary);
      fx.session(secondary, ['owner']);
      const revokedRead = await fx.app.request(`/api/v1/commands/${receipt.command_id}`, { headers: { authorization: auth } });
      expect(revokedRead.status).toBe(403);
    } finally {
      fx.close();
    }
  },
);

test.each(['messages', 'work-links'] as const)(
  'reusing a %s command key on another conversation conflicts',
  async (endpoint) => {
    const fx = fixture();
    try {
      const auth = fx.session(primary, ['owner']);
      const first = await fx.newConversation('first');
      const second = await fx.newConversation('second');
      if (endpoint === 'work-links') await fx.openWork(primary, 'W-link');
      const payload: Json = endpoint === 'messages' ? { text: 'Same body' } : { work_id: 'W-link' };
      const rev = endpoint === 'messages' ? null : 0;
      const submit = (id: string) => fx.post(auth, `${conversationBase}/${id}/${endpoint}`, 'same-key', payload, rev);
      expect((await submit(first.conversation_id)).status).toBe(202);
      const conflicting = await submit(second.conversation_id);
      expect(conflicting.status).toBe(409);
      expect(await conflicting.json()).toMatchObject({ code: 'CONFLICT', params: { reason: 'idempotency' } });
    } finally {
      fx.close();
    }
  },
);

test('permissions in another domain cannot authorize conversation or consultation access', async () => {
  const fx = fixture();
  try {
    const auth = fx.session(primary, ['owner']);
    fx.session(secondary, ['unrelated-permission']);
    const accessible = await fx.newConversation('allowed', primary);
    const hidden = await fx.newConversation('denied', secondary);
    const consult = await fx.newConsultation('denied-consult', secondary);
    await fx.openWork(secondary, 'W-private');
    const postMessage = fx.post(auth, `${conversationBase}/${hidden.conversation_id}/messages`, 'cross-message', { text: 'New message' });
    const cancel = fx.post(auth, `${consultBase}/${consult.request_id}/cancel`, 'cross-cancel', {}, 0);
    const linkedConsult = fx.post(auth, consultBase, 'cross-parent', { text: 'Question', parent_work_id: 'W-private' });
    const readMessages = fx.app.request(`${conversationBase}/${hidden.conversation_id}/messages`, { headers: { authorization: auth } });
    const readConsult = fx.app.request(`${consultBase}/${consult.request_id}`, { headers: { authorization: auth } });
    expect((await Promise.all([postMessage, cancel, linkedConsult, readMessages, readConsult])).map((response) => response.status))
      .toEqual([403, 403, 403, 403, 403]);
    const list = await fx.app.request(conversationBase, { headers: { authorization: auth } });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ data: { items: [{ conversation_id: accessible.conversation_id }] } });
  } finally {
    fx.close();
  }
});

test('an MCP memory grant does not grant Web command access', async () => {
  const fx = fixture();
  try {
    const auth = fx.session(primary, ['mcp:memory']);
    const consult = await fx.newConsultation('seed');
    const response = await fx.post(auth, `${consultBase}/${consult.request_id}/cancel`, 'try-cancel', {}, 0);
    expect(response.status).toBe(403);
    const create = await fx.post(auth, conversationBase, 'try-start', { text: 'New conversation' });
    expect(create.status).toBe(403);
  } finally {
    fx.close();
  }
});

test('the MCP service entry accepts only bearer credentials with the resolved tool grant', async () => {
  const { createAuthenticatedConsultationMcp } = await import('../../apps/service/src/consultation-mcp.js');
  const fx = fixture();
  try {
    const memoryOnly = fx.session(primary, ['mcp:memory']);
    fx.session(secondary, ['mcp:consult']);
    const request = new Request('http://localhost', { headers: { authorization: memoryOnly } });
    const cookieOnly = new Request('http://localhost', { headers: { cookie: 'patrick_session=' + memoryOnly.slice('Bearer '.length) } });
    const mcp = createAuthenticatedConsultationMcp(fx.context);
    const text = 'memory';
    await expect(mcp.call('patrick_memory_query', cookieOnly, { text, domain: primary })).rejects.toMatchObject({ status: 401 });
    await expect(mcp.call('patrick_memory_query', request, { text, domain: secondary })).rejects.toMatchObject({ status: 403 });
    const consult = await fx.newConsultation('private-result', primary);
    await expect(mcp.call('patrick_consult_result', request, { request_id: consult.request_id })).rejects.toMatchObject({ status: 403 });
    await fx.openWork(primary, 'W-alpha');
    await expect(mcp.call('patrick_consult', request, {
      data_domain: secondary, parent_work_id: 'W-alpha', client_request_id: 'cross-domain-tool', text,
    })).rejects.toMatchObject({ status: 403 });
    await expect(mcp.call('patrick_memory_query', request, { text, domain: primary })).resolves.toEqual({ items: [] });
    fx.db.prepare(`UPDATE caller_scopes SET revoked_at = ?
      WHERE account_id = ? AND caller_id = ? AND data_domain = ? AND permission = 'mcp:memory'`)
      .run(now().toISOString(), account, caller, primary);
    await expect(mcp.call('patrick_memory_query', request, { text, domain: primary })).rejects.toMatchObject({ status: 403 });
  } finally {
    fx.close();
  }
});

test('MCP memory reads the current withdrawal epoch and stays within the authenticated account', async () => {
  const { createAuthenticatedConsultationMcp } = await import('../../apps/service/src/consultation-mcp.js');
  const fx = fixture();
  try {
    const authorization = fx.session(primary, ['mcp:memory']);
    const request = new Request('http://localhost', { headers: { authorization } });
    const mcp = createAuthenticatedConsultationMcp(fx.context);
    const seed = (id: string, owner: string, withdrawal: number | null) => {
      const stamp = now().toISOString();
      fx.db.prepare(`INSERT INTO knowledge_records VALUES (?, ?, ?, ?, 1, 'candidate', ?, ?, '1.0', ?, ?)`)
        .run(id, id, owner, primary, id, 'memory', stamp, stamp);
      fx.db.prepare(`INSERT INTO evidence_refs VALUES (?, ?, ?, NULL, NULL, 'vault', 'supported', ?, NULL, ?)`)
        .run(id, id, primary, withdrawal, stamp);
      fx.db.prepare('INSERT INTO knowledge_fts (knowledge_id, data_domain, tokens) VALUES (?, ?, ?)')
        .run(id, primary, 'memory');
    };
    seed('visible', account, null);
    seed('withdrawn', account, 8);
    seed('another-account', 'different', null);
    const query = () => mcp.call('patrick_memory_query', request, { text: 'memory', domain: primary, withdrawalEpoch: 0 });
    expect(await query()).toMatchObject({ items: [{ knowledge_id: 'visible' }, { knowledge_id: 'withdrawn' }] });
    fx.db.prepare(`INSERT INTO withdrawal_events VALUES (?, ?, 'evidence', ?, 1, 8, 'withdrawn', ?)`)
      .run('withdrawal-8', primary, 'withdrawn', now().toISOString());
    expect(await query()).toMatchObject({ items: [{ knowledge_id: 'visible' }] });
  } finally {
    fx.close();
  }
});

test('each issued MCP bearer keeps its original domain and action grants', async () => {
  const { createAuthenticatedConsultationMcp } = await import('../../apps/service/src/consultation-mcp.js');
  const fx = fixture();
  try {
    const request = (authorization: string) => new Request('http://localhost', { headers: { authorization } });
    const first = request(fx.session(primary, ['mcp:memory']));
    const second = request(fx.session(secondary, ['mcp:memory', 'mcp:consult']));
    const consult = request(fx.session(primary, ['mcp:consult']));
    const mcp = createAuthenticatedConsultationMcp(fx.context);
    const query = (credential: Request, domain: string) => mcp.call('patrick_memory_query', credential, { text: 'memory', domain });
    const create = (credential: Request, domain: string, id: string) => mcp.call('patrick_consult', credential, {
      data_domain: domain, parent_work_id: null, client_request_id: id, text: 'Question',
    });
    await expect(query(first, primary)).resolves.toEqual({ items: [] });
    await expect(query(first, secondary)).rejects.toMatchObject({ status: 403 });
    await expect(create(first, primary, 'wrong-action')).rejects.toMatchObject({ status: 403 });
    await expect(create(first, secondary, 'wrong-domain-and-action')).rejects.toMatchObject({ status: 403 });
    await expect(query(second, secondary)).resolves.toEqual({ items: [] });
    await expect(create(second, secondary, 'allowed-beta')).resolves.toMatchObject({ status: 'pending' });
    const result = await create(consult, primary, 'allowed-alpha') as { request_id: string };
    await expect(mcp.call('patrick_consult_result', first, { request_id: result.request_id })).rejects.toMatchObject({ status: 403 });
    await expect(mcp.call('patrick_consult_result', consult, { request_id: result.request_id })).resolves.toMatchObject(result);
    fx.db.prepare(`UPDATE caller_scopes SET revoked_at = ?
      WHERE account_id = ? AND caller_id = ? AND data_domain = ? AND permission = 'mcp:memory'`)
      .run(now().toISOString(), account, caller, primary);
    await expect(query(first, primary)).rejects.toMatchObject({ status: 403 });
    await expect(query(second, secondary)).resolves.toEqual({ items: [] });
  } finally {
    fx.close();
  }
});

test('MCP does not accept an owner session that gained a live tool grant after issuance', async () => {
  const { createAuthenticatedConsultationMcp } = await import('../../apps/service/src/consultation-mcp.js');
  const fx = fixture();
  try {
    const owner = fx.session(primary, ['owner']);
    const mcp = createAuthenticatedConsultationMcp(fx.context);
    const request = new Request('http://localhost', { headers: { authorization: owner } });
    const query = () => mcp.call('patrick_memory_query', request, { text: 'memory', domain: primary });
    await expect(query()).rejects.toMatchObject({ status: 403 });
    const mcpBearer = fx.session(primary, ['mcp:memory']);
    await expect(query()).rejects.toMatchObject({ status: 403 });
    expect((await fx.post(owner, conversationBase, 'web-still-works', { text: 'Allowed Web use' })).status).toBe(202);
    expect((await fx.post(mcpBearer, conversationBase, 'tool-cannot-write', { text: 'Web use' })).status).toBe(403);
  } finally {
    fx.close();
  }
});

test.each(['missing', 'invalid JSON', 'unsupported version', 'invalid actions', 'different token'] as const)(
  'MCP rejects a session with %s protected scope data',
  async (failure) => {
    const { createAuthenticatedConsultationMcp } = await import('../../apps/service/src/consultation-mcp.js');
    const fx = fixture();
    try {
      const auth = fx.session(primary, ['mcp:memory']);
      const tokenHash = createHash('sha256').update(auth.slice('Bearer '.length)).digest('hex');
      const credentials = fx.context().credentials;
      const binding = {
        version: 1, account_id: account, caller_id: caller, domain: primary,
        auth_epoch: 1, token_hash: tokenHash, permissions: ['mcp:memory'],
      };
      const reference = {
        missing: () => 'cred_nonexistent',
        'invalid JSON': () => credentials.put(Buffer.from('not JSON'), 60_000),
        'unsupported version': () => credentials.put(Buffer.from(JSON.stringify({ ...binding, version: 2 })), 60_000),
        'invalid actions': () => credentials.put(Buffer.from(JSON.stringify({ ...binding, permissions: ['mcp:memory', 'owner'] })), 60_000),
        'different token': () => credentials.put(Buffer.from(JSON.stringify({ ...binding, token_hash: 'a'.repeat(64) })), 60_000),
      }[failure]();
      fx.db.prepare('UPDATE sessions SET credential_ref = ? WHERE token_hash = ?').run(reference, tokenHash);
      const request = new Request('http://localhost', { headers: { authorization: auth } });
      await expect(createAuthenticatedConsultationMcp(fx.context).call('patrick_memory_query', request, {
        text: 'memory', domain: primary,
      })).rejects.toMatchObject({ status: 401 });
    } finally {
      fx.close();
    }
  },
);

test('an unbound legacy MCP session must be reissued', async () => {
  const { createAuthenticatedConsultationMcp } = await import('../../apps/service/src/consultation-mcp.js');
  const fx = fixture();
  try {
    // The legacy issuer kept the token opaque and wrote a random 32-byte secret without the scope.
    const inheritedPermissions = fx.session(primary, ['mcp:memory']);
    const currentHash = createHash('sha256').update(inheritedPermissions.slice('Bearer '.length)).digest('hex');
    const legacyToken = Buffer.alloc(32, 0x63).toString('base64url');
    const legacyHash = createHash('sha256').update(legacyToken).digest('hex');
    const legacyRef = fx.context().credentials.put(Buffer.alloc(32, 0x73), 60_000);
    fx.db.prepare(`INSERT INTO sessions (token_hash, account_id, caller_id, auth_epoch, expires_at, authenticated_at, credential_ref)
      SELECT ?, account_id, caller_id, auth_epoch, expires_at, authenticated_at, ? FROM sessions WHERE token_hash = ?`)
      .run(legacyHash, legacyRef, currentHash);
    const request = new Request('http://localhost', { headers: { authorization: 'Bearer ' + legacyToken } });
    await expect(createAuthenticatedConsultationMcp(fx.context).call('patrick_memory_query', request, {
      text: 'memory', domain: primary,
    })).rejects.toMatchObject({ status: 403 });
  } finally {
    fx.close();
  }
});
