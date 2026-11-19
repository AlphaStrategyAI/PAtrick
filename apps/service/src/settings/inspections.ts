import { arch, platform } from 'node:os';
import { probeExecutorReadiness } from '@patrick/executor/readiness';
import type { SqliteDatabase } from '@patrick/storage';
import type { Principal } from '../auth.js';

export type InspectionRecord = { target: string; observed: string };

export type InspectionOptions = {
  db: SqliteDatabase;
  principal: Principal;
  domain: string;
  networkTargets?: (principal: Principal, domain: string) => readonly unknown[];
  recoveryTargets?: (principal: Principal, domain: string, operation: string) => readonly unknown[];
  executorProbes?: typeof probeExecutorReadiness;
};

/** Runs the checks the Settings and System pages show, and records what was seen.
 *
 * Every record names the thing that was inspected and what the service actually
 * observed. A check that could not run says so; it never reports a ready state
 * it did not verify.
 */
export async function runSettingsInspections(options: InspectionOptions): Promise<{ records: InspectionRecord[] }> {
  const records: InspectionRecord[] = [];
  records.push({
    target: 'host',
    observed: `${platform()}-${arch()} node ${process.version} uid ${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}`,
  });

  const executors = options.executorProbes ?? probeExecutorReadiness;
  for (const readiness of await executors()) {
    records.push({
      target: `executor:${readiness.backend}`,
      observed: readiness.status === 'verified'
        ? `ready ${readiness.version ?? ''}`.trim()
        : `blocked ${readiness.reason ?? 'unknown'}`,
    });
  }

  const network = options.networkTargets?.(options.principal, options.domain) ?? [];
  records.push({ target: 'network', observed: network.length ? `${network.length} registered target(s)` : 'no registered target' });

  const backup = options.recoveryTargets?.(options.principal, options.domain, 'start_backup') ?? [];
  const restore = options.recoveryTargets?.(options.principal, options.domain, 'start_restore') ?? [];
  records.push({
    target: 'backup',
    observed: `${backup.length} backup target(s), ${restore.length} restore target(s)`,
  });

  const sources = options.db.prepare(`SELECT status, COUNT(*) AS n FROM source_configs
    WHERE account_id=? AND data_domain=? GROUP BY status`).all(options.principal.account_id, options.domain) as
    Array<{ status: string; n: number }>;
  records.push({
    target: 'sources',
    observed: sources.length
      ? sources.map((row) => `${row.status} ${row.n}`).join(', ')
      : 'no source configured',
  });

  const recovery = options.db.prepare(`SELECT COUNT(*) AS n FROM recovery_domain_gates
    WHERE data_domain=? AND status<>'open'`).get(options.domain) as { n: number };
  records.push({ target: 'recovery', observed: recovery.n ? `${recovery.n} domain(s) closed` : 'no domain closed' });

  return { records };
}
