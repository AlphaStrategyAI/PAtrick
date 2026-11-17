import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { issueBootstrapTicket, issueCallerSession } from '../../apps/service/src/auth.js';
import { createConsultationApi } from '../../packages/domain/src/consultations.js';
import { fixedConsultationQuoteHash, type ConsultationBackend } from '../../packages/executor/src/consultation.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { CONSULTATION_RULE, type HubClient, type HubEventAck } from '../../packages/integrations/autoloop/client.js';
import { createConsultationRouting } from '../../packages/integrations/autoloop/consultation-routing.js';
import { startConsultationWorker } from '../../packages/integrations/autoloop/consultation-runtime.js';
import { openDatabase } from '../../packages/storage/src/database.js';
import { startPinnedHub, type PinnedHub } from './pinned-hub.js';

type Send = Parameters<ConsultationBackend['send']>[0];

test('a paused Hub records a lost POST but does not dispatch until the owner explicitly replays it', async () => {
  const fx = await fixture();
  try {
    const paused = await ownerRule(fx.hub, 'pause') as { paused: { since: string } };
    const consultation = await fx.request('product', 'paused-consultation');
    const recorded: HubEventAck[] = [];
    const client = fx.hub.consultationClient;
    fx.start('product', {
      ...client,
      async postEvent(event) {
        const accepted = await client.postEvent(event);
        recorded.push(accepted);
        if (recorded.length === 1) throw new Error('lost POST reply after Hub commit');
        return accepted;
      },
    });
    await expect.poll(() => fx.eventReceipt(consultation.request_id)).toEqual({ hub_event: expect.any(Number) });
    expect(recorded.map((ack) => ack.duplicate)).toEqual([false, true]);
    expect(recorded[0]?.routed).toEqual([]);
    expect(recorded[0]?.event).toBe(recorded[1]?.event);
    expect(fx.outboxResult(consultation.request_id)).toBeNull();
    expect(await client.claim('while-paused')).toBeNull();
    expect(fx.sends).toHaveLength(0);

    fx.reopen();
    fx.start('product', {
      ...client,
      async postEvent() { throw new Error('stored Hub event must recover by GET, not POST'); },
    });
    expect(await ownerRule(fx.hub, 'resume')).toMatchObject({ changed: true });
    expect((await fx.hub.client.state()).runs).toHaveLength(0);
    expect(fx.outboxResult(consultation.request_id)).toBeNull();
    const replay = await ownerRule(fx.hub, 'replay', { since: paused.paused.since });
    expect(replay).toMatchObject({ events: [recorded[0].event], runs: [expect.any(Number)] });

    await expect.poll(() => fx.status(consultation.request_id)).toBe('answered');
    await expect.poll(async () => (await fx.hub.client.state()).runs.map((run) => run.state)).toEqual(['done']);
    expect(fx.outboxResult(consultation.request_id)).toBe('duplicate');
    expect(fx.sends).toMatchObject([{
      requestId: consultation.request_id, dataDomain: 'product', callId: `consultation:${consultation.request_id}`,
    }]);
    expect(fx.requestCount(consultation.request_id)).toBe(1);
    expect(await ownerRule(fx.hub, 'replay', { since: paused.paused.since })).toMatchObject({ events: [], runs: [] });
    expect(fx.errors.map(String)).toEqual(['Error: lost POST reply after Hub commit']);
  } finally {
    await fx.close();
  }
}, 15000);

test('a mismatched scope defers the same consultation while an eligible lane continues to dispatch', async () => {
  // Keep SQLite's clock just behind the pinned Hub to exercise the real durable 30-second timer promptly.
  const fx = await fixture(() => new Date(Date.now() - 28_500));
  try {
    const deferred = await fx.request('personal', 'scope-mismatch');
    const available = await fx.request('product', 'available-behind-mismatch');
    const client = fx.hub.consultationClient;
    const submitted: Parameters<HubClient['result']>[2][] = [];
    let lostDeferralResponse = false;
    const productWorker = fx.start('product', {
      ...client,
      async result(run, token, body) {
        const applied = await client.result(run, token, body);
        submitted.push(body);
        if (body.later?.length && !lostDeferralResponse) {
          lostDeferralResponse = true;
          throw new Error('lost deferral reply after Hub commit');
        }
        return applied;
      },
    });
    await expect.poll(() => fx.status(available.request_id)).toBe('answered');
    expect(fx.status(deferred.request_id)).toBe('pending');
    expect(submitted.find((item) => item.later?.length)).toMatchObject({
      outcome: 'done', later: [{ key: 'patrick-consultation-scope', at: expect.any(String), about: expect.any(String) }],
    });
    expect(fx.sends.map((send) => send.requestId)).toEqual([available.request_id]);
    expect(fx.reservations(deferred.request_id)).toBe(0);
    productWorker.abort();

    fx.start('personal');
    await expect.poll(() => fx.status(deferred.request_id), { timeout: 5500 }).toBe('answered');
    expect(fx.sends.map((send) => [send.requestId, send.dataDomain, send.callId])).toEqual([
      [available.request_id, 'product', `consultation:${available.request_id}`],
      [deferred.request_id, 'personal', `consultation:${deferred.request_id}`],
    ]);
    expect(fx.requestCount(deferred.request_id)).toBe(1);
    expect(fx.reservations(deferred.request_id)).toBe(1);
    expect(fx.errors.map(String)).toEqual(['Error: lost deferral reply after Hub commit']);
  } finally {
    await fx.close();
  }
}, 15000);

test('the same completed Hub result is recovered after an acknowledged response is lost and SQLite reopens', async () => {
  const fx = await fixture();
  try {
    const consultation = await fx.request('product', 'lost-terminal-receipt');
    const client = fx.hub.consultationClient;
    const posts: Array<{ run: number; tokenHash: string; body: Parameters<HubClient['result']>[2] }> = [];
    const firstWorker = fx.start('product', {
      ...client,
      async result(run, token, body) {
        const acknowledge = await client.result(run, token, body);
        posts.push({ run, tokenHash: createHash('sha256').update(token).digest('hex'), body });
        expect(acknowledge).toEqual({ rejected: [] });
        firstWorker.abort();
        throw new Error('lost terminal reply after Hub commit');
      },
    });
    await expect.poll(() => firstWorker.signal.aborted).toBe(true);
    expect(fx.errors).toEqual([]);
    expect(fx.status(consultation.request_id)).toBe('answered');
    expect(fx.deliveryResult(consultation.request_id)).toBeNull();
    expect((await client.state()).runs.map((run) => run.state)).toEqual(['done']);
    expect(posts).toHaveLength(1);

    fx.reopen();
    fx.start('product', {
      ...client,
      async result(run, token, body) {
        const acknowledge = await client.result(run, token, body);
        posts.push({ run, tokenHash: createHash('sha256').update(token).digest('hex'), body });
        return acknowledge;
      },
    });
    await expect.poll(() => fx.deliveryResult(consultation.request_id)).toBe('accepted');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(fx.reservations(consultation.request_id)).toBe(1);
    expect(fx.sends).toHaveLength(1);
    expect(fx.requestCount(consultation.request_id)).toBe(1);
    expect((await client.state()).runs.map((run) => run.state)).toEqual(['done']);
  } finally {
    await fx.close();
  }
}, 15000);

test('a cancellation in a recovered Hub claim prevents reservation and send', async () => {
  const fx = await fixture();
  try {
    const consultation = await fx.request('product', 'cancel-before-start');
    const client = fx.hub.consultationClient;
    await fx.route();
    expect(fx.outboxResult(consultation.request_id)).toBe('accepted');

    // Reuse the service's stable claim identity to recreate a restart with a held job.
    const claimId = 'patrick-consultation-service-v1';
    const held = await client.claim(claimId);
    expect(held?.context.events[0]).toMatchObject({ subject: consultation.request_id });
    if (!held) throw new Error('fixture could not pre-claim consultation');
    const stopped = await fetch(`${fx.hub.baseUrl}/v1/runs/${held.run}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.hub.keys.owner}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(stopped.ok).toBe(true);
    expect((await client.state()).runs).toMatchObject([{ id: held.run, state: 'claimed' }]);

    const claims: Array<{ run: number; cancelled: boolean }> = [];
    const results: Array<{ run: number; outcome: string }> = [];
    fx.start('product', {
      ...client,
      async claim(id, signal) {
        const job = await client.claim(id, signal);
        if (job) claims.push({ run: job.run, cancelled: job.cancelled === true });
        return job;
      },
      async result(run, token, body) {
        const ack = await client.result(run, token, body);
        results.push({ run, outcome: body.outcome });
        return ack;
      },
    });
    await expect.poll(() => results.length).toBe(1);
    expect(fx.sends).toHaveLength(0);
    expect(fx.reservations(consultation.request_id)).toBe(0);
    expect(claims).toEqual([{ run: held.run, cancelled: true }]);
    expect(results).toEqual([{ run: held.run, outcome: 'cancelled' }]);
    expect((await client.state()).runs).toMatchObject([{ id: held.run, state: 'cancelled' }]);
    expect(fx.errors).toEqual([]);
  } finally {
    await fx.close();
  }
}, 15000);

async function ownerRule(hub: PinnedHub, action: 'pause' | 'resume' | 'replay', body: Record<string, string> = {}) {
  const response = await fetch(`${hub.baseUrl}/v1/rules/${encodeURIComponent(CONSULTATION_RULE)}/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${hub.keys.owner}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`local Hub rule ${action} -> ${response.status}: ${await response.text()}`);
  return await response.json() as unknown;
}

async function fixture(now = () => new Date()) {
  const hub = await startPinnedHub();
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t11-routing-'));
  const databasePath = join(dir, 'state.sqlite');
  const credentialDirectory = join(dir, 'credentials');
  let db = openDatabase(databasePath);
  let credentials = createCredentialStore(credentialDirectory, now);
  const principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['product', 'personal'], operations: ['owner'] };
  issueBootstrapTicket(db, { accountId: principal.account_id }, now);
  for (const domain of principal.domains) {
    issueCallerSession(db, { accountId: principal.account_id, callerId: principal.caller_id, domain, permissions: ['owner'] }, now, credentials);
  }
  const sends: Send[] = [];
  const errors: unknown[] = [];
  const controllers: AbortController[] = [];
  const observation = 'fixture-only admitted model boundary without external calls';
  const eventId = (requestId: string) => `consultation.requested:${requestId}`;
  return {
    hub, errors, sends,
    route: () => createConsultationRouting(db, hub.consultationClient, now).drain(1, undefined, (error) => { throw error; }),
    request: (domain: string, key: string) => createConsultationApi(db, { now }).createConsultation(principal, {
      client_request_id: key, data_domain: domain, text: 'A private question', parent_work_id: null,
    }),
    status: (requestId: string) => (db.prepare('SELECT status FROM consultations WHERE request_id = ?').get(requestId) as { status: string }).status,
    outboxResult: (requestId: string) => (db.prepare("SELECT result FROM outbox WHERE event_id = ? AND destination = 'autoloop'")
      .get(eventId(requestId)) as { result: string | null }).result,
    deliveryResult: (requestId: string) => (db.prepare(`SELECT o.result FROM outbox o JOIN domain_events e USING (event_id)
      WHERE e.aggregate_id = ? AND o.destination = 'consultation-hub-delivery'`).get(requestId) as { result: string | null }).result,
    eventReceipt: (requestId: string) => db.prepare('SELECT hub_event FROM hub_events WHERE event_id = ?').get(eventId(requestId)),
    requestCount: (requestId: string) => (db.prepare('SELECT COUNT(*) n FROM domain_events WHERE event_id = ?')
      .get(eventId(requestId)) as { n: number }).n,
    reservations: (requestId: string) => (db.prepare('SELECT COUNT(*) n FROM budget_reservations WHERE business_id = ?')
      .get(`consultation:${requestId}`) as { n: number }).n,
    start(domain: string, selectedHub = hub.consultationClient) {
      const controller = new AbortController();
      controllers.push(controller);
      const admission = {
        backend: 'dsh' as const, available: true, status: 'verified' as const, command: 'fixture', observation,
        evidenceSha256: createHash('sha256').update(observation).digest('hex'),
      };
      const terms = {
        accountId: principal.account_id, dataDomain: domain, backend: admission.backend, admissionSha256: admission.evidenceSha256,
        routeId: 'fixture', chargeMicros: 11, providerQuoteRef: 'routing-fixture-quote',
      };
      startConsultationWorker(db, now, {
        hub: selectedHub,
        signal: controller.signal, intervalMs: 15, onError: (error) => errors.push(error),
        backend: {
          scope: { accountId: principal.account_id, dataDomain: domain },
          admission,
          route: { sdkMaxRetries: 0, implicitResend: false, perHttpAccounted: false, verifiedMaxSends: null },
          routeId: terms.routeId, pricing: { kind: 'fixed', terms, evidenceSha256: fixedConsultationQuoteHash(terms) },
          async send(input) {
            sends.push(input);
            return {
              usage: { usage_id: `usage:${input.requestId}`, amount_micros: 11, proof: 'fixture-proof' },
              terminal: {
                closed: true, drained: true, exitCode: 0, stderr: '',
                stdout: [
                  '{"type":"session","sessionId":"test-session"}',
                  '{"type":"status","phase":"step_end","usage":{"inputTokens":2,"outputTokens":1}}',
                  '{"type":"final","sessionId":"test-session","text":"A scoped answer.","reason":{"kind":"completed"}}',
                ].join('\n'),
              },
            };
          },
        },
      }, credentials);
      return controller;
    },
    reopen() {
      for (const controller of controllers) controller.abort();
      db.close();
      db = openDatabase(databasePath);
      credentials = createCredentialStore(credentialDirectory, now);
    },
    async close() {
      for (const controller of controllers) controller.abort();
      await hub.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(hub.home, { recursive: true, force: true });
    },
  };
}
