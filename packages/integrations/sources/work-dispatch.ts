import { createHash } from 'node:crypto';
import { ackOutbox, assertRecoveryWriteAllowed, recoveryWriteAllowed, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { createStandardsApi } from '../../domain/src/standards.js';
import { publishHubEvent, type HubPublisher } from '../autoloop/client.js';

/** Turns an admitted source change into a work root and dispatches it to the hub.
 *
 * §4.4 keeps this path narrow: only an admitted trigger produces work, and the
 * dispatch itself never carries source content. The work root, its cause and the
 * frozen judgment basis are recorded before the hub event goes out, so an
 * interrupted dispatch can be replayed without creating a second work.
 */

export type SourceWorkDispatchOptions = {
  now?: () => Date;
  limit?: number;
};

export type SourceWorkDispatched = {
  work_id: string;
  generation: number;
  event_id: string;
  result: 'accepted' | 'duplicate';
};

export type SourceWorkDeferred = {
  event_id: string;
  reason: string;
};

export type SourceWorkDispatchResult = {
  dispatched: SourceWorkDispatched[];
  deferred: SourceWorkDeferred[];
};

export const SOURCE_WORK_LANE = 'work';
export const SOURCE_WORK_COMPLETION = 'verified-pr';

const DEFAULT_LIMIT = 32;
const SCHEMA_VERSION = '1.0';

type PreparedWork =
  | { ok: true; work_id: string; root: string; cause: string; generation: number; hops: number }
  | { ok: false; reason: string };

type SourceEvent = {
  event_id: string;
  aggregate_id: string;
  account_id: string;
  data_domain: string;
  payload: { sourceId?: string; objectId?: string; revisionId?: string };
};

type SourceRow = {
  source_id: string;
  account_id: string;
  data_domain: string;
  has_trigger_rule: number;
  enabled: number;
  status: string;
};

type MandateRow = {
  mandate_id: string;
  budget_micros: number;
  status: string;
};

export function sourceWorkId(sourceId: string, objectId: string): string {
  return `W-${createHash('sha256').update(`${sourceId}\0${objectId}`).digest('hex').slice(0, 12).toUpperCase()}`;
}

function loadEvent(db: SqliteDatabase, eventId: string): SourceEvent | undefined {
  const row = db.prepare(`SELECT event_id, aggregate_id, account_id, data_domain, payload
    FROM domain_events WHERE event_id = ?`).get(eventId) as {
    event_id: string;
    aggregate_id: string;
    account_id: string;
    data_domain: string;
    payload: string;
  } | undefined;
  if (!row) return undefined;
  let payload: SourceEvent['payload'];
  try {
    payload = JSON.parse(row.payload) as SourceEvent['payload'];
  } catch {
    payload = {};
  }
  return { ...row, payload };
}

function loadSource(db: SqliteDatabase, sourceId: string): SourceRow | undefined {
  return db.prepare(`SELECT source_id, account_id, data_domain, has_trigger_rule, enabled, status
    FROM source_configs WHERE source_id = ?`).get(sourceId) as SourceRow | undefined;
}

function loadMandate(db: SqliteDatabase, source: SourceRow): MandateRow | undefined {
  const trigger = db.prepare(`SELECT mandate_type_id FROM source_trigger_rules WHERE source_id = ?`)
    .get(source.source_id) as { mandate_type_id: string } | undefined;
  if (trigger) {
    return db.prepare(`SELECT mandate_id, budget_micros, status FROM mandates
      WHERE type_id = ? AND account_id = ? AND data_domain = ? AND status = 'active'
      ORDER BY mandate_id LIMIT 1`).get(
      trigger.mandate_type_id,
      source.account_id,
      source.data_domain,
    ) as MandateRow | undefined;
  }
  const candidates = db.prepare(`SELECT mandate_id, budget_micros, status FROM mandates
    WHERE account_id = ? AND data_domain = ? AND status = 'active'
    ORDER BY mandate_id`).all(
    source.account_id,
    source.data_domain,
  ) as MandateRow[];
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Carries the work's frozen basis into a later generation.
 *
 * §3.2 fixes the standard revision before the first judgment of a work and keeps
 * later attempts, questions and continuations on that same basis.
 */
function carryJudgmentBasis(db: SqliteDatabase, workId: string, generation: number, now: string): boolean {
  const root = db.prepare(`SELECT work_id, generation, account_id, data_domain, basis_hash, standards_json,
    external_method_id, external_method_revision, evidence_watermark
    FROM judgment_bases WHERE work_id = ? AND generation = 1`).get(workId) as {
    work_id: string;
    generation: number;
    account_id: string;
    data_domain: string;
    basis_hash: string;
    standards_json: string;
    external_method_id: string | null;
    external_method_revision: string | null;
    evidence_watermark: number;
  } | undefined;
  if (!root) return false;
  const existing = db.prepare('SELECT 1 AS present FROM judgment_bases WHERE work_id = ? AND generation = ?')
    .get(workId, generation);
  if (existing) return true;
  db.prepare(`INSERT INTO judgment_bases (
    work_id, generation, account_id, data_domain, basis_hash, standards_json, external_method_id,
    external_method_revision, evidence_watermark, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    workId,
    generation,
    root.account_id,
    root.data_domain,
    root.basis_hash,
    root.standards_json,
    root.external_method_id,
    root.external_method_revision,
    root.evidence_watermark,
    now,
  );
  const dependencies = db.prepare(`SELECT from_id, from_version, to_id, to_version, data_domain, epoch
    FROM evidence_dependencies WHERE from_kind = 'work' AND from_id = ? AND from_version = ?`)
    .all(workId, root.generation) as Array<{
      from_id: string;
      from_version: number;
      to_id: string;
      to_version: number;
      data_domain: string;
      epoch: number;
    }>;
  for (const dependency of dependencies) {
    db.prepare(`INSERT INTO evidence_dependencies (
      dependency_id, from_kind, from_id, from_version, to_kind, to_id, to_version, data_domain, epoch, created_at
    ) VALUES (?, 'work', ?, ?, 'standard', ?, ?, ?, ?, ?)`).run(
      `dep_${createHash('sha256').update(`${workId}\0${generation}\0${dependency.to_id}\0${dependency.to_version}`).digest('hex').slice(0, 24)}`,
      workId,
      generation,
      dependency.to_id,
      dependency.to_version,
      dependency.data_domain,
      dependency.epoch,
      now,
    );
  }
  return true;
}

function prepareWork(db: SqliteDatabase, eventId: string, now: string): PreparedWork {
  const event = loadEvent(db, eventId);
  if (!event) return { ok: false, reason: 'DOMAIN_EVENT_MISSING' };
  const sourceId = event.payload.sourceId;
  const objectId = event.payload.objectId ?? event.aggregate_id;
  const revisionId = event.payload.revisionId;
  if (!sourceId || !objectId || !revisionId) return { ok: false, reason: 'SOURCE_EVENT_INCOMPLETE' };
  const source = loadSource(db, sourceId);
  if (!source) return { ok: false, reason: 'SOURCE_MISSING' };
  if (source.enabled !== 1 || source.status !== 'enabled') return { ok: false, reason: 'SOURCE_NOT_ENABLED' };
  if (source.has_trigger_rule !== 1) return { ok: false, reason: 'TRIGGER_RULE_MISSING' };
  const mandate = loadMandate(db, source);
  if (!mandate) return { ok: false, reason: 'NO_ACTIVE_MANDATE' };

  const workId = sourceWorkId(sourceId, objectId);
  return withImmediateTransaction(db, () => {
    if (!recoveryWriteAllowed(db, source.data_domain)) return { ok: false, reason: 'RECOVERY_WRITE_BLOCKED' };
    const existing = db.prepare(`SELECT work_id, root_event_id, cause_event_id, generation, revision
      FROM work_refs WHERE work_id = ?`).get(workId) as {
      work_id: string;
      root_event_id: string;
      cause_event_id: string;
      generation: number;
      revision: number;
    } | undefined;
    const replay = existing?.cause_event_id === eventId;
    const generation = existing ? (replay ? existing.generation : existing.generation + 1) : 1;
    const root = existing?.root_event_id ?? eventId;
    const cause = eventId;
    if (!existing) {
      db.prepare(`INSERT INTO work_refs (
        work_id, account_id, data_domain, source_id, object_id, root_event_id, cause_event_id, source_revision,
        hub_lane, completion_condition, delivery_ref, generation, revision, schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?)`).run(
        workId,
        source.account_id,
        source.data_domain,
        sourceId,
        objectId,
        root,
        cause,
        revisionId,
        SOURCE_WORK_LANE,
        SOURCE_WORK_COMPLETION,
        generation,
        SCHEMA_VERSION,
        now,
        now,
      );
    } else if (!replay) {
      db.prepare(`UPDATE work_refs SET cause_event_id = ?, source_revision = ?, generation = ?, revision = ?,
        updated_at = ? WHERE work_id = ?`).run(cause, revisionId, generation, existing.revision + 1, now, workId);
    }
    const work = db.prepare('SELECT 1 AS present FROM work_generations WHERE work_id = ? AND generation = ?')
      .get(workId, generation);
    if (!work) {
      db.prepare(`INSERT INTO work_generations (
        work_id, generation, account_id, data_domain, root_id, mandate_id, phase, next_action,
        awaiting_answer, evidence_ready, collection_id, control_state, process_tree_stopped, effects_reconciled,
        attempt_closed, current_attempt_id, revision, schema_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'judgment', 'judge', 0, 0, NULL, 'running', 0, 0, 0, NULL, 0, ?, ?, ?)`).run(
        workId,
        generation,
        source.account_id,
        source.data_domain,
        workId,
        mandate.mandate_id,
        SCHEMA_VERSION,
        now,
        now,
      );
    }
    db.prepare(`INSERT INTO business_budgets (
      business_id, account_id, data_domain, subject_kind, limit_micros, held_micros, spent_micros,
      schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, 'work', ?, 0, 0, ?, ?, ?)
    ON CONFLICT(business_id) DO NOTHING`).run(
      `work:${workId}`,
      source.account_id,
      source.data_domain,
      mandate.budget_micros,
      SCHEMA_VERSION,
      now,
      now,
    );
    if (generation > 1) carryJudgmentBasis(db, workId, generation, now);
    return { ok: true, work_id: workId, root, cause, generation, hops: 0 } as const;
  });
}

export async function dispatchSourceWork(
  db: SqliteDatabase,
  hub: HubPublisher,
  options: SourceWorkDispatchOptions = {},
): Promise<SourceWorkDispatchResult> {
  const now = options.now ?? (() => new Date());
  const limit = options.limit ?? DEFAULT_LIMIT;
  const dispatched: SourceWorkDispatched[] = [];
  const deferred: SourceWorkDeferred[] = [];
  const pending = db.prepare(`SELECT o.event_id FROM outbox o
    JOIN domain_events e ON e.event_id = o.event_id
    WHERE o.destination = 'source-work' AND o.result IS NULL
    ORDER BY e.seq LIMIT ?`).all(limit) as Array<{ event_id: string }>;

  for (const { event_id: eventId } of pending) {
    const stamped = now().toISOString();
    const prepared = prepareWork(db, eventId, stamped);
    if (!prepared.ok) {
      deferred.push({ event_id: eventId, reason: prepared.reason });
      continue;
    }
    const source = loadSource(db, loadEvent(db, eventId)?.payload.sourceId ?? '');
    if (!source) {
      deferred.push({ event_id: eventId, reason: 'SOURCE_MISSING' });
      continue;
    }
    try {
      const standards = createStandardsApi(db, {
        account_id: source.account_id,
        caller_id: 'source-work',
        auth_epoch: 0,
        domains: [source.data_domain],
        operations: ['standards.freeze'],
      }, { now, domain: source.data_domain });
      await standards.freezeJudgmentBasis(prepared.work_id, prepared.generation);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'JUDGMENT_BASIS_UNAVAILABLE';
      deferred.push({ event_id: eventId, reason });
      continue;
    }
    const assertWritable = () => assertRecoveryWriteAllowed(db, source.data_domain);
    try {
      const result = await publishHubEvent(db, hub, {
        event_id: eventId,
        root: prepared.root,
        cause: prepared.cause,
        generation: prepared.generation,
        hops: prepared.hops,
        kind: 'work.requested',
      }, stamped, assertWritable);
      withImmediateTransaction(db, () => {
        assertWritable();
        ackOutbox(db, eventId, 'source-work', result);
      });
      dispatched.push({ work_id: prepared.work_id, generation: prepared.generation, event_id: eventId, result });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'RECOVERY_WRITE_BLOCKED') throw error;
      deferred.push({ event_id: eventId, reason: error.message });
    }
  }
  return { dispatched, deferred };
}
