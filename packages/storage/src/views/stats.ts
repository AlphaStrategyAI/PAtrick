import type { Snapshot } from '@patrick/contracts';
import { withDeferredTransaction, withImmediateTransaction, type SqliteDatabase } from '../database.js';
import type { ProjectionScope } from './cursors.js';
import { prepareStatsFacts, type StatsScope, type FactKind } from './stats-source.js';
import { activityCoverage, prepareProducerCoverage, type MetricCoverage } from './stats-coverage.js';
import { statsWindow, type StatsPeriod } from './stats-window.js';

export type { StatsPeriod } from './stats-window.js';
type Watermark = Snapshot<never>['watermark'];
type Freshness = Snapshot<never>['freshness'];
type Counts = { open: number; awaiting_answer: number; blocked: number };
type Stock = { active_standards: number; knowledge_entries: number; delegation_types: number; active_delegation_types: number };
type Nullable<T> = { [K in keyof T]: T[K] | null };
type ProductCheckpoint = Watermark & { trusted_as_of: string | null; freshness: Freshness; epoch: number; notification_seq: number };
type Checkpoint = Watermark & Stock & {
  work_open: number; work_awaiting_answer: number; work_blocked: number;
  work_epoch: number; work_notification_seq: number; work_as_of: string; as_of: string;
  activity_proofs: string; refresh_after: string | null;
};
export type StatsSnapshot = {
  metric_definition_version: '1.0';
  window_start: string | null;
  window_end: string | null;
  timezone: string;
  coverage: MetricCoverage & { by_activity: Record<FactKind, MetricCoverage> };
  activity: Nullable<{ owner_decisions: number; automatic_decisions: number; delivered_work: number }>;
  stock: Nullable<Stock>;
  work: Nullable<Counts>;
};

const zeroWatermark: Watermark = { hub_seq: 0, domain_seq: 0 };
const nullStock = { active_standards: null, knowledge_entries: null, delegation_types: null, active_delegation_types: null };
const nullWork = { open: null, awaiting_answer: null, blocked: null };
const scopeArgs = (s: StatsScope) => [s.accountId, s.dataDomain] as const;
const sameWorkCheckpoint = (left: ProductCheckpoint | undefined, right: ProductCheckpoint) =>
  left?.freshness === right.freshness && left.hub_seq === right.hub_seq && left.domain_seq === right.domain_seq
    && left.epoch === right.epoch && left.notification_seq === right.notification_seq && left.trusted_as_of === right.trusted_as_of;
const localEpoch = '1970-01-01T00:00:00.000Z';
export const STATS_BATCH_LIMIT = 256;

export const countActivitySql = `SELECT COUNT(DISTINCT fact_key) AS count
  FROM stats_facts WHERE account_id=@account_id AND data_domain=@data_domain AND kind=@kind AND valid=1
  AND occurred_at>=@window_start AND occurred_at<@window_end AND occurred_at<=@as_of
  AND first_seq<=@domain_seq AND (invalidated_seq IS NULL OR invalidated_seq>@domain_seq)`;

export function createStatsProjection(db: SqliteDatabase) {
  const facts = prepareStatsFacts(db);
  const admitCoverage = prepareProducerCoverage(db);
  const workRow = db.prepare(`SELECT hub_seq,domain_seq,trusted_as_of,freshness,epoch,notification_seq
    FROM product_view_checkpoints WHERE account_id=? AND data_domain=?`);
  const readWork = (scope: StatsScope) => workRow.get(...scopeArgs(scope)) as ProductCheckpoint | undefined;
  const cursor = db.prepare('SELECT domain_seq,work_epoch FROM stats_input_cursors WHERE account_id=? AND data_domain=?');
  const inputState = (scope: StatsScope) => cursor.get(...scopeArgs(scope)) as { domain_seq: number; work_epoch: number } | undefined;
  const inputCursor = (scope: StatsScope) => inputState(scope)?.domain_seq ?? 0;
  const getStats = db.prepare('SELECT * FROM stats_checkpoints WHERE account_id=? AND data_domain=?');
  const readCheckpoint = (scope: StatsScope) => getStats.get(...scopeArgs(scope)) as Checkpoint | undefined;
  const currentLocal = db.prepare(`SELECT COALESCE((SELECT domain_seq FROM projection_cursors WHERE name='local'),0) AS observed,
    COALESCE(MAX(seq),0) AS required FROM domain_events`);
  const ledgerCurrent = (through: number) => {
    const { observed, required } = currentLocal.get() as { observed: number; required: number };
    return observed === through && required === through;
  };
  const countWork = db.prepare(`SELECT COUNT(*) FILTER (WHERE state<>'delivered') AS open,
    COUNT(*) FILTER (WHERE state='awaiting_answer') AS awaiting_answer, COUNT(*) FILTER (WHERE state IN ('paused','blocked')) AS blocked
    FROM product_work_views WHERE account_id=? AND data_domain=? AND visible=1`);
  const countStocks = db.prepare(`SELECT
    (SELECT COUNT(*) FROM standards s JOIN standard_versions v ON v.standard_id=s.standard_id AND v.version=s.active_version
      AND v.data_domain=s.data_domain AND v.status='active'
      WHERE s.account_id=@account_id AND s.data_domain=@data_domain AND s.active_version IS NOT NULL) AS active_standards,
    (SELECT COUNT(DISTINCT canonical_id) FROM knowledge_records
      WHERE account_id=@account_id AND data_domain=@data_domain AND status='available') AS knowledge_entries,
    (SELECT COUNT(DISTINCT type_id) FROM mandates WHERE account_id=@account_id AND data_domain=@data_domain) AS delegation_types,
    (SELECT COUNT(DISTINCT type_id) FROM mandates WHERE account_id=@account_id AND data_domain=@data_domain
      AND status='active' AND expires_at>@as_of) AS active_delegation_types`);
  const nextExpiry = db.prepare(`SELECT MIN(expires_at) AS expiry FROM mandates
    WHERE account_id=? AND data_domain=? AND status='active' AND expires_at>?`);
  const putFact = db.prepare(`INSERT INTO stats_facts (account_id,data_domain,kind,fact_key,first_seq,occurred_at,valid)
    VALUES (?,?,?,?,?,?,1) ON CONFLICT(account_id,data_domain,kind,fact_key) DO UPDATE SET
    first_seq=excluded.first_seq,occurred_at=excluded.occurred_at,valid=1 WHERE stats_facts.valid=0`);
  const invalidate = db.prepare(`INSERT INTO stats_facts
    (account_id,data_domain,kind,fact_key,first_seq,occurred_at,valid,invalidated_seq)
    VALUES (?,?,?,?,?, '1970-01-01T00:00:00.000Z',0,?) ON CONFLICT(account_id,data_domain,kind,fact_key)
    DO UPDATE SET invalidated_seq=excluded.invalidated_seq WHERE stats_facts.invalidated_seq IS NULL`);
  const putCursor = db.prepare(`INSERT INTO stats_input_cursors (account_id,data_domain,work_epoch,domain_seq) VALUES (?,?,?,?)
    ON CONFLICT(account_id,data_domain) DO UPDATE SET work_epoch=excluded.work_epoch,domain_seq=excluded.domain_seq`);
  const publish = db.prepare(`INSERT INTO stats_checkpoints (account_id,data_domain,hub_seq,domain_seq,work_epoch,work_notification_seq,work_as_of,as_of,refresh_after,
    activity_proofs,active_standards,knowledge_entries,delegation_types,active_delegation_types,work_open,work_awaiting_answer,work_blocked)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,data_domain) DO UPDATE SET
    hub_seq=excluded.hub_seq,domain_seq=excluded.domain_seq,work_epoch=excluded.work_epoch,work_notification_seq=excluded.work_notification_seq,
    work_as_of=excluded.work_as_of,as_of=excluded.as_of,refresh_after=excluded.refresh_after,
    activity_proofs=excluded.activity_proofs,active_standards=excluded.active_standards,
    knowledge_entries=excluded.knowledge_entries,delegation_types=excluded.delegation_types,
    active_delegation_types=excluded.active_delegation_types,work_open=excluded.work_open,
    work_awaiting_answer=excluded.work_awaiting_answer,work_blocked=excluded.work_blocked`);
  const activities = db.prepare(countActivitySql);

  /** Reads a bounded fact batch and stock totals before taking the writer lock. False means another sweep is required. */
  function refresh(scope: StatsScope, now: Date): boolean {
    const prepared = withDeferredTransaction(db, () => {
      const sourceVersion = db.pragma('data_version', { simple: true });
      const work = readWork(scope);
      if (work?.freshness !== 'fresh' || !work.trusted_as_of || work.trusted_as_of > now.toISOString()
          || !ledgerCurrent(work.domain_seq)) return null;
      const checkpoint = readCheckpoint(scope);
      const state = inputState(scope);
      const previous = state?.domain_seq ?? 0;
      if (previous > work.domain_seq || (checkpoint && checkpoint.work_epoch !== work.epoch)
          || (state && state.work_epoch !== work.epoch)) return { reset: true, sourceVersion, work, previous } as const;
      const page = facts(scope, previous, work.domain_seq, STATS_BATCH_LIMIT);
      const completed = page.cursor === work.domain_seq;
      const asOf = now.toISOString();
      const stock = completed ? countStocks.get({ account_id: scope.accountId, data_domain: scope.dataDomain, as_of: asOf }) as Stock : null;
      const counts = completed ? countWork.get(...scopeArgs(scope)) as Counts : null;
      const activityProofs = completed ? admitCoverage(scope, work, asOf) : '[]';
      const expires = completed ? (nextExpiry.get(...scopeArgs(scope), asOf) as { expiry: string | null }).expiry : null;
      return { reset: false, sourceVersion, work, previous, asOf, stock, counts, activityProofs, expires, page, checkpoint } as const;
    });
    // No fresh and complete T13 checkpoint to publish yet. A future source refresh will try again.
    if (!prepared) return true;
    const { sourceVersion, work, previous } = prepared;
    const canCommit = () => db.pragma('data_version', { simple: true }) === sourceVersion &&
      sameWorkCheckpoint(readWork(scope), work) && ledgerCurrent(work.domain_seq) && inputCursor(scope) === previous;
    if (prepared.reset) {
      withImmediateTransaction(db, () => { if (canCommit()) clearScope(scope); });
      return false;
    }
    const { asOf, stock, counts, activityProofs, expires, page, checkpoint } = prepared;
    if (stock && counts && page.cursor === previous && checkpoint && samePublished(checkpoint, work, stock, counts, activityProofs, expires)) return true;
    return withImmediateTransaction(db, () => {
      if (!canCommit()) return false;
      for (const mutation of page.mutations) {
        if (mutation.op === 'accept') putFact.run(...scopeArgs(scope), mutation.kind, mutation.key, mutation.seq, mutation.at);
        else invalidate.run(...scopeArgs(scope), mutation.kind, mutation.key, mutation.seq, mutation.seq);
      }
      if (page.cursor !== previous) putCursor.run(...scopeArgs(scope), work.epoch, page.cursor);
      if (stock && counts) {
        publish.run(...scopeArgs(scope), work.hub_seq, work.domain_seq, work.epoch, work.notification_seq, work.trusted_as_of, asOf, expires, activityProofs,
          stock.active_standards, stock.knowledge_entries, stock.delegation_types, stock.active_delegation_types,
          counts.open, counts.awaiting_answer, counts.blocked);
      }
      return page.cursor === work.domain_seq;
    });
  }

  function clearScope(scope: StatsScope): void {
    for (const table of ['stats_checkpoints', 'stats_facts', 'stats_input_cursors']) {
      db.prepare(`DELETE FROM ${table} WHERE account_id=? AND data_domain=?`).run(...scopeArgs(scope));
    }
  }

  return {
    refresh,
    needsRefresh(scope: StatsScope, now: Date): boolean {
      const snapshot = readCheckpoint(scope);
      return Boolean(snapshot?.refresh_after && snapshot.refresh_after <= now.toISOString() && readWork(scope)?.freshness === 'fresh');
    },
    /** Clear only this scope, then use normal bounded refresh to replay. Intended for the offline restore writer. */
    rebuild(scope: StatsScope, now: Date): void {
      withImmediateTransaction(db, () => clearScope(scope));
      while (!refresh(scope, now)) {
        // Stop if another writer changes the input between preparation and the commit.
        if (inputCursor(scope) === 0) break;
      }
    },
    readStats(scope: ProjectionScope, period: StatsPeriod, timezone: string, now: Date): Snapshot<StatsSnapshot> {
      return withDeferredTransaction(db, () => {
        const prior = readCheckpoint(scope);
        const work = readWork(scope);
        const checkpoint = prior?.work_epoch === work?.epoch ? prior : undefined;
        const asOf = checkpoint?.as_of ?? now.toISOString();
        const isCurrent = checkpoint && work?.freshness === 'fresh' && work.domain_seq === checkpoint.domain_seq
          && work.hub_seq === checkpoint.hub_seq && work.epoch === checkpoint.work_epoch
          && work.notification_seq === checkpoint.work_notification_seq && work.trusted_as_of === checkpoint.work_as_of
          && (!checkpoint.refresh_after || checkpoint.refresh_after > now.toISOString()) && ledgerCurrent(work.domain_seq);
        const { today_start: dayStart, ...window } = statsWindow(period, timezone, isCurrent ? now.toISOString() : asOf, asOf);
        // Open intervals end at observation time, not tomorrow's civil midnight. A live period that
        // has rolled into a new local day still needs a published observation on that day.
        const requiredThrough = dayStart > asOf ? dayStart : asOf;
        const freshness = !checkpoint ? 'unknown' : isCurrent ? 'fresh' : work?.freshness === 'stale' ? 'stale' : 'syncing';
        const { allStart, ...coverage } = activityCoverage(checkpoint?.activity_proofs ?? '[]', period, window.window_start, requiredThrough);
        const count = (kind: FactKind) => {
          const proof = coverage.by_activity[kind];
          if (!checkpoint || proof.status !== 'complete' || !proof.available_since || !proof.through) return null;
          return (activities.get({
            account_id: scope.accountId, data_domain: scope.dataDomain, kind,
            window_start: period === 'all' ? proof.available_since : window.window_start, window_end: window.window_end,
            as_of: asOf, domain_seq: checkpoint.domain_seq,
          }) as { count: number }).count;
        };
        return {
          schema_version: '1.0',
          scope: { account_id: scope.accountId, data_domain: scope.dataDomain, permission_epoch: scope.permissionEpoch },
          as_of: checkpoint ? asOf : localEpoch,
          watermark: checkpoint ? { hub_seq: checkpoint.hub_seq, domain_seq: checkpoint.domain_seq } : zeroWatermark,
          freshness,
          data: {
            metric_definition_version: '1.0', ...window,
            window_start: period === 'all' ? allStart : window.window_start,
            window_end: window.window_end,
            coverage,
            activity: { owner_decisions: count('owner_decision'), automatic_decisions: count('automatic_decision'),
              delivered_work: count('delivered_work') },
            stock: checkpoint
              ? { active_standards: checkpoint.active_standards, knowledge_entries: checkpoint.knowledge_entries,
                delegation_types: checkpoint.delegation_types, active_delegation_types: checkpoint.active_delegation_types }
              : nullStock,
            work: checkpoint
              ? { open: checkpoint.work_open, awaiting_answer: checkpoint.work_awaiting_answer, blocked: checkpoint.work_blocked }
              : nullWork,
          },
        };
      });
    },
  };
}

function samePublished(cp: Checkpoint, work: ProductCheckpoint, stock: Stock, counts: Counts, activityProofs: string, expires: string | null) {
  return cp.hub_seq === work.hub_seq && cp.domain_seq === work.domain_seq && cp.work_epoch === work.epoch
    && cp.work_notification_seq === work.notification_seq && cp.work_as_of === work.trusted_as_of
    && cp.activity_proofs === activityProofs && cp.refresh_after === expires
    && cp.active_standards === stock.active_standards && cp.knowledge_entries === stock.knowledge_entries
    && cp.delegation_types === stock.delegation_types && cp.active_delegation_types === stock.active_delegation_types
    && cp.work_open === counts.open && cp.work_awaiting_answer === counts.awaiting_answer && cp.work_blocked === counts.blocked;
}
