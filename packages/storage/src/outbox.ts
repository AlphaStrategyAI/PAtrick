import { canonicalPayload, type Json } from '@patrick/contracts';
import { withImmediateTransaction, type SqliteDatabase } from './database.js';

export type DomainEventInput = {
  eventId: string;
  aggregateId: string;
  aggregateVersion: number;
  accountId: string;
  dataDomain: string;
  payload: Json;
  destination: string;
  causationId?: string | null;
};

const CURSOR_NAME = 'local';

export function appendDomainEvent(db: SqliteDatabase, input: DomainEventInput): { seq: number } {
  return withImmediateTransaction(db, () => {
    const now = new Date().toISOString();
    const next = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM domain_events').get() as { seq: number };
    db.prepare(`INSERT INTO domain_events (
      seq, event_id, aggregate_id, aggregate_version, causation_id,
      account_id, data_domain, schema_version, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '1.0', ?, ?)`).run(
      next.seq,
      input.eventId,
      input.aggregateId,
      input.aggregateVersion,
      input.causationId ?? null,
      input.accountId,
      input.dataDomain,
      canonicalPayload(input.payload),
      now,
    );
    db.prepare('INSERT INTO outbox (event_id, destination) VALUES (?, ?)').run(input.eventId, input.destination);
    db.prepare(`INSERT INTO projection_cursors (name, hub_seq, domain_seq, updated_at)
      VALUES (?, 0, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        domain_seq = excluded.domain_seq,
        updated_at = excluded.updated_at`).run(CURSOR_NAME, next.seq, now);
    return { seq: next.seq };
  });
}

export function ackOutbox(
  db: SqliteDatabase,
  eventId: string,
  destination: string,
  result: 'accepted' | 'duplicate',
): void {
  if (result !== 'accepted' && result !== 'duplicate') throw new Error('OUTBOX_RESULT_INVALID');
  withImmediateTransaction(db, () => {
    const info = db.prepare(`UPDATE outbox
      SET result = ?, acked_at = ?
      WHERE event_id = ?
        AND destination = ?
        AND result IS NULL
        AND EXISTS (SELECT 1 FROM domain_events WHERE domain_events.event_id = outbox.event_id)`).run(
      result,
      new Date().toISOString(),
      eventId,
      destination,
    );
    if (info.changes !== 1) throw new Error('OUTBOX_NOT_ACKABLE');
  });
}
