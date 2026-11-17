import { withDeferredTransaction, type SqliteDatabase } from '../database.js';
import type { ProjectionScope } from './cursors.js';
import { collectHealthFacts } from './health.js';
import type { WorkFact, WorkProjectionBatch, WorkState } from './work.js';

type SourceScope = Pick<ProjectionScope, 'accountId' | 'dataDomain'>;
type WorkSourceRow = { work_id: string; root_id: string; generation: number; control_state: string;
  phase: 'judgment' | 'collect_evidence' | 'delivery'; stage: 'open' | 'waiting_evidence' | 'evidence_ready' | 'delivering' | null;
  awaiting_answer: number; question_id: string | null; hub_card_id: number | null; updated_at: string;
  answer_verified: number;
  delivery_id: string | null; effect_status: string | null; has_delivery_event: number; delivered_at: string | null };
type HubEvent = { source: string; type: string; subject: string };
type HubRun = { id: number; state: string; events: HubEvent[] };
type HubView = { runs: HubRun[]; cards: { id: number; state: string }[] };
type Binding = { account_id: string; data_domain: string; root: string; generation: number;
  wire_type: string; subject: string; domain_seq: number };
const hubName = 'hub_observer';

/** Reads the facts for one domain. No Hub run state is authority for a delivery. */
export function deriveWorkBatch(db: SqliteDatabase, scope: SourceScope, now: Date, staleAfterMs = 60_000): WorkProjectionBatch {
  return withDeferredTransaction(db, () => {
    const version = db.prepare('SELECT hub_seq, snapshot, imported_at FROM hub_snapshots WHERE cursor_name=?')
      .get(hubName) as { hub_seq: number; snapshot: string; imported_at: string } | undefined;
    const hubCursor = db.prepare('SELECT hub_seq FROM projection_cursors WHERE name=?').get(hubName) as { hub_seq: number } | undefined;
    const local = db.prepare(`SELECT COALESCE((SELECT domain_seq FROM projection_cursors WHERE name='local'),0) AS observed,
      COALESCE(MAX(seq),0) AS required FROM domain_events`).get() as { observed: number; required: number };
    const hub = version ? asHubView(version.snapshot) : null;
    const watermark = { hub_seq: hub && version ? Math.min(version.hub_seq, hubCursor?.hub_seq ?? 0) : 0,
      domain_seq: Math.min(local.observed, local.required) };
    let coverage: WorkProjectionBatch['coverage'] = !hub || !version ? 'unknown'
      : hubCursor?.hub_seq !== version.hub_seq ? 'syncing'
        : now.getTime() - Date.parse(version.imported_at) > staleAfterMs ? 'stale' : 'fresh';
    if (local.observed !== local.required) coverage = 'syncing';

    const rows = db.prepare(`WITH latest AS (
      SELECT work_id, MAX(generation) AS generation FROM work_generations
      WHERE account_id=@account AND data_domain=@domain GROUP BY work_id
    ), closed_questions AS (
      SELECT b.question_id, b.question_version, b.work_id, b.generation,
        ROW_NUMBER() OVER (PARTITION BY b.work_id,b.generation
          ORDER BY b.updated_at DESC,b.created_at DESC,b.rowid DESC) AS recent
      FROM question_bindings b JOIN latest USING (work_id,generation)
      WHERE b.account_id=@account AND b.data_domain=@domain AND b.status='closed' AND b.schema_version LIKE '1.%'
    ) SELECT w.work_id,w.root_id,w.generation,w.control_state,w.phase,s.stage,w.awaiting_answer,w.updated_at,
      q.question_id,q.hub_card_id,(v.seq IS NOT NULL) AS answer_verified,r.status AS effect_status,
      CASE WHEN r.status='verified' AND d.event_id IS NOT NULL THEN i.intent_id ELSE NULL END AS delivery_id,
      CASE WHEN r.status='verified' AND d.event_id IS NOT NULL THEN r.updated_at ELSE NULL END AS delivered_at,
      EXISTS (SELECT 1 FROM domain_events x WHERE x.account_id=w.account_id AND x.data_domain=w.data_domain
        AND x.aggregate_id=w.work_id AND x.aggregate_version=w.generation
        AND json_extract(x.payload,'$.type')='work.delivered') AS has_delivery_event
    FROM latest
    JOIN work_generations w USING (work_id,generation)
    LEFT JOIN work_stages s ON s.work_id=w.work_id AND s.generation=w.generation
    LEFT JOIN question_bindings q ON q.rowid=(SELECT a.rowid FROM question_bindings a
      WHERE a.account_id=w.account_id AND a.data_domain=w.data_domain AND a.work_id=w.work_id
        AND a.generation=w.generation AND a.status='open'
      ORDER BY a.updated_at DESC,a.question_version DESC,a.question_id LIMIT 1)
    LEFT JOIN closed_questions b ON q.question_id IS NULL AND b.work_id=w.work_id AND b.generation=w.generation AND b.recent=1
    LEFT JOIN answer_receipts a ON a.question_id=b.question_id AND a.question_version=b.question_version
      AND a.account_id=w.account_id AND a.data_domain=w.data_domain AND a.work_id=w.work_id AND a.generation=w.generation
      AND a.validity='verified' AND a.disposition='proceed' AND a.schema_version LIKE '1.%'
    LEFT JOIN domain_events v ON v.event_id='answer.verified:' || a.question_id || ':' || a.hub_answer_event_id
      AND v.account_id=w.account_id AND v.data_domain=w.data_domain AND v.aggregate_id=a.question_id
      AND v.aggregate_version=a.question_version AND v.causation_id=a.intent_id AND v.seq<=@domainSeq AND v.schema_version LIKE '1.%'
      AND json_extract(v.payload,'$.type')='answer.verified' AND json_extract(v.payload,'$.work_id')=w.work_id
      AND json_extract(v.payload,'$.generation')=w.generation AND json_extract(v.payload,'$.question_id')=a.question_id
      AND json_extract(v.payload,'$.answer_event_id')=a.hub_answer_event_id
    LEFT JOIN effect_intents i ON i.account_id=w.account_id AND i.data_domain=w.data_domain
      AND i.work_id=w.work_id AND i.generation=w.generation AND i.action='publish_pr'
    LEFT JOIN effect_receipts r ON r.intent_id=i.intent_id
    LEFT JOIN domain_events d ON d.event_id=(SELECT x.event_id FROM domain_events x
      WHERE x.account_id=w.account_id AND x.data_domain=w.data_domain AND x.aggregate_id=w.work_id
        AND x.aggregate_version=w.generation AND json_extract(x.payload,'$.type')='work.delivered'
        AND json_extract(x.payload,'$.intent_id')=i.intent_id AND x.seq<=@domainSeq AND x.schema_version LIKE '1.%'
      ORDER BY x.seq DESC LIMIT 1) ORDER BY w.work_id`).all({
      account: scope.accountId, domain: scope.dataDomain, domainSeq: watermark.domain_seq,
    }) as WorkSourceRow[];

    const observedHub = version?.hub_seq === hubCursor?.hub_seq ? hub : null;
    const attempts = bindAttempts(db, scope, observedHub?.runs ?? [], watermark.domain_seq);
    const cards = new Map(observedHub?.cards.map((card) => [card.id, card.state]) ?? []);
    const items: WorkFact[] = rows.map((row) => {
      const observed = attempts.get(workKey(row.root_id, row.generation)) ?? [];
      const cardState = row.hub_card_id === null ? undefined : cards.get(row.hub_card_id);
      const awaitingAnswer = row.awaiting_answer === 1 && row.question_id !== null;
      const inEvidenceStage = row.stage !== null && row.stage !== 'open';
      const answerNeedsProof = awaitingAnswer
        ? cardState === 'answered' || cardState === 'closed'
        : (row.awaiting_answer === 1 || inEvidenceStage) && row.answer_verified !== 1;
      const deliveryNeedsProof = !row.delivery_id && (row.has_delivery_event === 1 || row.effect_status === 'verified');
      if (answerNeedsProof || deliveryNeedsProof) coverage = 'syncing';
      return { work_id: row.work_id, generation: row.generation, updated_at: row.delivered_at ?? row.updated_at,
        state: deriveWorkState(row, awaitingAnswer, inEvidenceStage, answerNeedsProof || deliveryNeedsProof, observed.at(-1)?.state),
        attempt_ids: observed.map((run) => run.id), question_id: row.question_id, delivery_id: row.delivery_id };
    });
    return { watermark, at: now.toISOString(), coverage, items, health: collectHealthFacts(db, scope) };
  });
}

function deriveWorkState(row: WorkSourceRow, awaitingAnswer: boolean, inEvidenceStage: boolean, missingProof: boolean, hubState?: string): WorkState {
  if (row.delivery_id) return 'delivered';
  if (row.control_state === 'paused') return 'paused';
  if (row.control_state === 'stopped' || row.control_state === 'processing' ||
      row.effect_status === 'blocked' || row.effect_status === 'conflict') return 'blocked';
  if (missingProof || row.effect_status === 'uncertain') return 'verifying';
  if (awaitingAnswer) return 'awaiting_answer';
  // An answered question may leave awaiting_answer set until continuation claims it.
  if (row.awaiting_answer === 1 || inEvidenceStage || row.phase !== 'judgment') return 'verifying';
  return hubState === 'unknown' ? 'blocked' : 'researching';
}

function bindAttempts(db: SqliteDatabase, scope: SourceScope, runs: HubRun[], domainSeq: number): Map<string, HubRun[]> {
  // The pinned Hub snapshot exposes source, type and subject, but no original event ID for every kind.
  // Use only unique local durable bindings for that exact wire key, across all accounts and domains.
  const subjects = [...new Set(runs.flatMap((run) => run.events.filter((event) => event.source === 'patrick').map((event) => event.subject)))];
  const binding = new Map<string, Binding | null>();
  const rows = db.prepare(`SELECT d.account_id,d.data_domain,d.seq AS domain_seq,h.root,h.generation,
    CASE WHEN h.kind='work.requested' THEN 'source.changed' ELSE h.kind END AS wire_type,
    CASE WHEN h.kind='work.requested' THEN h.event_id ELSE h.stage_key END AS subject
    FROM hub_events h JOIN domain_events d ON d.event_id=h.event_id
    WHERE h.kind IN ('work.requested','answer.verified','evidence.ready')
      AND (CASE WHEN h.kind='work.requested' THEN h.event_id ELSE h.stage_key END) IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(subjects)) as Binding[];
  for (const row of rows) {
    const key = workKey(row.subject, row.wire_type);
    binding.set(key, binding.has(key) ? null : row);
  }
  const mapped = new Map<string, HubRun[]>();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) {
    const candidates = run.events.filter((event) => event.source === 'patrick' && event.type !== 'timer.due');
    const links = candidates.map((event) => binding.get(workKey(event.subject, event.type)))
      .filter((link): link is Binding => link != null && link.domain_seq <= domainSeq);
    if (links.length !== candidates.length) continue;
    const seen = new Set(links.map((link) => JSON.stringify([link.account_id, link.data_domain, link.root, link.generation])));
    const link = seen.size === 1 ? links[0] : undefined;
    if (!link || link.account_id !== scope.accountId || link.data_domain !== scope.dataDomain) continue;
    const key = workKey(link.root, link.generation);
    const chain = mapped.get(key) ?? [];
    if (chain.at(-1)?.id !== run.id) chain.push(run);
    mapped.set(key, chain);
  }
  return mapped;
}

function asHubView(value: string): HubView | null {
  try {
    const parsed = JSON.parse(value) as Partial<HubView> | null;
    if (!parsed || !Array.isArray(parsed.runs) || !Array.isArray(parsed.cards)) return null;
    return { runs: parsed.runs.filter((run) => Number.isSafeInteger(run.id) && Array.isArray(run.events)), cards: parsed.cards };
  } catch { return null; }
}

function workKey(subject: string, versionOrType: number | string): string {
  return JSON.stringify([subject, versionOrType]);
}
