import { createHash } from 'node:crypto';
import { PAGE_DEFAULT, PAGE_MAX, type Snapshot } from '@patrick/contracts';
import { withDeferredTransaction, withImmediateTransaction, type SqliteDatabase } from '../database.js';
import type { createProjectionCursorCodec, ProjectionScope, ProjectionWindow } from './cursors.js';
import { healthSummary, type HealthSnapshot, type ProjectionHealthFacts } from './health.js';

export type WorkState = 'researching' | 'awaiting_answer' | 'verifying' | 'paused' | 'blocked' | 'delivered';
export type WorkFact = {
  work_id: string;
  generation: number;
  updated_at: string;
  state: WorkState;
  attempt_ids: readonly number[];
  question_id: string | null;
  delivery_id: string | null;
};
export type WorkFilters = { state: 'open' | 'awaiting_answer' | 'blocked' | 'delivered' | 'all'; limit?: number; cursor?: string };
export type WorkCounts = { open: number; awaiting_answer: number; blocked: number };
export type WorkItem = WorkFact & { revision: number };
type WorkList = { items: WorkItem[]; counts: WorkCounts; next_cursor: string | null };
type TimelineItem = { event_id: string; type: string; at: string };
type Watermark = Snapshot<never>['watermark'];
type Coverage = Snapshot<never>['freshness'];
export type WorkProjectionBatch = { items: readonly WorkFact[]; watermark: Watermark; at: string; coverage: Coverage; health?: ProjectionHealthFacts };
type ScopeKey = Pick<ProjectionScope, 'accountId' | 'dataDomain'>;
type Checkpoint = Watermark & { epoch: number; notification_seq: number; notification_floor: number; observed_at: string;
  trusted_as_of: string | null; freshness: Coverage; health_payload: string | null };
type WorkRow = { work_id: string; visible: number; revision: number; payload: string };
type EventRow = Watermark & { seq: number; kind: 'work.changed' | 'work.removed' | 'projection.changed'; resource_id: string | null;
  resource_revision: number | null; as_of: string };
type Replay = { status: 'reset_required' } | { status: 'ok'; events: { id: string; event: { event_id: string; type: string;
  resource_id: string | null; resource_revision: number | null; scope: Snapshot<never>['scope']; as_of: string; watermark: Watermark } }[] };

const epochStart = '1970-01-01T00:00:00.000Z';
const initial: Checkpoint = { epoch: 1, hub_seq: 0, domain_seq: 0, notification_seq: 0, notification_floor: 0,
  observed_at: epochStart, trusted_as_of: null, freshness: 'unknown', health_payload: null };
const clauses = {
  open: "AND state <> 'delivered'", awaiting_answer: "AND state = 'awaiting_answer'",
  blocked: "AND state IN ('paused','blocked')", delivered: "AND state = 'delivered'", all: '',
} as const;

export function covers(actual: Watermark, required: Watermark): boolean {
  return actual.hub_seq >= required.hub_seq && actual.domain_seq >= required.domain_seq;
}

export function createWorkProjection(db: SqliteDatabase, codec: ReturnType<typeof createProjectionCursorCodec>) {
  function checkpoint(scope: ScopeKey): Checkpoint {
    return (db.prepare('SELECT * FROM product_view_checkpoints WHERE account_id = ? AND data_domain = ?')
      .get(scope.accountId, scope.dataDomain) as Checkpoint | undefined) ?? initial;
  }
  function window(cp: Checkpoint): ProjectionWindow {
    return { epoch: cp.epoch, floor: cp.notification_floor, head: cp.notification_seq };
  }
  function scoped(scope: ProjectionScope): Snapshot<never>['scope'] {
    return { account_id: scope.accountId, data_domain: scope.dataDomain, permission_epoch: scope.permissionEpoch };
  }
  function envelope<T>(scope: ProjectionScope, cp: Checkpoint, data: T): Snapshot<T> {
    return { schema_version: '1.0', scope: scoped(scope), as_of: cp.trusted_as_of ?? cp.observed_at,
      watermark: { hub_seq: cp.hub_seq, domain_seq: cp.domain_seq }, freshness: cp.freshness, data,
      stream_cursor: codec.stream(scope, { epoch: cp.epoch, seq: cp.notification_seq }) };
  }

  return {
    apply(scope: ScopeKey, batch: WorkProjectionBatch, stillCurrent: () => boolean = () => true): boolean {
      const prepared = withDeferredTransaction(db, () => {
        const prior = checkpoint(scope);
        const canAdvance = batch.at >= prior.observed_at && covers(batch.watermark, prior);
        const previous = canAdvance ? db.prepare(`SELECT work_id, visible, revision, payload FROM product_work_views
          WHERE account_id=? AND data_domain=?`).all(scope.accountId, scope.dataDomain) as WorkRow[] : [];
        const changedSecondary = canAdvance && batch.watermark.domain_seq > prior.domain_seq
          && db.prepare(`SELECT 1 FROM domain_events WHERE account_id=? AND data_domain=? AND seq>? AND seq<=?
            AND schema_version LIKE '1.%' AND json_extract(payload,'$.type') IN
            ('vault.connection.changed','edit.receipt.changed','channel.test.updated','channel.mode.changed') LIMIT 1`)
            .get(scope.accountId, scope.dataDomain, prior.domain_seq, batch.watermark.domain_seq) !== undefined;
        return { prior, previous, canAdvance, changedSecondary };
      });
      const { prior, previous, changedSecondary } = prepared;
      const token = JSON.stringify(prior);
      if (batch.at < prior.observed_at) return false;
      const old = new Map(previous.map((row) => [row.work_id, row]));
      const seen = new Set<string>();
      const changes: { fact: WorkFact; revision: number; payload: string }[] = [];
      if (prepared.canAdvance) for (const fact of [...batch.items].sort((a, b) => a.work_id.localeCompare(b.work_id))) {
        if (seen.has(fact.work_id)) throw new Error('PROJECTION_DUPLICATE_WORK');
        seen.add(fact.work_id);
        const current = old.get(fact.work_id);
        const payload = JSON.stringify({ work_id: fact.work_id, generation: fact.generation,
          updated_at: fact.updated_at, state: fact.state, attempt_ids: [...new Set(fact.attempt_ids)].sort((a, b) => a - b),
          question_id: fact.question_id, delivery_id: fact.delivery_id });
        if (current?.visible && current.payload === payload) continue;
        changes.push({ fact, revision: (current?.revision ?? 0) + 1, payload });
      }
      const removals = previous.filter((row) => row.visible && !seen.has(row.work_id));
      const noWorkChange = !changes.length && !removals.length;
      const healthPayload = batch.health ? JSON.stringify(batch.health) : null;
      const watermarkChanged = batch.watermark.hub_seq !== prior.hub_seq || batch.watermark.domain_seq !== prior.domain_seq;
      const healthChanged = healthPayload !== prior.health_payload;
      const coverageChanged = batch.coverage !== prior.freshness;
      if (prepared.canAdvance && noWorkChange && !watermarkChanged && !healthChanged && !coverageChanged && !changedSecondary) return true;

      return withImmediateTransaction(db, () => {
        if (!stillCurrent() || JSON.stringify(checkpoint(scope)) !== token) return false;
        if (!prepared.canAdvance) {
          // Do not overwrite an established view with a regressed, missing or rebuilding source.
          if (batch.coverage !== 'fresh' && prior.freshness !== 'syncing') {
            const next = prior.notification_seq + 1;
            db.prepare(`INSERT INTO product_view_events
              (account_id,data_domain,seq,kind,resource_id,resource_revision,as_of,hub_seq,domain_seq)
              VALUES (?,?,?,'projection.changed',NULL,NULL,?,?,?)`)
              .run(scope.accountId, scope.dataDomain, next, prior.trusted_as_of ?? prior.observed_at, prior.hub_seq, prior.domain_seq);
            db.prepare(`UPDATE product_view_checkpoints SET freshness='syncing', notification_seq=?
              WHERE account_id=? AND data_domain=?`).run(next, scope.accountId, scope.dataDomain);
          }
          return true;
        }

        let sequence = prior.notification_seq;
        const notify = db.prepare(`INSERT INTO product_view_events
          (account_id, data_domain, seq, kind, resource_id, resource_revision, as_of, hub_seq, domain_seq)
          VALUES (?,?,?,?,?,?,?,?,?)`);
        const upsert = db.prepare(`INSERT INTO product_work_views
          (account_id,data_domain,work_id,revision,visible,state,updated_at,payload) VALUES (?,?,?,?,1,?,?,?)
          ON CONFLICT(account_id,data_domain,work_id) DO UPDATE SET revision=excluded.revision, visible=1,
          state=excluded.state, updated_at=excluded.updated_at, payload=excluded.payload`);
        const remove = db.prepare(`UPDATE product_work_views SET visible=0, revision=?
          WHERE account_id=? AND data_domain=? AND work_id=?`);
        const trustedTime = batch.coverage === 'fresh' ? batch.at : prior.trusted_as_of;
        const notificationTime = trustedTime ?? batch.at;
        for (const { fact, revision, payload } of changes) {
          upsert.run(scope.accountId, scope.dataDomain, fact.work_id, revision, fact.state, fact.updated_at, payload);
          notify.run(scope.accountId, scope.dataDomain, ++sequence, 'work.changed', fact.work_id, revision,
            notificationTime, batch.watermark.hub_seq, batch.watermark.domain_seq);
        }
        for (const row of removals) {
          remove.run(row.revision + 1, scope.accountId, scope.dataDomain, row.work_id);
          notify.run(scope.accountId, scope.dataDomain, ++sequence, 'work.removed', row.work_id, row.revision + 1,
            notificationTime, batch.watermark.hub_seq, batch.watermark.domain_seq);
        }
        if (healthChanged || changedSecondary || (noWorkChange && (coverageChanged || watermarkChanged))) {
          notify.run(scope.accountId, scope.dataDomain, ++sequence, 'projection.changed', null, null,
            notificationTime, batch.watermark.hub_seq, batch.watermark.domain_seq);
        }
        db.prepare(`INSERT INTO product_view_checkpoints
          (account_id,data_domain,epoch,hub_seq,domain_seq,notification_seq,notification_floor,observed_at,trusted_as_of,freshness,health_payload)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,data_domain) DO UPDATE SET
          hub_seq=excluded.hub_seq, domain_seq=excluded.domain_seq, notification_seq=excluded.notification_seq,
          observed_at=excluded.observed_at, trusted_as_of=excluded.trusted_as_of, freshness=excluded.freshness, health_payload=excluded.health_payload`)
          .run(scope.accountId, scope.dataDomain, prior.epoch, batch.watermark.hub_seq, batch.watermark.domain_seq,
            sequence, prior.notification_floor, batch.at, trustedTime, batch.coverage, healthPayload);
        return true;
      });
    },
    readList(scope: ProjectionScope, filters: WorkFilters): Snapshot<WorkList> {
      if (!Object.hasOwn(clauses, filters.state)) throw new Error('UNPROCESSABLE');
      const limit = filters.limit ?? PAGE_DEFAULT;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new Error('UNPROCESSABLE');
      const filter = createHash('sha256').update(JSON.stringify([filters.state, limit, 'updated_at:desc,work_id:asc'])).digest('hex');
      return withDeferredTransaction(db, () => {
        const cp = checkpoint(scope);
        const page = filters.cursor ? codec.readPage(filters.cursor, scope, window(cp), filter) : null;
        if (filters.cursor && !page) throw new Error('PROJECTION_RESET_REQUIRED');
        const rows = db.prepare(`SELECT payload, revision, updated_at, work_id FROM product_work_views
          WHERE account_id=? AND data_domain=? AND visible=1 ${clauses[filters.state]}
          ${page ? 'AND (updated_at < ? OR (updated_at = ? AND work_id > ?))' : ''}
          ORDER BY updated_at DESC, work_id LIMIT ?`).all(scope.accountId, scope.dataDomain,
            ...(page ? [page.sortKey, page.sortKey, page.workId] : []), limit + 1) as (WorkRow & { updated_at: string })[];
        const counts = db.prepare(`SELECT COUNT(*) FILTER (WHERE state <> 'delivered') AS open,
          COUNT(*) FILTER (WHERE state = 'awaiting_answer') AS awaiting_answer,
          COUNT(*) FILTER (WHERE state IN ('paused','blocked')) AS blocked
          FROM product_work_views WHERE account_id=? AND data_domain=? AND visible=1`).get(scope.accountId, scope.dataDomain) as WorkCounts;
        const items = rows.slice(0, limit).map(asItem);
        const last = rows[limit - 1];
        const next = rows.length > limit && last ? codec.page(scope, { epoch: cp.epoch, seq: cp.notification_seq,
          filter, sortKey: last.updated_at, workId: last.work_id }) : null;
        return envelope(scope, cp, { items, counts, next_cursor: next });
      });
    },
    readDetail(scope: ProjectionScope, workId: string): Snapshot<WorkItem> | null {
      return withDeferredTransaction(db, () => {
        const cp = checkpoint(scope);
        const row = db.prepare(`SELECT revision, payload FROM product_work_views
          WHERE account_id=? AND data_domain=? AND work_id=? AND visible=1`).get(scope.accountId, scope.dataDomain, workId) as WorkRow | undefined;
        return row ? envelope(scope, cp, asItem(row)) : null;
      });
    },
    readTimeline(scope: ProjectionScope, workId: string): Snapshot<{ items: TimelineItem[] }> | null {
      return withDeferredTransaction(db, () => {
        const cp = checkpoint(scope);
        const visible = db.prepare(`SELECT 1 FROM product_work_views
          WHERE account_id=? AND data_domain=? AND work_id=? AND visible=1`).get(scope.accountId, scope.dataDomain, workId);
        if (!visible) return null;
        const items = db.prepare(`WITH history AS (
          SELECT d.event_id,d.created_at AS at,d.seq,d.aggregate_version, json_extract(d.payload,'$.type') AS type,
            json_extract(d.payload,'$.intent_id') AS intent_id
          FROM domain_events d WHERE d.account_id=@account AND d.data_domain=@domain AND d.seq<=@watermark
            AND d.schema_version LIKE '1.%' AND (d.aggregate_id=@work OR json_extract(d.payload,'$.work_id')=@work)
        ) SELECT h.event_id,h.type,h.at FROM history h
          WHERE h.type IN ('work.requested','question.bound','answer.verified','evidence.ready','effect.uncertain','work.delivered','outcome.observed')
          AND (h.type <> 'work.delivered' OR EXISTS (
            SELECT 1 FROM effect_intents i JOIN effect_receipts r USING (intent_id)
            WHERE i.intent_id=h.intent_id AND i.account_id=@account AND i.data_domain=@domain
              AND i.work_id=@work AND i.generation=h.aggregate_version AND r.status='verified'
          )) ORDER BY h.seq DESC LIMIT @limit`).all({ account: scope.accountId, domain: scope.dataDomain,
          watermark: cp.domain_seq, work: workId, limit: PAGE_DEFAULT }) as TimelineItem[];
        return envelope(scope, cp, { items });
      });
    },
    readHealth(scope: ProjectionScope): Snapshot<HealthSnapshot> {
      return withDeferredTransaction(db, () => {
        const cp = checkpoint(scope);
        const facts = cp.health_payload ? JSON.parse(cp.health_payload) as ProjectionHealthFacts : null;
        return envelope(scope, cp, healthSummary(facts, cp.freshness, cp.trusted_as_of ?? cp.observed_at));
      });
    },
    eventsAfter(scope: ProjectionScope, cursor: string): Replay {
      return withDeferredTransaction(db, () => {
        const cp = checkpoint(scope);
        const after = codec.readStream(cursor, scope, window(cp));
        if (!after) return { status: 'reset_required' };
        const rows = db.prepare(`SELECT seq, kind, resource_id, resource_revision, as_of, hub_seq, domain_seq FROM product_view_events
          WHERE account_id=? AND data_domain=? AND seq>? ORDER BY seq LIMIT ?`).all(scope.accountId, scope.dataDomain, after.seq, PAGE_DEFAULT) as EventRow[];
        if (rows.some((row, index) => row.seq !== after.seq + index + 1)
          || (rows.length < PAGE_DEFAULT && after.seq + rows.length !== cp.notification_seq)) return { status: 'reset_required' };
        const namespace = createHash('sha256').update(JSON.stringify([scope.accountId, scope.dataDomain])).digest('hex');
        return { status: 'ok', events: rows.map((row) => ({
          id: codec.stream(scope, { epoch: cp.epoch, seq: row.seq }),
          event: { event_id: `projection:${namespace}:${cp.epoch}:${row.seq}`, type: row.kind, resource_id: row.resource_id,
            resource_revision: row.resource_revision, scope: scoped(scope), as_of: row.as_of,
            watermark: { hub_seq: row.hub_seq, domain_seq: row.domain_seq } },
        })) };
      });
    },
    archive(scope: ScopeKey, through: number): void {
      if (!Number.isSafeInteger(through) || through < 0) throw new Error('UNPROCESSABLE');
      withImmediateTransaction(db, () => {
        const cp = checkpoint(scope);
        const floor = Math.min(through, cp.notification_seq);
        if (floor <= cp.notification_floor) return;
        db.prepare('DELETE FROM product_view_events WHERE account_id=? AND data_domain=? AND seq<=?')
          .run(scope.accountId, scope.dataDomain, floor);
        db.prepare('UPDATE product_view_checkpoints SET notification_floor=? WHERE account_id=? AND data_domain=?')
          .run(floor, scope.accountId, scope.dataDomain);
      });
    },
    invalidateAfterRebuild(scope: ScopeKey): void {
      withImmediateTransaction(db, () => {
        db.prepare('DELETE FROM product_view_events WHERE account_id=? AND data_domain=?').run(scope.accountId, scope.dataDomain);
        db.prepare(`INSERT INTO product_view_checkpoints
          (account_id,data_domain,epoch,hub_seq,domain_seq,notification_seq,notification_floor,observed_at,trusted_as_of,freshness)
          VALUES (?,?,2,0,0,0,0,?,NULL,'syncing') ON CONFLICT(account_id,data_domain) DO UPDATE SET
          epoch=epoch+1, hub_seq=0, domain_seq=0, notification_floor=notification_seq, freshness='syncing'`)
          .run(scope.accountId, scope.dataDomain, epochStart);
      });
    },
  };
}

function asItem(row: Pick<WorkRow, 'payload' | 'revision'>): WorkItem {
  return { ...(JSON.parse(row.payload) as WorkFact), revision: row.revision };
}
