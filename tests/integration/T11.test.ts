import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import { MCP_TOOLS } from '../../packages/contracts/src/resources.js';
import { createBudgetApi } from '../../packages/domain/src/budget.js';
import { createConsultationApi } from '../../packages/domain/src/consultations.js';
import { createDelegationApi, type AdmissionPrincipal } from '../../packages/domain/src/delegation.js';
import { dispatchPaidNext } from '../../packages/executor/harness/patrick-bridge.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { createConsultationHubPort } from '../../packages/integrations/autoloop/consultation-port.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';
import { ackOutbox, appendDomainEvent } from '../../packages/storage/src/outbox.js';
import { createApp } from '../../apps/service/src/app.js';
import { issueBootstrapTicket, issueCallerSession, ORIGIN } from '../../apps/service/src/auth.js';

const NOW = '2026-11-17T04:00:00.000Z';
const DOMAIN = 'product';
const WORK_ID = 'W-017';
const GENERATION = 1;

const owner: AdmissionPrincipal = {
  account_id: 'owner',
  caller_id: 'web',
  auth_epoch: 1,
  domains: [DOMAIN],
  operations: ['owner', 'consultations.read', 'consultations.write', 'conversations.read', 'conversations.write'],
};

const contextRequest = {
  client_request_id: 'consult-while-waits',
  text: '等待决定时，这条工作现在卡在哪？',
  data_domain: DOMAIN,
  parent_work_id: null as string | null,
};

const answer = { text: '父工作仍在等待，这次咨询不继续它。' };

test('consult-while-work-waits', async () => {
  const fx = temporaryDatabase();
  const now = () => new Date(NOW);
  const second = openDatabase(fx.databasePath);
  try {
    const delegation = createDelegationApi(fx.db, owner, { now, domain: DOMAIN });
    await openWaitingWork(delegation);
    const before = parentLedger(fx.db, WORK_ID);
    expect(before).toEqual({ held: 0, spent: 0, attempts: 0, effects: 0, awaiting_answer: 1 });
    const api = createConsultationApi(fx.db, { now });
    const otherDb = createConsultationApi(second, { now });
    const createConsultation = (principal: AdmissionPrincipal, request: typeof contextRequest) =>
      api.createConsultation(principal, request);
    const completeConsultation = (requestId: string, version: number, finalAnswer: { text: string }) =>
      api.completeConsultation(requestId, version, finalAnswer);
    const cancelConsultation = (principal: AdmissionPrincipal, requestId: string, version: number) =>
      otherDb.cancelConsultation(principal, requestId, version);

    const c = await createConsultation(owner, { ...contextRequest, client_request_id: 'race-1', parent_work_id: WORK_ID });
    const winners = await Promise.all([
      completeConsultation(c.request_id, c.result_version, answer),
      cancelConsultation(owner, c.request_id, c.result_version),
    ]);
    expect(winners.filter(Boolean)).toHaveLength(1);
    expect(await businessAttempts(fx.db, WORK_ID)).toBe(0);
    const raced = fx.db.prepare('SELECT status, final_result, result_version FROM consultations WHERE request_id = ?').get(c.request_id) as {
      status: string;
      final_result: string | null;
      result_version: number;
    };
    const racedFinals = fx.db.prepare(`SELECT COUNT(*) AS n FROM messages
      WHERE conversation_id = ? AND kind = 'final_answer'`).get(c.conversation_id) as { n: number };
    expect(raced.result_version).toBe(c.result_version + 1);
    expect(raced.status === 'answered' || raced.status === 'cancelled').toBe(true);
    expect(Boolean(raced.final_result)).toBe(raced.status === 'answered');
    expect(racedFinals.n).toBe(raced.status === 'answered' ? 1 : 0);
    expect(await completeConsultation(c.request_id, c.result_version, answer)).toBe(false);
    expect(await otherDb.cancelConsultation(owner, c.request_id, c.result_version)).toBe(false);
    expect(parentLedger(fx.db, WORK_ID)).toEqual(before);

    const replayed = await createConsultation(owner, { ...contextRequest, parent_work_id: WORK_ID });
    const same = await createConsultation(owner, { ...contextRequest, parent_work_id: WORK_ID });
    expect(same).toEqual(replayed);
    await expect(createConsultation(owner, { ...contextRequest, text: '另一句', parent_work_id: WORK_ID })).rejects.toThrow('CONFLICT');
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM domain_events WHERE event_id = ?`).get(`consultation.requested:${replayed.request_id}`)).toEqual({ n: 1 });
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM domain_events WHERE aggregate_id = ?`).get(WORK_ID)).toEqual({ n: 0 });

    const posted: Array<{ type: string; subject: string; hops: number }> = [];
    expect(await api.dispatchConsultation(replayed.request_id, createConsultationHubPort(fx.db, {
      async postEvent(body: { type: string; subject: string; hops: number }) {
        posted.push(body);
        return { event: posted.length, duplicate: false, routed: ['咨询'] };
      },
    }))).toBe('accepted');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'consultation.requested', subject: replayed.request_id, hops: 0 });
    expect(await api.dispatchConsultation(replayed.request_id, createConsultationHubPort(fx.db, {
      async postEvent(body: { type: string; subject: string; hops: number }) {
        posted.push(body);
        return { event: posted.length, duplicate: true, routed: ['咨询'] };
      },
    }))).toBe('duplicate');

    const billing = billingDouble(fx.db, owner, now);
    const run = await api.runConsultation(owner, replayed.request_id, billing);
    expect(run.sent).toBe(true);
    expect(run.completed).toBe(true);
    expect(billing.sends).toBe(1);
    expect(billing.businessIds).toEqual([`consultation:${replayed.request_id}`]);
    expect(run.grant?.subject_kind).toBe('consultation');
    if (!run.grant) throw new Error('missing consultation grant');
    expect(await delegation.authorizeBusinessEffect(run.grant, { work_id: WORK_ID, generation: GENERATION, action: 'publish_pr' })).toBe(false);
    const repeated = await createConsultation(owner, { ...contextRequest, parent_work_id: WORK_ID });
    expect(repeated.request_id).toBe(replayed.request_id);
    const secondRun = await api.runConsultation(owner, replayed.request_id, billing);
    expect(secondRun.sent).toBe(false);
    expect(billing.sends).toBe(1);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM budget_reservations WHERE business_id = ?').get(`consultation:${replayed.request_id}`)).toEqual({ n: 1 });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM budget_reservations WHERE business_id = ?').get(`work:${WORK_ID}`)).toEqual({ n: 0 });
    expect(parentLedger(fx.db, WORK_ID)).toEqual(before);

    const directApi = createConsultationApi(fx.db, {
      now,
      knownAnswer: (text: string) => (text === '已知问题' ? { text: '直接答案' } : null),
    });
    const direct = await directApi.createConsultation(owner, {
      client_request_id: 'direct-1',
      text: '已知问题',
      data_domain: DOMAIN,
      parent_work_id: null,
    });
    expect(direct.status).toBe('answered');
    expect(direct.result_version).toBe(1);
    expect(await directApi.createConsultation(owner, {
      client_request_id: 'direct-1',
      text: '已知问题',
      data_domain: DOMAIN,
      parent_work_id: null,
    })).toEqual(direct);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM domain_events WHERE event_id = ?').get(`consultation.requested:${direct.request_id}`)).toEqual({ n: 0 });
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND kind = 'final_answer'`).get(direct.conversation_id)).toEqual({ n: 1 });
    expect(billing.sends).toBe(1);

    const conversation = await api.createConversation(owner, {
      client_request_id: 'conv-1',
      text: '同意',
      data_domain: DOMAIN,
    });
    expect(conversation.work_id).toBeNull();
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM answer_receipts').get()).toEqual({ n: 0 });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM decision_submissions').get()).toEqual({ n: 0 });
    const linked = await api.linkConversationWork(owner, conversation.conversation_id, WORK_ID, 0);
    expect(linked.work_id).toBe(WORK_ID);
    expect(await api.linkConversationWork(owner, conversation.conversation_id, WORK_ID, 0)).toEqual(linked);
    await expect(api.linkConversationWork(owner, conversation.conversation_id, 'W-other', linked.revision)).rejects.toThrow('CONFLICT');
    await expect(api.linkConversationWork(owner, direct.conversation_id, WORK_ID, 0)).rejects.toThrow('UNPROCESSABLE');
    const workMessages = await api.listMessages(owner, conversation.conversation_id);
    const directMessages = await api.listMessages(owner, direct.conversation_id);
    expect(workMessages.map((item) => item.raw_text)).toEqual(['同意']);
    expect(directMessages.some((item) => item.raw_text === '同意')).toBe(false);
    expect(directMessages.some((item) => item.raw_text === '直接答案')).toBe(true);
    expect(parentLedger(fx.db, WORK_ID)).toEqual(before);

    const credentialDirectory = join(fx.dir, 'credentials');
    const app = createApp({ databasePath: fx.databasePath, credentialDirectory, now });
    issueBootstrapTicket(fx.db, { accountId: 'owner' }, now);
    const store = createCredentialStore(credentialDirectory, now);
    const session = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'web',
      domain: DOMAIN,
      permissions: ['owner', 'consultations.read', 'consultations.write', 'conversations.read', 'conversations.write'],
    }, now, store);
    const otherCaller = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'other',
      domain: DOMAIN,
      permissions: ['consultations.read', 'consultations.write', 'conversations.read'],
    }, now, store);
    const otherCallerApi = {
      get: (path: string) => app.request(path, { headers: { authorization: otherCaller.authorization } }),
    };
    expect((await otherCallerApi.get('/api/v1/consultations/' + c.request_id)).status).toBe(403);
    const ownerHeaders = { authorization: session.authorization };
    const firstRead = await app.request(`/api/v1/consultations/${replayed.request_id}`, { headers: ownerHeaders });
    const secondRead = await app.request(`/api/v1/consultations/${replayed.request_id}`, { headers: ownerHeaders });
    expect(firstRead.status).toBe(200);
    expect(secondRead.status).toBe(200);
    const firstBody = await firstRead.json() as { schema_version: string; freshness: string; data: { request_id: string; final_result: { text: string } | null } };
    const secondBody = await secondRead.json() as { data: { request_id: string; final_result: { text: string } | null } };
    expect(firstBody.schema_version).toBe('1.0');
    expect(firstBody.freshness).toBe('fresh');
    expect(firstBody.data).toEqual(secondBody.data);
    expect(firstBody.data.request_id).toBe(replayed.request_id);
    expect(firstBody.data.final_result).toEqual({ text: '隔离咨询的回答' });

    const httpPayload = { text: '再问一次，不派工作', parent_work_id: WORK_ID };
    const httpBody = envelope('http-consult-1', null, httpPayload);
    const created = await app.request('/api/v1/consultations', {
      method: 'POST',
      headers: { ...ownerHeaders, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(httpBody),
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json() as { command_id: string; state: string; receipt_url: string };
    expect(createdBody).toMatchObject({ state: 'received' });
    const replay = await app.request('/api/v1/consultations', {
      method: 'POST',
      headers: { ...ownerHeaders, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(httpBody),
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(createdBody);
    const httpId = createdBody.receipt_url.split('/').at(-1) ?? '';
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM domain_events WHERE event_id = ?').get(`consultation.requested:${httpId}`)).toEqual({ n: 1 });
    const listed = await app.request('/api/v1/conversations', { headers: ownerHeaders });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { data: { items: Array<{ conversation_id: string }> } };
    expect(listedBody.data.items.map((item) => item.conversation_id)).toContain(conversation.conversation_id);

    const { createConsultationMcp } = await import('../../packages/integrations/mcp/consultation.js');
    const knowledgeBefore = fx.db.prepare('SELECT COUNT(*) AS n FROM knowledge_records').get() as { n: number };
    const messageBefore = fx.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    const mcp = createConsultationMcp<AdmissionPrincipal>({
      consult: (principal, request) => api.createConsultation(principal, request),
      result: (principal, requestId) => api.readConsultation(principal, requestId),
      memory: async (principal, query) => {
        const { queryEvidence } = await import('../../packages/domain/src/evidence.js');
        return queryEvidence(fx.db, query, principal);
      },
    });
    expect(mcp.list()).toEqual(['patrick_consult', 'patrick_consult_result', 'patrick_memory_query']);
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(mcp.list());
    const memory = await mcp.call('patrick_memory_query', owner, { text: 'memory', domain: DOMAIN, withdrawalEpoch: 0 });
    expect(memory).toEqual({ items: [] });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM knowledge_records').get()).toEqual(knowledgeBefore);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual(messageBefore);
    await expect(mcp.call('patrick_host', owner, {})).rejects.toThrow('UNKNOWN_TOOL');
    const viaTool = await mcp.call('patrick_consult', owner, {
      client_request_id: 'mcp-1',
      text: '工具里问一句',
      data_domain: DOMAIN,
      parent_work_id: null,
    }) as { request_id: string };
    const viaToolAgain = await mcp.call('patrick_consult', owner, {
      client_request_id: 'mcp-1',
      text: '工具里问一句',
      data_domain: DOMAIN,
      parent_work_id: null,
    }) as { request_id: string };
    expect(viaToolAgain.request_id).toBe(viaTool.request_id);
    const toolRead = await mcp.call('patrick_consult_result', owner, { request_id: viaTool.request_id }) as { request_id: string };
    expect(toolRead.request_id).toBe(viaTool.request_id);
    await expect(mcp.call('patrick_consult_result', { ...owner, caller_id: 'other' }, { request_id: viaTool.request_id })).rejects.toThrow('FORBIDDEN');
    expect(billing.sends).toBe(1);
    expect(parentLedger(fx.db, WORK_ID)).toEqual(before);

    const source = readFileSync(fileURLToPath(new URL('../../packages/domain/src/consultations.ts', import.meta.url)), 'utf8');
    expect(source).toContain(`UPDATE consultations
SET status = 'answered', final_result = @answer, result_version = result_version + 1
WHERE request_id = @request_id AND result_version = @expected_revision
  AND status IN ('pending', 'waiting_user')
RETURNING result_version;`);
    expect(source).toContain('withImmediateTransaction');
    expect(source).not.toContain('integrations/autoloop');
    const migration = readFileSync(fileURLToPath(new URL('../../packages/storage/migrations/0011_conversations.sql', import.meta.url)), 'utf8');
    expect(migration).toContain('ALTER TABLE consultations');
    expect(migration).not.toContain('CREATE TABLE consultations');
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../packages/storage/migrations/manifest.json', import.meta.url)), 'utf8')) as Array<{ file: string; sha256: string }>;
    expect(manifest.at(-1)?.file).toBe('0011_conversations.sql');
    expect(manifest.at(-2)).toEqual({
      file: '0010_answers_channels.sql',
      sha256: '2d70545abe54c8ba81402f77db6de09c9153ae50ba0bfec844f38626957b752b',
    });
    expect(manifest.at(-1)?.sha256).toBe(createHash('sha256').update(migration).digest('hex'));
    const applied = fx.db.prepare('SELECT file FROM schema_migrations ORDER BY position').all() as Array<{ file: string }>;
    expect(applied.map((entry) => entry.file)).toEqual(manifest.map((entry) => entry.file));
  } finally {
    second.close();
    fx.close();
  }
});

test('paid-send-completes-after-crash', async () => {
  const fx = temporaryDatabase();
  const now = () => new Date(NOW);
  try {
    const delegation = createDelegationApi(fx.db, owner, { now, domain: DOMAIN });
    await openWaitingWork(delegation);
    const before = parentLedger(fx.db, WORK_ID);
    const api = createConsultationApi(fx.db, { now });
    const crashed = billingDouble(fx.db, owner, now, { crashBeforeComplete: true });
    const created = await api.createConsultation(owner, {
      client_request_id: 'crash-send',
      text: '发送后崩溃',
      data_domain: DOMAIN,
      parent_work_id: WORK_ID,
    });
    await expect(api.runConsultation(owner, created.request_id, crashed)).rejects.toThrow('crash before complete');
    const pending = fx.db.prepare('SELECT status, final_result FROM consultations WHERE request_id = ?').get(created.request_id) as {
      status: string;
      final_result: string | null;
    };
    expect(pending.status).toBe('pending');
    expect(pending.final_result).toBeNull();
    expect(crashed.sends).toBe(1);
    expect(readDispatch(fx.db, `consultation:${created.request_id}`)).toBe('隔离咨询的回答');
    const recoveredBilling = billingDouble(fx.db, owner, now);
    const recovered = await api.runConsultation(owner, created.request_id, recoveredBilling);
    expect(recovered.sent).toBe(false);
    expect(recovered.completed).toBe(true);
    expect(recoveredBilling.sends).toBe(0);
    expect(crashed.sends).toBe(1);
    const answered = fx.db.prepare('SELECT status, final_result FROM consultations WHERE request_id = ?').get(created.request_id) as {
      status: string;
      final_result: string | null;
    };
    expect(answered.status).toBe('answered');
    expect(JSON.parse(answered.final_result ?? 'null')).toEqual({ text: '隔离咨询的回答' });
    expect(parentLedger(fx.db, WORK_ID)).toEqual(before);
  } finally {
    fx.close();
  }
});

function billingDouble(db: SqliteDatabase, principal: AdmissionPrincipal, now: () => Date, options?: { crashBeforeComplete?: boolean }) {
  const budget = createBudgetApi(db, principal, { now });
  let sends = 0;
  const businessIds: string[] = [];
  let crashBeforeComplete = options?.crashBeforeComplete === true;
  const text = '隔离咨询的回答';
  return {
    get sends() {
      return sends;
    },
    businessIds,
    async dispatch(input: {
      businessId: string;
      grantId: string;
      attemptId: string;
      routeId: string;
      callId: string;
      amountMicros: number;
    }) {
      businessIds.push(input.businessId);
      const paid = await dispatchPaidNext({
        bridge: budget,
        call: input,
        route: { sdkMaxRetries: 0, implicitResend: false, perHttpAccounted: true, verifiedMaxSends: 1 },
        network: {
          async send() {
            sends += 1;
            rememberDispatch(db, input.callId, text);
            return {
              usage: { usage_id: `use:${input.callId}`, amount_micros: input.amountMicros, proof: 'billing-double' },
            };
          },
        },
      });
      if (paid.sent && crashBeforeComplete) {
        crashBeforeComplete = false;
        throw new Error('crash before complete');
      }
      if (paid.sent) return { sent: true, text, alreadyDispatched: false };
      const stored = readDispatch(db, input.callId);
      if (stored && dispatchRecorded(db, input.callId)) {
        return { sent: false, text: stored, alreadyDispatched: true };
      }
      return { sent: false, text: '', alreadyDispatched: false };
    },
  };
}

function rememberDispatch(db: SqliteDatabase, callId: string, text: string): void {
  const eventId = `consultation.dispatch:${callId}`;
  const existing = db.prepare('SELECT event_id FROM domain_events WHERE event_id = ?').get(eventId);
  if (existing) return;
  const budget = db.prepare('SELECT account_id, data_domain FROM business_budgets WHERE business_id = ?').get(callId) as {
    account_id: string;
    data_domain: string;
  } | undefined;
  if (!budget) throw new Error('NOT_FOUND');
  appendDomainEvent(db, {
    eventId,
    aggregateId: callId.slice('consultation:'.length),
    aggregateVersion: 1,
    accountId: budget.account_id,
    dataDomain: budget.data_domain,
    payload: { type: 'consultation.dispatch', text },
    destination: 'consultation-dispatch',
  });
  ackOutbox(db, eventId, 'consultation-dispatch', 'accepted');
}

function readDispatch(db: SqliteDatabase, callId: string): string | null {
  const row = db.prepare('SELECT payload FROM domain_events WHERE event_id = ?').get(`consultation.dispatch:${callId}`) as {
    payload: string;
  } | undefined;
  if (!row) return null;
  const parsed: unknown = JSON.parse(row.payload);
  if (!parsed || typeof parsed !== 'object' || !('text' in parsed) || typeof parsed.text !== 'string' || parsed.text.length === 0) return null;
  return parsed.text;
}

function dispatchRecorded(db: SqliteDatabase, callId: string): boolean {
  const row = db.prepare('SELECT dispatched_at FROM budget_reservations WHERE call_id = ?').get(callId) as {
    dispatched_at: string | null;
  } | undefined;
  return row?.dispatched_at != null;
}

async function openWaitingWork(delegation: ReturnType<typeof createDelegationApi>): Promise<void> {
  await delegation.registerMandateType({
    type_id: 'type-consult',
    actions: ['judge'],
    resources: ['work'],
    effects: ['publish_pr'],
    domains: [DOMAIN],
    risk: 'low',
    level: 'L1',
    budget_micros: 4000,
    config_version: 1,
  });
  await delegation.openMandate({
    mandate_id: 'mandate-W-017',
    type_id: 'type-consult',
    actions: ['judge'],
    resources: ['work'],
    effects: ['publish_pr'],
    domains: [DOMAIN],
    risk: 'low',
    level: 'L1',
    budget_micros: 4000,
    expires_at: '2027-01-01T00:00:00.000Z',
  });
  await delegation.openWork({
    work_id: WORK_ID,
    generation: GENERATION,
    mandate_id: 'mandate-W-017',
    phase: 'judgment',
    next_action: 'judge',
    budget_micros: 4000,
  });
  await delegation.setWorkGate(WORK_ID, GENERATION, { awaiting_answer: true });
}

function parentLedger(db: SqliteDatabase, workId: string) {
  const budget = db.prepare('SELECT held_micros, spent_micros FROM business_budgets WHERE business_id = ?').get(`work:${workId}`) as {
    held_micros: number;
    spent_micros: number;
  };
  const effects = db.prepare(`SELECT
    (SELECT COUNT(*) FROM stage_events WHERE work_id = ?)
    + (SELECT COUNT(*) FROM execution_grants WHERE subject_kind = 'work' AND work_id = ? AND allowed_effects_json != '[]')
    + (SELECT COUNT(*) FROM domain_events WHERE aggregate_id = ?) AS n`).get(workId, workId, workId) as { n: number };
  const work = db.prepare('SELECT awaiting_answer FROM work_generations WHERE work_id = ? AND generation = ?').get(workId, GENERATION) as {
    awaiting_answer: number;
  };
  return {
    held: budget.held_micros,
    spent: budget.spent_micros,
    attempts: countAttempts(db, workId),
    effects: effects.n,
    awaiting_answer: work.awaiting_answer,
  };
}

function countAttempts(db: SqliteDatabase, workId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM execution_grants WHERE subject_kind = 'work' AND work_id = ?`).get(workId) as { n: number };
  return row.n;
}

async function businessAttempts(db: SqliteDatabase, workId: string): Promise<number> {
  return countAttempts(db, workId);
}

function envelope(clientRequestId: string, expectedRevision: number | null, payload: Json) {
  return {
    client_request_id: clientRequestId,
    expected_revision: expectedRevision,
    payload_hash: createHash('sha256').update(canonicalPayload(payload)).digest('hex'),
    payload,
  };
}

function temporaryDatabase(): { dir: string; databasePath: string; db: SqliteDatabase; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t11-'));
  const databasePath = join(dir, 'patrick.sqlite');
  const db = openDatabase(databasePath);
  return {
    dir,
    databasePath,
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
