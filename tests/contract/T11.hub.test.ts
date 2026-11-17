import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApp } from '../../apps/service/src/app.js';
import { issueBootstrapTicket, issueCallerSession } from '../../apps/service/src/auth.js';
import { fixedConsultationQuoteHash, type ConsultationBackend } from '../../packages/executor/src/consultation.js';
import { createConsultationApi } from '../../packages/domain/src/consultations.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import {
  CONSULTATION_RULE, HUB_SOURCE, SOURCE_CHANGE_RULE, type HubEventAck, type HubJob,
} from '../../packages/integrations/autoloop/client.js';
import { openDatabase } from '../../packages/storage/src/database.js';
import { startPinnedHub } from './pinned-hub.js';

test('the pinned Hub isolates consultation claims and receives the service result over HTTP', async () => {
  const hub = await startPinnedHub();
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t11-pinned-hub-'));
  const databasePath = join(dir, 'patrick.sqlite');
  const credentialDirectory = join(dir, 'credentials');
  const db = openDatabase(databasePath);
  const stopPublisher = new AbortController();
  const stopWorker = new AbortController();
  const seen: HubJob[] = [];
  const acknowledgements: HubEventAck[] = [];
  const failed: unknown[] = [];
  const renewals: Array<{ run: number; cancelled: number[] }> = [];
  let releaseBackend!: () => void;
  const holdBackend = new Promise<void>((resolve) => { releaseBackend = resolve; });
  const now = () => new Date('2026-11-17T04:00:00.000Z');
  const principal = { account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: ['product'], operations: ['owner'] };
  const api = createConsultationApi(db, { now });
  const observation = 'trusted test boundary with no model process or network call';
  const admission = {
    backend: 'dsh' as const, available: true, status: 'verified' as const, command: 'fixture', observation,
    evidenceSha256: createHash('sha256').update(observation).digest('hex'),
  };
  const terms = {
    accountId: principal.account_id, dataDomain: 'product', backend: admission.backend,
    admissionSha256: admission.evidenceSha256, routeId: 'contract-fixture', chargeMicros: 31, providerQuoteRef: 'contract-fixture-quote',
  };
  const sends: Array<Parameters<ConsultationBackend['send']>[0]> = [];
  try {
    expect(hub.consultationClient).toBeDefined();
    const dedicated = hub.consultationClient;
    const source = await hub.client.postEvent({
      id: 'ordinary-work', type: 'source.changed', subject: 'ordinary-work', summary: 'test', detail: '', hops: 0,
    });
    expect(source.routed).toEqual([SOURCE_CHANGE_RULE]);
    expect(await dedicated.claim('wrong-lane')).toBeNull();
    const ordinary = await hub.client.claim('only-ordinary');
    expect(ordinary?.rule.name).toBe(SOURCE_CHANGE_RULE);
    if (!ordinary) throw new Error('ordinary worker received no job');
    expect(await hub.client.result(ordinary.run, ordinary.token, { outcome: 'nothing' })).toEqual({ rejected: [] });

    issueBootstrapTicket(db, { accountId: principal.account_id }, now);
    issueCallerSession(db, {
      accountId: principal.account_id, callerId: principal.caller_id, domain: 'product', permissions: ['owner'],
    }, now, createCredentialStore(credentialDirectory, now));
    const consultation = await api.createConsultation(principal, {
      client_request_id: 'consult-via-pinned-hub', data_domain: 'product', text: 'Only answer this consultation.', parent_work_id: null,
    });
    const eventId = `consultation.requested:${consultation.request_id}`;
    createApp({
      databasePath, credentialDirectory, now,
      consultationWorker: {
        hub: {
          ...dedicated,
          async postEvent(body) {
            const ack = await dedicated.postEvent(body);
            acknowledgements.push(ack);
            if (acknowledgements.length === 1) throw new Error('simulated lost Hub reply after commit');
            return ack;
          },
        },
        signal: stopPublisher.signal, intervalMs: 10, onError: (error) => failed.push(error),
      },
    });
    await expect.poll(() => db.prepare('SELECT result FROM outbox WHERE event_id = ?').get(eventId)).toEqual({ result: 'duplicate' });
    stopPublisher.abort();
    expect(acknowledgements).toHaveLength(2);
    expect(acknowledgements[0]).toMatchObject({ event: expect.any(Number), duplicate: false, routed: [CONSULTATION_RULE] });
    expect(acknowledgements[1]).toMatchObject({ event: acknowledgements[0].event, duplicate: true, routed: [CONSULTATION_RULE] });
    expect(await hub.client.claim('wrong-lane-again')).toBeNull();

    createApp({
      databasePath, credentialDirectory, now,
      consultationWorker: {
        hub: {
          ...dedicated,
          async claim(id) {
            const job = await dedicated.claim(id);
            if (job) seen.push(job);
            return job;
          },
          async heartbeat(id, run, signal) {
            const cancelled = await dedicated.heartbeat(id, run, signal);
            renewals.push({ run, cancelled });
            return cancelled;
          },
        },
        signal: stopWorker.signal, intervalMs: 10, heartbeatIntervalMs: 20, onError: (error) => failed.push(error),
        backend: {
          scope: { accountId: principal.account_id, dataDomain: 'product' },
          admission,
          route: { sdkMaxRetries: 0, implicitResend: false, perHttpAccounted: false, verifiedMaxSends: null },
          routeId: terms.routeId, pricing: { kind: 'fixed', terms, evidenceSha256: fixedConsultationQuoteHash(terms) },
          async send(input) {
            sends.push(input);
            await holdBackend;
            return {
              usage: { usage_id: 'test-usage', amount_micros: 31, proof: 'test-usage-proof' },
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
      },
    });
    await expect.poll(() => renewals.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    expect(renewals[0]).toEqual({ run: seen[0].run, cancelled: [] });
    let state = await hub.client.state();
    expect(state.runs.find((run) => run.id === seen[0].run)?.state).toBe('claimed');
    releaseBackend();
    await expect.poll(async () => {
      state = await hub.client.state();
      return state.runs.find((run) => run.rule === CONSULTATION_RULE)?.state;
    }).toBe('done');
    stopWorker.abort();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      run: expect.any(Number), token: expect.any(String), rule: { name: CONSULTATION_RULE },
      context: { events: [{ id: eventId, source: HUB_SOURCE, type: 'consultation.requested', subject: consultation.request_id }] },
    });
    expect(await api.readConsultation(principal, consultation.request_id))
      .toMatchObject({ status: 'answered', final_result: { text: 'A scoped answer.' }, result_version: 1 });
    expect(sends).toMatchObject([{
      accountId: principal.account_id, dataDomain: 'product', requestId: consultation.request_id,
      resultVersion: 0, callId: `consultation:${consultation.request_id}`, text: 'Only answer this consultation.',
      fixedQuote: { evidenceSha256: fixedConsultationQuoteHash(terms), chargeMicros: 31, providerQuoteRef: terms.providerQuoteRef },
    }]);
    expect(failed.map(String)).toEqual(['Error: simulated lost Hub reply after commit']);
  } finally {
    releaseBackend();
    stopWorker.abort();
    stopPublisher.abort();
    db.close();
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hub.home, { recursive: true, force: true });
  }
}, 30000);
