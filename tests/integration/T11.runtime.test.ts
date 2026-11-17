import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApp } from '../../apps/service/src/app.js';
import { issueBootstrapTicket, issueCallerSession, ORIGIN } from '../../apps/service/src/auth.js';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import { createConsultationApi } from '../../packages/domain/src/consultations.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import type { ConsultationBackend } from '../../packages/executor/src/consultation.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { CONSULTATION_RULE, HUB_SOURCE, type HubClient, type HubWireEvent } from '../../packages/integrations/autoloop/client.js';
import { openDatabase } from '../../packages/storage/src/database.js';

const NOW = '2026-11-17T04:00:00.000Z';
const EXPIRED = '2026-11-19T04:00:00.000Z';
const DOMAIN = 'product';
const ANSWER = '这次咨询没有继续父工作。';
const owner = {
  account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: [DOMAIN], operations: ['owner'],
};
const route = { sdkMaxRetries: 0, implicitResend: false, perHttpAccounted: false, verifiedMaxSends: null };
const observation = 'deterministic T09 integration fixture, not live backend admission';
const admission = {
  backend: 'dsh' as const, available: true, status: 'verified' as const, command: 'fixture', observation,
  evidenceSha256: createHash('sha256').update(observation).digest('hex'),
};

function backend(send: () => Promise<{ exitCode: number; provedUsage: boolean }>) {
  return {
    scope: { accountId: owner.account_id, dataDomain: DOMAIN },
    admission, route, routeId: 'test-route', amountMicros: 137,
    async send() {
      const reply = await send();
      return {
        usage: reply.provedUsage ? { usage_id: 'provider-usage', amount_micros: 137, proof: 'provider-proof' } : null,
        terminal: {
          closed: true, drained: true, exitCode: reply.exitCode, stderr: '',
          stdout: [
            '{"type":"session","sessionId":"runtime-test"}',
            '{"type":"status","phase":"step_end","usage":{"inputTokens":2,"outputTokens":1}}',
            JSON.stringify({ type: 'final', sessionId: 'runtime-test', text: ANSWER, reason: { kind: 'completed' } }),
          ].join('\n'),
        },
      };
    },
  };
}

function hubBoundary(options: { loseFirstAck?: boolean; neverClaim?: boolean } = {}) {
  const posted: HubWireEvent[] = [];
  const events = new Map<string, HubWireEvent>();
  const settled = new Set<number>();
  const claimed: string[] = [];
  const bridge: Pick<HubClient, 'postEvent' | 'claim' | 'result'> = {
    async postEvent(body) {
      posted.push(body);
      const prior = events.has(body.id);
      events.set(body.id, body);
      if (options.loseFirstAck && posted.length === 1) throw new Error('lost ACK after hub commit');
      return { event: 101, duplicate: prior, routed: [CONSULTATION_RULE] };
    },
    async claim(claimId) {
      claimed.push(claimId);
      const body = [...events.values()][0];
      if (!body || settled.size || options.neverClaim) return null;
      return { run: 101, token: 'run-token', rule: { name: CONSULTATION_RULE }, context: {
        answers: [],
        events: [{ source: HUB_SOURCE, ...body }],
      } };
    },
    async result(run) {
      settled.add(run);
      return { rejected: [] };
    },
  };
  return { bridge, posted, settled, claimed };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t11-runtime-'));
  const databasePath = join(dir, 'patrick.sqlite');
  const credentialDirectory = join(dir, 'credentials');
  const db = openDatabase(databasePath);
  let current = new Date(NOW);
  const now = () => current;
  issueBootstrapTicket(db, { accountId: owner.account_id }, now);
  const session = issueCallerSession(db, {
    accountId: owner.account_id, callerId: owner.caller_id, domain: DOMAIN, permissions: ['owner'],
  }, now, createCredentialStore(credentialDirectory, now));
  const controllers: AbortController[] = [];
  const errors: unknown[] = [];
  return {
    db, now, errors, session,
    advance() { current = new Date(EXPIRED); },
    stopWorkers() { for (const abort of controllers) abort.abort(); },
    start(hub: ReturnType<typeof hubBoundary>, paid: ConsultationBackend | undefined, stopOnError = false) {
      const abort = new AbortController();
      controllers.push(abort);
      return createApp({
        databasePath, credentialDirectory, now,
        consultationWorker: {
          hub: hub.bridge, backend: paid, signal: abort.signal, intervalMs: 10,
          onError(error: unknown) {
            errors.push(error);
            if (stopOnError) abort.abort();
          },
        },
      });
    },
    close() {
      for (const abort of controllers) abort.abort();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createThroughHttp(app: ReturnType<typeof createApp>, fx: ReturnType<typeof fixture>, parentWorkId: string | null = null) {
  const payload = { text: '可以只回答这个咨询吗？', parent_work_id: parentWorkId };
  const response = await app.request('/api/v1/consultations', {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: fx.session.authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      client_request_id: 'runtime-consultation', expected_revision: null,
      payload_hash: createHash('sha256').update(canonicalPayload(payload as Json)).digest('hex'), payload,
    }),
  });
  expect(response.status).toBe(202);
  const body = await response.json() as { receipt_url: string };
  return body.receipt_url.split('/').at(-1)!;
}

function paidLedger(fx: ReturnType<typeof fixture>, requestId: string) {
  return fx.db.prepare(`SELECT r.call_id, r.status, r.dispatched_at, b.spent_micros, b.held_micros
    FROM budget_reservations r JOIN business_budgets b USING (business_id) WHERE r.business_id = ?`)
    .get(`consultation:${requestId}`);
}

test('the configured service retries the hub ACK and answers once in the consultation lane while work waits', async () => {
  const fx = fixture();
  const hub = hubBoundary({ loseFirstAck: true });
  let sends = 0;
  try {
    const delegation = createDelegationApi(fx.db, owner, { now: fx.now, domain: DOMAIN });
    await delegation.registerMandateType({
      type_id: 'type-consult', actions: ['judge'], resources: ['work'], effects: ['publish_pr'], domains: [DOMAIN],
      risk: 'low', level: 'L1', budget_micros: 4000, config_version: 1,
    });
    await delegation.openMandate({
      mandate_id: 'mandate-runtime', type_id: 'type-consult', actions: ['judge'], resources: ['work'], effects: ['publish_pr'],
      domains: [DOMAIN], risk: 'low', level: 'L1', budget_micros: 4000, expires_at: EXPIRED,
    });
    await delegation.openWork({
      work_id: 'W-runtime', generation: 1, mandate_id: 'mandate-runtime', phase: 'judgment', next_action: 'judge', budget_micros: 4000,
    });
    await delegation.setWorkGate('W-runtime', 1, { awaiting_answer: true });
    const app = fx.start(hub, backend(async () => {
      sends += 1;
      return { exitCode: 0, provedUsage: true };
    }));
    const requestId = await createThroughHttp(app, fx, 'W-runtime');
    await expect.poll(() => hub.settled.size).toBe(1);
    expect(hub.posted).toHaveLength(2);
    expect(hub.posted[0]).toMatchObject({ id: `consultation.requested:${requestId}`, type: 'consultation.requested', subject: requestId });
    expect(hub.posted[1]).toEqual(hub.posted[0]);
    expect(fx.db.prepare('SELECT result FROM outbox WHERE event_id = ?').get(hub.posted[0].id)).toEqual({ result: 'duplicate' });
    expect(sends).toBe(1);
    expect(paidLedger(fx, requestId)).toMatchObject({
      call_id: `consultation:${requestId}`, status: 'settled', held_micros: 0, spent_micros: 137,
    });
    expect(await createThroughHttp(app, fx, 'W-runtime')).toBe(requestId);
    const result = await app.request(`/api/v1/consultations/${requestId}`, {
      headers: { authorization: fx.session.authorization },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ data: { status: 'answered', final_result: { text: ANSWER }, result_version: 1 } });
    expect(sends).toBe(1);
    expect(fx.db.prepare("SELECT held_micros, spent_micros FROM business_budgets WHERE business_id = 'work:W-runtime'").get())
      .toEqual({ held_micros: 0, spent_micros: 0 });
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM execution_grants WHERE work_id = 'W-runtime'").get()).toEqual({ n: 0 });
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM stage_events WHERE work_id = 'W-runtime'").get()).toEqual({ n: 0 });
    expect(fx.db.prepare("SELECT awaiting_answer FROM work_generations WHERE work_id = 'W-runtime'").get()).toEqual({ awaiting_answer: 1 });
  } finally {
    fx.close();
  }
});

test('a verified result survives a failed final write and restarts after expiry without reaching the backend again', async () => {
  const fx = fixture();
  const hub = hubBoundary();
  let sends = 0;
  try {
    fx.db.exec(`CREATE TRIGGER interrupt_finalization BEFORE UPDATE OF final_result ON consultations
      BEGIN SELECT RAISE(ABORT, 'simulated process loss before finalization'); END`);
    const paid = backend(async () => {
      sends += 1;
      return { exitCode: 0, provedUsage: true };
    });
    const requestId = await createThroughHttp(fx.start(hub, paid, true), fx);
    await expect.poll(() => fx.errors.length).toBe(1);
    expect(String(fx.errors[0])).toContain('simulated process loss before finalization');
    const api = createConsultationApi(fx.db, { now: fx.now });
    const pending = await api.readConsultation(owner, requestId);
    expect(pending).toMatchObject({ status: 'pending', final_result: null, result_version: 0 });
    expect(paidLedger(fx, requestId)).toMatchObject({ status: 'settled', spent_micros: 137 });
    expect(sends).toBe(1);

    fx.advance();
    fx.db.exec('DROP TRIGGER interrupt_finalization');
    // This restart can recover even if the Hub will not hand out the old run and the backend is not configured.
    const restartHub = hubBoundary({ neverClaim: true });
    fx.start(restartHub, undefined);
    await expect.poll(async () => (await api.readConsultation(owner, requestId)).status).toBe('answered');
    expect(await api.readConsultation(owner, requestId)).toMatchObject({ final_result: { text: ANSWER }, result_version: 1 });
    expect(await api.cancelConsultation(owner, requestId, 0)).toBe(false);
    expect((await api.listMessages(owner, pending.conversation_id)).filter((message) => message.kind === 'final_answer'))
      .toMatchObject([{ raw_text: ANSWER, result_version: 1 }]);
    expect(restartHub.posted).toHaveLength(0);
    expect(sends).toBe(1);
  } finally {
    fx.close();
  }
});

test.each([
  { label: 'a failed terminal with proved usage', exitCode: 1, provedUsage: true, status: 'settled', spent: 137, held: 0 },
  { label: 'a completed terminal without proved usage', exitCode: 0, provedUsage: false, status: 'uncertain', spent: 0, held: 137 },
])('$label remains unanswered and does not send twice', async ({ exitCode, provedUsage, status, spent, held }) => {
  const fx = fixture();
  const hub = hubBoundary();
  let sends = 0;
  try {
    const paid = backend(async () => {
      sends += 1;
      return { exitCode, provedUsage };
    });
    const requestId = await createThroughHttp(fx.start(hub, paid), fx);
    await expect.poll(() => hub.settled.size).toBe(1);
    expect(paidLedger(fx, requestId)).toMatchObject({ status, spent_micros: spent, held_micros: held });
    const api = createConsultationApi(fx.db, { now: fx.now });
    expect(await api.readConsultation(owner, requestId)).toMatchObject({ status: 'pending', final_result: null, result_version: 0 });

    fx.stopWorkers();
    const restart = hubBoundary();
    restart.posted.push(...hub.posted);
    await restart.bridge.postEvent(hub.posted[0]);
    fx.start(restart, paid);
    await expect.poll(() => restart.settled.size).toBe(1);
    expect(await api.readConsultation(owner, requestId)).toMatchObject({ status: 'pending', final_result: null, result_version: 0 });
    expect(sends).toBe(1);
  } finally {
    fx.close();
  }
});

test('a crash after claiming the paid permit leaves the consultation pending across restart', async () => {
  const fx = fixture();
  const hub = hubBoundary();
  let sends = 0;
  try {
    fx.db.exec(`CREATE TRIGGER interrupt_usage BEFORE INSERT ON usage_receipts
      BEGIN SELECT RAISE(ABORT, 'simulated process loss after permit'); END`);
    const paid = backend(async () => {
      sends += 1;
      return { exitCode: 0, provedUsage: true };
    });
    const requestId = await createThroughHttp(fx.start(hub, paid, true), fx);
    await expect.poll(() => fx.errors.length).toBe(1);
    expect(String(fx.errors[0])).toContain('simulated process loss after permit');
    expect(paidLedger(fx, requestId)).toMatchObject({
      status: 'held', dispatched_at: NOW, held_micros: 137, spent_micros: 0,
    });
    fx.db.exec('DROP TRIGGER interrupt_usage');
    fx.start(hub, paid);
    await expect.poll(() => hub.settled.size).toBe(1);
    expect(await createConsultationApi(fx.db, { now: fx.now }).readConsultation(owner, requestId))
      .toMatchObject({ status: 'pending', result_version: 0, final_result: null });
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE event_id LIKE 'consultation.paid_result:%'").get())
      .toEqual({ n: 0 });
    expect(sends).toBe(1);
  } finally {
    fx.close();
  }
});

test('a verified paid result arriving after cancellation leaves a scoped receipt and no final message', async () => {
  const fx = fixture();
  const hub = hubBoundary();
  try {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    const paid = backend(async () => {
      entered();
      await gate;
      return { exitCode: 0, provedUsage: true };
    });
    const requestId = await createThroughHttp(fx.start(hub, paid), fx);
    await sending;
    const api = createConsultationApi(fx.db, { now: fx.now });
    expect(await api.cancelConsultation(owner, requestId, 0)).toBe(true);
    release();

    await expect.poll(() => hub.settled.size).toBe(1);
    const cancelled = await api.readConsultation(owner, requestId);
    expect(cancelled).toMatchObject({ status: 'cancelled', result_version: 1, final_result: null });
    expect((await api.listMessages(owner, cancelled.conversation_id)).filter((message) => message.kind === 'final_answer')).toEqual([]);
    const late = fx.db.prepare("SELECT payload, account_id, data_domain FROM domain_events WHERE event_id = ?")
      .get(`consultation.paid_result:${requestId}:0`) as { payload: string; account_id: string; data_domain: string };
    expect(late).toMatchObject({ account_id: owner.account_id, data_domain: DOMAIN });
    expect(JSON.parse(late.payload)).toMatchObject({
      request_id: requestId, result_version: 0, call_id: `consultation:${requestId}`, usage_id: 'provider-usage',
    });
    expect(paidLedger(fx, requestId)).toMatchObject({ status: 'settled', spent_micros: 137 });
  } finally {
    fx.close();
  }
});

test('a Hub job cannot send after its queued caller scope has been revoked', async () => {
  const fx = fixture();
  const hub = hubBoundary({ neverClaim: true });
  const worker = hubBoundary();
  let sends = 0;
  try {
    const requestId = await createThroughHttp(fx.start(hub, undefined), fx);
    await expect.poll(() => fx.db.prepare('SELECT result FROM outbox WHERE event_id = ?').get(`consultation.requested:${requestId}`))
      .toEqual({ result: 'accepted' });
    fx.db.prepare('UPDATE caller_scopes SET revoked_at = ? WHERE account_id = ? AND caller_id = ? AND data_domain = ?')
      .run(NOW, owner.account_id, owner.caller_id, DOMAIN);
    await worker.bridge.postEvent(hub.posted[0]);
    fx.start(worker, backend(async () => {
      sends += 1;
      return { exitCode: 0, provedUsage: true };
    }));
    await expect.poll(() => worker.settled.size).toBe(1);
    expect(sends).toBe(0);
    expect(paidLedger(fx, requestId)).toBeUndefined();
  } finally {
    fx.close();
  }
});

test('a blocked backend leaves the Hub job unclaimed and does not reserve money', async () => {
  const fx = fixture();
  const hub = hubBoundary();
  try {
    const paid = backend(async () => { throw new Error('blocked backend was called'); });
    const app = fx.start(hub, { ...paid, admission: { ...admission, available: false, status: 'blocked' } });
    const requestId = await createThroughHttp(app, fx);
    await expect.poll(() => fx.db.prepare('SELECT result FROM outbox WHERE event_id = ?').get(`consultation.requested:${requestId}`))
      .toEqual({ result: 'accepted' });
    expect(hub.claimed).toHaveLength(0);
    expect(paidLedger(fx, requestId)).toBeUndefined();
  } finally {
    fx.close();
  }
});

test.each([
  { accountId: owner.account_id, dataDomain: 'personal' },
  { accountId: 'other-account', dataDomain: DOMAIN },
])('a backend for another scope cannot reserve or send ($accountId/$dataDomain)', async (scope) => {
  const fx = fixture();
  const hub = hubBoundary();
  let sends = 0;
  try {
    const paid = backend(async () => {
      sends += 1;
      return { exitCode: 0, provedUsage: true };
    });
    const app = fx.start(hub, { ...paid, scope });
    const requestId = await createThroughHttp(app, fx);
    await expect.poll(() => hub.settled.size).toBe(1);
    expect(sends).toBe(0);
    expect(paidLedger(fx, requestId)).toBeUndefined();
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM execution_grants WHERE request_id = ?").get(requestId)).toEqual({ n: 0 });
  } finally {
    fx.close();
  }
});
