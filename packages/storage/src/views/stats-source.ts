import type { SqliteDatabase } from '../database.js';

export type FactKind = 'owner_decision' | 'automatic_decision' | 'delivered_work';
type Fact = { op: 'accept'; kind: FactKind; key: string; seq: number; at: string };
type Correction = { op: 'invalidate'; kind: FactKind; key: string; seq: number };
export type Mutation = Fact | Correction;
export type StatsScope = { accountId: string; dataDomain: string };
type EventRow = { seq: number; aggregate_id: string; aggregate_version: number; payload: string; created_at: string };
const types = ['owner_decision', 'automatic_decision', 'delivered_work'];
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function prepareStatsFacts(db: SqliteDatabase) {
  const events = db.prepare(`SELECT seq,aggregate_id,aggregate_version,payload,created_at
    FROM domain_events WHERE account_id=? AND data_domain=? AND seq>? AND seq<=? AND schema_version GLOB '1.[0-9]*'
    ORDER BY seq LIMIT ?`);
  const answer = db.prepare(`SELECT created_at FROM answer_receipts WHERE account_id=? AND data_domain=?
    AND question_id=? AND question_version=? AND work_id=? AND generation=? AND hub_answer_event_id=?
    AND validity='verified' AND disposition='proceed' AND schema_version GLOB '1.[0-9]*'`);
  const delivery = db.prepare(`SELECT r.updated_at AS created_at FROM effect_receipts r
    JOIN effect_intents i ON i.intent_id=r.intent_id WHERE i.account_id=? AND i.data_domain=? AND i.work_id=?
    AND i.generation=? AND i.intent_id=? AND i.origin='business' AND i.action='publish_pr'
    AND r.status='verified' AND r.remote_number IS NOT NULL`);
  const automatic = db.prepare(`SELECT 1 FROM execution_grants g JOIN judgment_bases b
      ON b.work_id=g.work_id AND b.generation=g.generation AND b.account_id=g.account_id
      AND b.data_domain=g.data_domain AND b.basis_hash=g.basis_hash
    JOIN mandates m ON m.mandate_id=g.mandate_id AND m.account_id=g.account_id AND m.data_domain=g.data_domain
    JOIN work_generations w ON w.work_id=g.work_id AND w.generation=g.generation
      AND w.account_id=g.account_id AND w.data_domain=g.data_domain AND w.mandate_id=g.mandate_id
    JOIN domain_events e ON e.event_id=w.root_id AND e.account_id=w.account_id AND e.data_domain=w.data_domain
    JOIN outbox o ON o.event_id=e.event_id AND o.destination='source-work'
    JOIN source_revisions r ON e.event_id='work:' || r.revision_id AND r.object_id=e.aggregate_id
      AND r.observed_seq=e.aggregate_version AND r.account_id=w.account_id AND r.data_domain=w.data_domain
    WHERE r.revision_id=@source AND r.tombstone=0 AND e.seq<@seq
      AND CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.admitted')=1 ELSE 0 END
      AND g.account_id=@account AND g.data_domain=@domain AND g.work_id=@work AND g.generation=@generation
      AND g.grant_id=@grant AND g.basis_hash=@basis AND g.mandate_id=@mandate AND g.subject_kind='work'
      AND g.phase='judgment' AND g.next_action='judge' AND g.created_at<=@at AND g.expires_at>@at
      AND (g.revoked_at IS NULL OR g.revoked_at>@at) AND json_array_length(b.standards_json)>0`);

  function admitted(row: EventRow, scope: StatsScope): Mutation | undefined {
    let value: unknown;
    try { value = JSON.parse(row.payload); } catch { return; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const p = value as Record<string, unknown>;
    const target = [scope.accountId, scope.dataDomain];
    if (p.type === 'answer.verified' && p.question_id === row.aggregate_id && nonempty(p.work_id)
        && version(p.generation) && nonempty(p.answer_event_id)) {
      const receipt = answer.get(...target, p.question_id, row.aggregate_version, p.work_id, p.generation, p.answer_event_id) as { created_at: string } | undefined;
      if (receipt) return { op: 'accept', kind: 'owner_decision', key: p.answer_event_id, seq: row.seq, at: receipt.created_at };
    }
    if (p.type === 'work.delivered' && p.work_id === row.aggregate_id && p.generation === row.aggregate_version && nonempty(p.intent_id)) {
      const receipt = delivery.get(...target, p.work_id, p.generation, p.intent_id) as { created_at: string } | undefined;
      if (receipt) return { op: 'accept', kind: 'delivered_work', key: row.aggregate_id, seq: row.seq, at: receipt.created_at };
    }
    if (p.type === 'decision.committed' && p.work_id === row.aggregate_id && p.generation === row.aggregate_version
        && nonempty(p.decision_event_id) && nonempty(p.grant_id) && nonempty(p.basis_hash)
        && nonempty(p.source_revision_id) && nonempty(p.mandate_id)
        && automatic.get({ account: scope.accountId, domain: scope.dataDomain, work: row.aggregate_id,
          generation: row.aggregate_version, grant: p.grant_id, basis: p.basis_hash, source: p.source_revision_id, mandate: p.mandate_id, at: row.created_at, seq: row.seq })) {
      return { op: 'accept', kind: 'automatic_decision', key: p.decision_event_id, seq: row.seq, at: row.created_at };
    }
    if (p.type === 'stats.fact.invalidated' && p.fact_key === row.aggregate_id && nonempty(p.kind) && types.includes(p.kind)) {
      return { op: 'invalidate', kind: p.kind as FactKind, key: row.aggregate_id, seq: row.seq };
    }
  }

  return function batch(scope: StatsScope, after: number, through: number, limit: number) {
    const rows = events.all(scope.accountId, scope.dataDomain, after, through, limit + 1) as EventRow[];
    const page = rows.slice(0, limit);
    return {
      cursor: rows.length > limit ? page[page.length - 1].seq : through,
      mutations: page.flatMap((row) => {
        const mutation = admitted(row, scope);
        return mutation ? [mutation] : [];
      }),
    };
  };
}
