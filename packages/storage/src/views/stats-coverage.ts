import type { SqliteDatabase } from '../database.js';
import type { FactKind, StatsScope } from './stats-source.js';
import type { StatsPeriod } from './stats-window.js';

type CoverageState = 'complete' | 'partial' | 'unknown';
export type MetricCoverage = { status: CoverageState; available_since: string | null; through: string | null };
type Proof = { kind: FactKind; available_since: string; verified_through: string; complete_history: 0 | 1 };
type ProducerCheckpoint = { epoch: number; domain_seq: number; hub_seq: number; trusted_as_of: string | null };
const unknown: MetricCoverage = { status: 'unknown', available_since: null, through: null };

export function prepareProducerCoverage(db: SqliteDatabase) {
  const evidence = db.prepare(`SELECT kind,available_since,verified_through,complete_history
    FROM stats_producer_coverage WHERE account_id=? AND data_domain=? AND work_epoch=?
      AND domain_seq=? AND hub_seq=? ORDER BY kind`);
  return (scope: StatsScope, work: ProducerCheckpoint, asOf: string): string => {
    const proof = evidence.all(scope.accountId, scope.dataDomain, work.epoch, work.domain_seq, work.hub_seq) as Proof[];
    return JSON.stringify(proof.flatMap((item) => {
      if (!validInstant(item.available_since) || !validInstant(item.verified_through)
          || !work.trusted_as_of || item.verified_through < work.trusted_as_of
          || item.verified_through > asOf || item.available_since > item.verified_through) return [];
      return [item];
    }));
  };
}

function validInstant(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function activityCoverage(proofs: string, period: StatsPeriod, start: string, requiredThrough: string) {
  const known = JSON.parse(proofs) as Proof[];
  function metric(kind: FactKind): MetricCoverage {
    const proof = known.find((entry) => entry.kind === kind);
    if (!proof) return unknown;
    const coversStart = period === 'all' ? proof.complete_history === 1 : proof.available_since <= start;
    const complete = coversStart && proof.verified_through >= requiredThrough;
    return { status: complete ? 'complete' : 'partial', available_since: proof.available_since, through: proof.verified_through };
  }
  const by_activity = {
    owner_decision: metric('owner_decision'),
    automatic_decision: metric('automatic_decision'),
    delivered_work: metric('delivered_work'),
  };
  const entries = Object.values(by_activity);
  const status: CoverageState = entries.every((entry) => entry.status === 'complete') ? 'complete'
    : entries.some((entry) => entry.status !== 'unknown') ? 'partial' : 'unknown';
  const earliest = (values: string[]) => values.sort()[0] ?? null;
  return {
    status,
    available_since: earliest(known.map((entry) => entry.available_since)),
    through: earliest(known.map((entry) => entry.verified_through)),
    by_activity,
    allStart: earliest(known.filter((entry) => entry.complete_history === 1).map((entry) => entry.available_since)),
  };
}
