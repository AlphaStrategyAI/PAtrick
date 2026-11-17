import { dispatchAllowed, type AdmissionPrincipal, type RunGrant } from '../../domain/src/delegation.js';
import type { SqliteDatabase } from '../../storage/src/database.js';

export type ExecutorRuntime = Readonly<{
  db: SqliteDatabase;
  principal: AdmissionPrincipal;
  now: () => Date;
}>;

export function assertRunAdmission(runtime: ExecutorRuntime, grant: RunGrant): void {
  try {
    const { db, principal: suppliedPrincipal, now } = runtime;
    const nowIso = now().toISOString();
    const principal: AdmissionPrincipal = {
      ...suppliedPrincipal,
      domains: [...suppliedPrincipal.domains],
      operations: [...suppliedPrincipal.operations],
    };
    const account = db.prepare('SELECT auth_epoch FROM accounts WHERE account_id=?').get(principal.account_id) as {
      auth_epoch: number;
    } | undefined;
    const stored = db.prepare('SELECT * FROM execution_grants WHERE grant_id=?').get(grant.grant_id) as Record<string, unknown> | undefined;
    if (!account || account.auth_epoch !== principal.auth_epoch || !stored
      || stored.caller_id !== principal.caller_id || !matchesGrant(stored, grant)) throw new Error('DENIED');
    let businessId: string;
    if (grant.subject_kind === 'work') {
      const work = db.prepare(`SELECT data_domain,current_attempt_id,next_action,evidence_ready,collection_id FROM work_generations
        WHERE work_id=? AND generation=?`).get(grant.work_id, grant.generation) as {
        data_domain: string; current_attempt_id: string | null; next_action: string;
        evidence_ready: number; collection_id: string | null;
      } | undefined;
      if (!work || work.data_domain !== stored.data_domain || work.current_attempt_id !== grant.attempt_id
        || work.next_action !== grant.next_action) throw new Error('DENIED');
      if (grant.phase === 'delivery' && work.evidence_ready !== 1) throw new Error('DENIED');
      if (grant.phase === 'collect_evidence' && (!grant.collection_id || work.collection_id !== grant.collection_id)) {
        throw new Error('DENIED');
      }
      businessId = `work:${grant.work_id}`;
    } else if (grant.subject_kind === 'consultation') {
      if ((JSON.parse(String(stored.allowed_domains_json)) as string[])
        .some((domain) => !principal.domains.includes(domain))) throw new Error('DENIED');
      businessId = `consultation:${grant.request_id}`;
    } else {
      businessId = `maintenance:${grant.job_id}`;
    }
    if (dispatchAllowed(db, principal, nowIso, {
      grantId: grant.grant_id, attemptId: grant.attempt_id, businessId,
    })) return;
  } catch {
    throw new Error('EXECUTOR_ADMISSION_DENIED');
  }
  throw new Error('EXECUTOR_ADMISSION_DENIED');
}

function matchesGrant(stored: Record<string, unknown>, grant: RunGrant): boolean {
  const common = ['grant_id', 'subject_kind', 'attempt_id', 'expires_at'] as const;
  if (common.some((field) => stored[field] !== grant[field])
    || JSON.stringify(JSON.parse(String(stored.allowed_effects_json))) !== JSON.stringify(grant.allowed_effects)) return false;
  if (grant.subject_kind === 'work') {
    const fields = ['work_id', 'generation', 'mandate_id', 'next_action', 'basis_hash', 'phase', 'collection_id'] as const;
    return fields.every((field) => stored[field] === grant[field]);
  }
  if (grant.subject_kind === 'consultation') {
    const fields = ['request_id', 'result_version', 'caller_id', 'parent_work_id'] as const;
    return fields.every((field) => stored[field] === grant[field])
      && JSON.stringify(JSON.parse(String(stored.allowed_domains_json))) === JSON.stringify(grant.allowed_domains)
      && JSON.stringify(JSON.parse(String(stored.readonly_tools_json))) === JSON.stringify(grant.readonly_tools);
  }
  const fields = ['owner_id', 'job_id', 'kind', 'result_ref'] as const;
  return fields.every((field) => stored[field] === grant[field]);
}
