import { createHash } from 'node:crypto';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { ackOutbox, appendDomainEvent, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import type { CredentialStore } from '../../host/src/credentials.js';
import type { HubClient, HubJob } from './client.js';

const BINDING = 'consultation-hub-binding';
const DELIVERY = 'consultation-hub-delivery';
const RECOVERY_WINDOW_MS = 7 * 86_400_000;

type HubResult = Parameters<HubClient['result']>[2];
type Binding = {
  id: string; requestId: string; accountId: string; domain: string;
  version: number; run: number; credentialRef: string;
};
type EventRow = { seq: number; event_id: string; payload: string };

export function consultationHubResult(status: 'answered' | 'failed' | null): HubResult {
  return status ? { outcome: 'done', summary: `consultation ${status}` }
    : { outcome: 'nothing', summary: 'no verified consultation result' };
}

export function createConsultationHubReceipts(db: SqliteDatabase, credentials: CredentialStore, hub: Pick<HubClient, 'result'>) {
  let deliveryCursor = 0;

  function bind(requestId: string, job: Pick<HubJob, 'run' | 'token'>): Binding | null {
    return withImmediateTransaction(db, () => {
      const row = db.prepare('SELECT account_id, data_domain, result_version, status FROM consultations WHERE request_id = ?').get(requestId) as {
        account_id: string; data_domain: string; result_version: number; status: string;
      } | undefined;
      if (!row) return null;
      if (!Number.isSafeInteger(job.run) || job.run <= 0 || !job.token) throw new Error('CONSULTATION_HUB_CLAIM_INVALID');
      const tokenHash = createHash('sha256').update(job.token).digest('hex');
      const id = `consultation.hub_binding:${requestId}:${job.run}:${tokenHash}`;
      const prior = db.prepare('SELECT payload FROM domain_events WHERE event_id = ?').get(id) as { payload: string } | undefined;
      if (prior) return JSON.parse(prior.payload) as Binding;
      const binding: Binding = {
        id, requestId, accountId: row.account_id, domain: row.data_domain,
        version: ['answered', 'failed', 'cancelled'].includes(row.status) ? Math.max(0, row.result_version - 1) : row.result_version,
        run: job.run,
        credentialRef: credentials.put(Buffer.from(job.token), RECOVERY_WINDOW_MS),
      };
      appendDomainEvent(db, {
        eventId: id, aggregateId: requestId, aggregateVersion: binding.version, accountId: binding.accountId,
        dataDomain: binding.domain, causationId: `consultation.requested:${requestId}`, payload: binding, destination: BINDING,
      });
      return binding;
    });
  }

  function stage(binding: Binding, result: HubResult): string {
    return withImmediateTransaction(db, () => {
      const id = `${binding.id}:result`;
      const body = { binding, result } as unknown as Json;
      const recorded = db.prepare('SELECT payload FROM domain_events WHERE event_id = ?').get(id) as { payload: string } | undefined;
      if (recorded) {
        if (recorded.payload !== canonicalPayload(body)) throw new Error('CONSULTATION_HUB_RESULT_CONFLICT');
        return id;
      }
      appendDomainEvent(db, {
        eventId: id, aggregateId: binding.requestId, aggregateVersion: binding.version,
        accountId: binding.accountId, dataDomain: binding.domain, causationId: binding.id, payload: body, destination: DELIVERY,
      });
      ackOutbox(db, binding.id, BINDING, 'accepted');
      return id;
    });
  }

  async function post(row: Pick<EventRow, 'event_id' | 'payload'>, signal?: AbortSignal) {
    const { binding, result } = JSON.parse(row.payload) as { binding: Binding; result: HubResult };
    const bytes = credentials.resolve(binding.credentialRef);
    if (!bytes) throw new Error('CONSULTATION_HUB_RUN_CREDENTIAL_UNAVAILABLE');
    const token = Buffer.from(bytes).toString('utf8');
    if (!binding.id.endsWith(`:${createHash('sha256').update(token).digest('hex')}`)) throw new Error('CONSULTATION_HUB_RUN_CREDENTIAL_MISMATCH');
    const reply = signal ? await hub.result(binding.run, token, result, signal)
      : await hub.result(binding.run, token, result);
    if (reply.rejected.length !== 0) throw new Error('CONSULTATION_HUB_RESULT_REJECTED');
    withImmediateTransaction(db, () => {
      const stored = db.prepare('SELECT result FROM outbox WHERE event_id = ? AND destination = ?').get(row.event_id, DELIVERY) as
        { result: string | null } | undefined;
      if (stored?.result === null) ackOutbox(db, row.event_id, DELIVERY, 'accepted');
    });
  }

  return {
    bind,
    lastStagedRun(): number | null {
      // Use binding order: recovering an earlier result later must not rewind the claim cursor.
      const row = db.prepare(`SELECT json_extract(b.payload, '$.run') AS run
        FROM outbox o JOIN domain_events b USING (event_id)
        JOIN domain_events d ON d.event_id = b.event_id || ':result'
        WHERE o.destination = ? AND o.result IS NOT NULL ORDER BY b.seq DESC LIMIT 1`)
        .get(BINDING) as { run: number } | undefined;
      return row?.run ?? null;
    },
    hasStaged(binding: Binding): boolean {
      return Boolean(db.prepare('SELECT 1 FROM domain_events WHERE event_id = ?').get(`${binding.id}:result`));
    },
    stage,
    async sendStaged(id: string, signal?: AbortSignal): Promise<void> {
      const row = db.prepare(`SELECT e.event_id, e.payload FROM domain_events e JOIN outbox o USING (event_id)
        WHERE e.event_id = ? AND o.destination = ? AND o.result IS NULL`).get(id, DELIVERY) as EventRow | undefined;
      if (row) await post(row, signal);
    },
    async recover(limit: number, onError: (error: unknown) => void, signal?: AbortSignal): Promise<void> {
      // A crash may follow the final SQLite commit and precede recording the Hub payload.
      const ready = db.prepare(`SELECT e.payload, c.status FROM domain_events e JOIN outbox o USING (event_id)
        JOIN consultations c ON c.request_id = e.aggregate_id AND c.account_id = e.account_id AND c.data_domain = e.data_domain
        WHERE o.destination = ? AND o.result IS NULL AND c.result_version = e.aggregate_version + 1
          AND c.status IN ('answered', 'failed', 'cancelled') ORDER BY e.seq LIMIT ?`).all(BINDING, limit) as
        Array<{ payload: string; status: 'answered' | 'failed' | 'cancelled' }>;
      for (const row of ready) {
        if (signal?.aborted) return;
        try { stage(JSON.parse(row.payload) as Binding, consultationHubResult(row.status === 'cancelled' ? null : row.status)); }
        catch (error) { onError(error); }
      }
      const readWindow = db.prepare(`SELECT e.seq, e.event_id, e.payload FROM domain_events e JOIN outbox o USING (event_id)
        WHERE o.destination = ? AND o.result IS NULL AND e.seq > ? ORDER BY e.seq LIMIT ?`);
      let rows = readWindow.all(DELIVERY, deliveryCursor, limit) as EventRow[];
      if (rows.length === 0 && deliveryCursor !== 0) rows = readWindow.all(DELIVERY, 0, limit) as EventRow[];
      for (const row of rows) {
        if (signal?.aborted) return;
        deliveryCursor = row.seq;
        try { await post(row, signal); } catch (error) { onError(error); }
      }
    },
  };
}
