/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadable } from 'node:stream/web';
import type { Page } from '@playwright/test';
import { createApp } from '../../apps/service/src/app.js';
import { issueBootstrapTicket, issueCallerSession } from '../../apps/service/src/auth.js';
import { createAnswerGate, type QuestionOption } from '../../packages/domain/src/answer-gate.js';
import { createConsultationApi } from '../../packages/domain/src/consultations.js';
import { createDelegationApi } from '../../packages/domain/src/delegation.js';
import { claimContinuation, type ResumeKey } from '../../packages/domain/src/work-continuation.js';
import { createStandardsApi } from '../../packages/domain/src/standards.js';
import { fixedConsultationQuoteHash, type ConsultationBackend } from '../../packages/executor/src/consultation.js';
import { CONSULTATION_RULE, HUB_SOURCE, type HubClient, type HubWireEvent } from '../../packages/integrations/autoloop/client.js';
import { createLocalHubPort, encodeHubAnswer } from '../../packages/integrations/autoloop/answers.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { openDatabase } from '../../packages/storage/src/database.js';

const now = () => new Date('2026-11-17T05:00:00.000Z');
const owner = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['personal'], operations: ['owner'] };

const questionOptions: QuestionOption[] = [
  { option_id: 'approved-choice', index: 0, label: '方案 A：补充证据', disposition: 'proceed',
    reason_code: null, next_action: 'collect_evidence', difference: null, missing: [],
    collection_id: 'collection-017', expected_material: 'evidence-017' },
  { option_id: 'deferred-choice', index: 1, label: '方案 B：稍后决定', disposition: 'deferred',
    reason_code: null, next_action: 'judge', difference: '保持当前工作不推进', missing: ['本人的决定'],
    collection_id: null, expected_material: null },
];

export async function t15Fixture(options: { paidConsultation?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t15-'));
  const databasePath = join(dir, 'patrick.sqlite');
  const db = openDatabase(databasePath);
  const hub = createLocalHubPort(databasePath + '.hub');
  const abort = new AbortController();
  const bootstrap = issueBootstrapTicket(db, { accountId: 'owner' }, now);
  const credentialDirectory = join(dir, 'credentials');
  const delegation = createDelegationApi(db, owner, { domain: 'personal', now });
  const policies = { actions: ['judge', 'collect'], resources: ['work'], effects: [], domains: ['personal'],
    risk: 'low' as const, level: 'L1' as const, budget_micros: 1000 };
  await delegation.registerMandateType({ ...policies, type_id: 't15-scope', config_version: 1 });
  await delegation.openMandate({ ...policies, type_id: 't15-scope', mandate_id: 't15-mandate', expires_at: '2026-11-18T05:00:00Z' });
  await delegation.setCapability({ profile_id: 't15-capability', level: 'L1', actions: policies.actions,
    report_id: 't15-test-report', report_version: 1, config_version: 1 });
  await delegation.ensureJudgmentPolicy();
  await delegation.openWork({ work_id: 'W-017', generation: 1, mandate_id: 't15-mandate',
    phase: 'judgment', next_action: 'judge', budget_micros: 1000 });
  await createStandardsApi(db, owner, { domain: 'personal', now }).freezeJudgmentBasis('W-017', 1);
  const answerGate = createAnswerGate(db, { domain: 'personal', now, hub, encode: encodeHubAnswer });
  const question = await answerGate.bindQuestion(owner, { work_id: 'W-017', generation: 1, question_id: 'Q-017',
    question_version: 1, proposal_revision: 1, hub_card_id: 17, options: questionOptions, custom_allowed: true, custom_rules: [] });
  const paid = options.paidConsultation ? paidConsultationFixture(abort.signal) : undefined;
  const app = createApp({ databasePath, credentialDirectory, now, consultationWorker: paid?.worker,
    productViewHub: { signal: abort.signal, hub: { async state() {
      const answered = (await hub.read('Q-017'))?.state === 'answered';
      return { seq: answered ? 2 : 1, hasMore: false, nextBefore: null, runs: [], lines: [],
        cards: [{ id: 17, title: '等待决定', state: answered ? 'answered' : 'open', choice: null, answer: null }] };
    } } } });
  const requests: { method: string; path: string; status: number; body: unknown; lastEventId?: string }[] = [];
  let loseAnswer = false;
  let loseConsultation = false;
  let blockEvents = false;
  const eventStreams = new Set<ServerResponse>();
  let held: { path: string; ready: () => void; gate: Promise<void> } | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      const requestAbort = new AbortController();
      res.on('close', () => requestAbort.abort());
      const target = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const events = target.pathname === '/api/v1/events';
      if (events && blockEvents) { res.writeHead(503).end(); return; }
      if (events) {
        eventStreams.add(res);
        res.on('close', () => eventStreams.delete(res));
      }
      const rawBody: Buffer[] = [];
      for await (const part of req) rawBody.push(Buffer.from(part));
      const body = rawBody.length ? Buffer.concat(rawBody).toString() : undefined;
      const response = await app.request(target.pathname + target.search,
        { method, headers: req.headers as Record<string, string>, body, signal: requestAbort.signal });
      requests.push({ method, path: target.pathname, status: response.status,
        body: target.pathname.startsWith('/api/v1/auth') ? undefined : body ? JSON.parse(body) as unknown : undefined,
        lastEventId: typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined });
      if (loseAnswer && response.status === 202 && target.pathname === '/api/v1/questions/Q-017/answers') {
        loseAnswer = false;
        res.destroy();
        return;
      }
      if (loseConsultation && response.status === 202 && method === 'POST' && target.pathname === '/api/v1/consultations') {
        loseConsultation = false;
        res.destroy();
        return;
      }
      if (held && target.pathname === held.path && method === 'GET' && response.status === 200) {
        const current = held;
        held = undefined;
        current.ready();
        await current.gate;
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      res.writeHead(response.status, headers);
      if (events) res.flushHeaders();
      if (!response.body) res.end();
      else await pipeline(Readable.fromWeb(response.body as unknown as NodeReadable<Uint8Array>), res);
    })().catch(() => { if (!res.destroyed) res.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(43155, '127.0.0.1', resolve);
  });

  return { db, requests, question, paid,
    async readFrozenQuestion(scope: 'same-domain' | 'different-domain') {
      const credentials = createCredentialStore(credentialDirectory, now);
      const callerId = 'question-reader-' + scope;
      const { authorization } = issueCallerSession(db, {
        accountId: owner.account_id, callerId, domain: 'personal',
        permissions: [scope === 'same-domain' ? 'questions.read' : 'work.read'],
      }, now, credentials);
      if (scope === 'different-domain') db.prepare(`INSERT INTO caller_scopes
        (account_id,caller_id,data_domain,permission,revoked_at) VALUES (?,?,?,'questions.read',NULL)`)
        .run(owner.account_id, callerId, 'work-company');
      return app.request('/api/v1/questions/Q-017', { headers: { authorization } });
    },
    completeConsultation: (id: string, version: number, text: string) =>
      createConsultationApi(db, { now }).completeConsultation(id, version, { text }),
    claimCollection(attemptId: string) {
      const key = db.prepare(`SELECT work_id,generation,question_id,answer_event_id,phase FROM resume_intents
        WHERE work_id='W-017' AND generation=1 AND question_id='Q-017' AND phase='answer'`).get() as ResumeKey | undefined;
      return key ? claimContinuation(db, owner, 'personal', key, attemptId, now()) : { status: 'absent' };
    },
    loseNextAnswerResponse: () => { loseAnswer = true; },
    loseNextConsultationResponse: () => { loseConsultation = true; },
    resetWorkStream() {
      const result = db.prepare("UPDATE product_view_checkpoints SET epoch=epoch+1 WHERE account_id='owner' AND data_domain='personal'").run();
      if (result.changes !== 1) throw new Error('T15 checkpoint fixture was not ready');
    },
    async changeWebCaller(page: Page) {
      const { token } = issueCallerSession(db, { accountId: owner.account_id, callerId: 'different-web-caller',
        domain: 'personal', permissions: ['owner'] }, now, createCredentialStore(credentialDirectory, now));
      await page.context().addCookies([{ name: 'patrick_session', value: token, url: 'http://localhost', httpOnly: true, sameSite: 'Strict' }]);
    },
    async replaceQuestion() {
      await answerGate.bindQuestion(owner, { work_id: 'W-017', generation: 1, question_id: 'Q-018',
        question_version: 1, proposal_revision: 2, hub_card_id: 18, options: questionOptions, custom_allowed: true, custom_rules: [] });
      db.prepare("UPDATE question_bindings SET status='superseded', successor_question_id='Q-018' WHERE question_id='Q-017'").run();
    },
    holdNextRead(path: string) {
      const ready = barrier();
      const gate = barrier();
      held = { path, ready: ready.resolve, gate: gate.promise };
      return { ready: ready.promise, release: gate.resolve };
    },
    disconnectEvents() {
      blockEvents = true;
      for (const response of eventStreams) response.end();
    },
    reconnectEvents() { blockEvents = false; },
    revoke() { db.prepare("UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE account_id='owner'").run(); },
    async signIn(page: Page) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true,
      } });
      await page.goto('/');
      const status = await page.evaluate(async (ticket) => {
        const response = await fetch('/api/v1/auth/challenge', { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-patrick-bootstrap': ticket },
          body: JSON.stringify({ rp_id: 'localhost' }),
        });
        if (!response.ok) return response.status;
        const { challenge_id, challenge } = await response.json() as {
          challenge_id: string; challenge: Parameters<typeof PublicKeyCredential.parseCreationOptionsFromJSON>[0];
        };
        const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(challenge);
        const credential = await navigator.credentials.create({ publicKey });
        if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey unavailable');
        return (await fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ challenge_id, credential: credential.toJSON() }) })).status;
      }, bootstrap.ticket);
      if (status !== 200) throw new Error(`T03 passkey registration failed (${status})`);
    },
    async close() {
      abort.abort();
      paid?.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      hub.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Local stand-ins record a real T11 budget reservation and settlement without an external model.
function paidConsultationFixture(signal: AbortSignal) {
  const gate = barrier();
  let sends = 0;
  let event: HubWireEvent | undefined;
  let claimed = false;
  let finished = false;
  const hub: Pick<HubClient, 'postEvent' | 'eventOutcome' | 'claim' | 'heartbeat' | 'result'> = {
    async postEvent(body) {
      const duplicate = !!event;
      event = body;
      return { event: 92, duplicate, routed: [CONSULTATION_RULE] };
    },
    async eventOutcome(id) {
      const run = { run: 92, rule: CONSULTATION_RULE, state: finished ? 'done' as const : claimed ? 'claimed' as const : 'queued' as const };
      return { event: id, runs: event ? [run] : [] };
    },
    async claim() {
      if (!event || claimed || finished) return null;
      claimed = true;
      return { run: 92, token: 'local-t15-run', rule: { name: CONSULTATION_RULE },
        context: { answers: [], events: [{ source: HUB_SOURCE, ...event }] } };
    },
    async heartbeat() { return []; },
    async result() { finished = true; return { rejected: [] }; },
  };
  const observation = 'T15 local synthetic transport evidence only';
  const admission = { backend: 'dsh' as const, available: true, status: 'verified' as const, command: 'fixture',
    observation, evidenceSha256: createHash('sha256').update(observation).digest('hex') };
  const terms = { accountId: owner.account_id, dataDomain: 'personal', backend: admission.backend,
    admissionSha256: admission.evidenceSha256, routeId: 't15-local', chargeMicros: 137, providerQuoteRef: 't15-fixture' };
  const answer = '这是同一咨询的测试结果。';
  const partial = '这是同一咨询的测试';
  const backend: ConsultationBackend = {
    scope: { accountId: owner.account_id, dataDomain: 'personal' },
    admission,
    route: { sdkMaxRetries: 0, implicitResend: false, perHttpAccounted: false, verifiedMaxSends: null },
    routeId: terms.routeId,
    pricing: { kind: 'fixed', terms, evidenceSha256: fixedConsultationQuoteHash(terms) },
    async send(input) {
      sends += 1;
      // The answer is produced in two steps, so the owner can read the first part
      // while the consultation is still running.
      input.onPartial?.(JSON.stringify({ type: 'final', sessionId: 't15-local', text: partial, reason: { kind: 'completed' } }) + '\n');
      await gate.promise;
      return {
        usage: { usage_id: 't15-local-usage', amount_micros: 137, proof: 't15-local-meter' },
        terminal: { closed: true, drained: true, exitCode: 0, stderr: '', stdout: [
          '{"type":"session","sessionId":"t15-local"}',
          '{"type":"status","phase":"step_end","usage":{"inputTokens":2,"outputTokens":1}}',
          JSON.stringify({ type: 'final', sessionId: 't15-local', text: answer, reason: { kind: 'completed' } }),
        ].join('\n') },
      };
    },
  };
  const errors: unknown[] = [];
  return { worker: { hub, backend, signal, intervalMs: 10, heartbeatIntervalMs: 10, onError: (error: unknown) => errors.push(error) },
    sends: () => sends, release: gate.resolve, errors, answer, partial };
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
