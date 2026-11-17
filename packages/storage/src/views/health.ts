import type { Snapshot } from '@patrick/contracts';
import type { SqliteDatabase } from '../database.js';
import type { ProjectionScope } from './cursors.js';

type Connection = { status: string; revision: number; epoch: number };
export type ProjectionHealthFacts = {
  connections: { vault: Connection | null; feishu: Connection | null };
  edits: { pending: number; failed: number };
};
export type HealthSnapshot = {
  service: 'running' | 'unknown';
  freshness: 'fresh' | 'stale' | 'unknown';
  impact: string;
  next_step: string | null;
  as_of: string;
} & Partial<ProjectionHealthFacts>;

export function collectHealthFacts(db: SqliteDatabase, scope: Pick<ProjectionScope, 'accountId' | 'dataDomain'>): ProjectionHealthFacts {
  const target = [scope.accountId, scope.dataDomain];
  const vault = db.prepare(`SELECT status,config_revision AS revision,connection_epoch AS epoch FROM vaults
    WHERE account_id=? AND data_domain=?`).get(...target) as Connection | undefined;
  const feishu = db.prepare(`SELECT status,config_revision AS revision,connection_epoch AS epoch FROM channel_connections
    WHERE account_id=? AND data_domain=? ORDER BY updated_at DESC,connection_id LIMIT 1`).get(...target) as Connection | undefined;
  const edits = db.prepare(`SELECT COUNT(*) FILTER (WHERE r.projection_state IN ('pending','cleanup_pending')
      OR r.business_state IN ('pending','verifying','evaluating')) AS pending,
    COUNT(*) FILTER (WHERE r.projection_state='failed' OR r.file_state IN ('conflict','invalid')) AS failed
    FROM edit_intents i JOIN edit_receipts r ON r.edit_id=i.edit_id AND r.receipt_revision=(
      SELECT MAX(x.receipt_revision) FROM edit_receipts x WHERE x.edit_id=i.edit_id
    ) WHERE i.account_id=? AND i.data_domain=?`).get(...target) as ProjectionHealthFacts['edits'];
  return { connections: { vault: vault ?? null, feishu: feishu ?? null }, edits };
}

export function healthSummary(facts: ProjectionHealthFacts | null, coverage: Snapshot<never>['freshness'], asOf: string): HealthSnapshot {
  const freshness = coverage === 'fresh' && facts ? 'fresh' : coverage === 'stale' ? 'stale' : 'unknown';
  const impact = coverage === 'syncing' ? 'projection_syncing' : freshness === 'stale' ? 'projection_stale'
    : freshness === 'unknown' ? 'projection_unobserved' : facts?.connections.vault?.status === 'needs_permission' ? 'vault_needs_permission'
      : facts?.connections.vault?.status === 'degraded' ? 'vault_degraded' : facts?.connections.feishu?.status === 'degraded' ? 'feishu_degraded'
        : facts && facts.edits.failed > 0 ? 'edit_requires_attention' : 'projection_current';
  return { service: freshness === 'fresh' ? 'running' : 'unknown', freshness, impact,
    next_step: impact === 'projection_current' ? null : 'check_system', as_of: asOf, ...(facts ?? {}) };
}
