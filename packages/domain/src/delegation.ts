import { createHash, randomUUID } from 'node:crypto';
import { canonicalPayload } from '@patrick/contracts';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { createStandardsApi, type JudgmentBasis } from './standards.js';

export type AdmissionPrincipal = {
  account_id: string;
  caller_id: string;
  auth_epoch: number;
  domains: readonly string[];
  operations: readonly string[];
};

export type AdmissionOptions = {
  now?: () => Date;
  domain: string;
};

export type Level = 'L0' | 'L1' | 'L2' | 'L3';
export type WorkPhase = 'judgment' | 'collect_evidence' | 'delivery';
export type MaintenanceKind = 'standard_evaluation' | 'ui_translation';

export type MandateTypeInput = {
  type_id: string;
  actions: string[];
  resources: string[];
  effects: string[];
  domains: string[];
  risk: string;
  level: Level;
  budget_micros: number;
  config_version: number;
};

export type MandateInput = Omit<MandateTypeInput, 'config_version'> & {
  mandate_id: string;
  expires_at: string;
};

export type CapabilityInput = {
  profile_id: string;
  level: Level;
  actions: string[];
  report_id: string;
  report_version: number;
  config_version: number;
};

export type WorkInput = {
  work_id: string;
  generation: number;
  mandate_id: string;
  phase: WorkPhase;
  next_action: string;
  budget_micros: number;
};

export type WorkGate = {
  phase?: WorkPhase;
  awaiting_answer?: boolean;
  evidence_ready?: boolean;
  collection_id?: string | null;
};

export type ConsultationInput = {
  request_id: string;
  caller_id: string;
  parent_work_id: string | null;
  result_version: number;
  domains: string[];
  tools: string[];
  deadline_at: string;
  budget_micros: number;
  permission_revision: number;
};

export type MaintenanceInput = {
  job_id: string;
  owner_id: string;
  kind: string;
  budget_micros: number;
  result_ref: string;
  expires_at: string;
};

export type ActionRequest = {
  work_id: string;
  generation: number;
  attempt_id: string;
  phase: WorkPhase;
  next_action: string;
  allowed_effects: string[];
  collection_id?: string | null;
  expires_at: string;
};

export type ExecutionGrant = {
  grant_id: string;
  subject_kind: 'work';
  work_id: string;
  generation: number;
  attempt_id: string;
  mandate_id: string;
  next_action: string;
  allowed_effects: string[];
  basis_hash: string;
  phase: WorkPhase;
  collection_id: string | null;
  expires_at: string;
};

export type ConsultationGrant = {
  grant_id: string;
  subject_kind: 'consultation';
  request_id: string;
  result_version: number;
  caller_id: string;
  parent_work_id: string | null;
  allowed_domains: string[];
  readonly_tools: string[];
  allowed_effects: readonly [];
  attempt_id: string;
  expires_at: string;
};

export type MaintenanceGrant = {
  grant_id: string;
  subject_kind: 'maintenance';
  owner_id: string;
  job_id: string;
  kind: MaintenanceKind;
  attempt_id: string;
  allowed_effects: readonly [];
  result_ref: string;
  expires_at: string;
};

export type RunGrant = ExecutionGrant | ConsultationGrant | MaintenanceGrant;

export type WorkEffectRequest = {
  work_id: string;
  generation: number;
  action: string;
};

export type DelegationView = {
  mandate_id: string;
  type_id: string;
  status: 'active' | 'paused' | 'stopped';
  level: Level;
  budget_micros: number;
  actions: string[];
  effects: string[];
  domains: string[];
  risk: string;
  expires_at: string;
  revision: number;
};

type GrantRow = {
  grant_id: string;
  subject_kind: 'work' | 'consultation' | 'maintenance';
  account_id: string;
  data_domain: string;
  work_id: string | null;
  generation: number | null;
  request_id: string | null;
  parent_work_id: string | null;
  result_version: number | null;
  job_id: string | null;
  owner_id: string | null;
  caller_id: string;
  attempt_id: string;
  mandate_id: string | null;
  next_action: string;
  allowed_effects_json: string;
  allowed_domains_json: string;
  readonly_tools_json: string;
  basis_hash: string | null;
  phase: WorkPhase | null;
  collection_id: string | null;
  scope_hash: string | null;
  permission_revision: number;
  kind: MaintenanceKind | null;
  result_ref: string | null;
  expires_at: string;
  revoked_at: string | null;
};

type WorkRow = {
  work_id: string;
  generation: number;
  account_id: string;
  data_domain: string;
  mandate_id: string;
  phase: WorkPhase;
  next_action: string;
  awaiting_answer: number;
  evidence_ready: number;
  collection_id: string | null;
  control_state: 'running' | 'paused' | 'processing' | 'stopped';
  process_tree_stopped: number;
  effects_reconciled: number;
  attempt_closed: number;
  current_attempt_id: string | null;
  revision: number;
};

type MandateRow = {
  mandate_id: string;
  type_id: string;
  account_id: string;
  data_domain: string;
  status: 'active' | 'paused' | 'stopped';
  actions_json: string;
  resources_json: string;
  effects_json: string;
  domains_json: string;
  risk: string;
  level: Level;
  budget_micros: number;
  expires_at: string;
  revision: number;
  scope_hash: string;
  config_version: number;
};

type CapabilityRow = {
  profile_id: string;
  account_id: string;
  data_domain: string;
  level: Level;
  actions_json: string;
  report_id: string;
  report_version: number;
};

const LEVELS: Level[] = ['L0', 'L1', 'L2', 'L3'];
const MAINTENANCE_KINDS = new Set<MaintenanceKind>(['standard_evaluation', 'ui_translation']);

export function createDelegationApi(db: SqliteDatabase, principal: AdmissionPrincipal, options: AdmissionOptions) {
  const now = options.now ?? (() => new Date());
  const domain = options.domain;
  const standards = createStandardsApi(db, principal, { now, domain });

  function stamp(): string {
    return now().toISOString();
  }

  function assertDomain(): void {
    if (!principal.domains.includes(domain)) throw new Error('FORBIDDEN');
  }

  return {
    async registerMandateType(input: MandateTypeInput): Promise<void> {
      assertDomain();
      assertMicros(input.budget_micros);
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const existing = db.prepare('SELECT * FROM mandate_types WHERE type_id = ?').get(input.type_id) as {
          account_id: string;
          data_domain: string;
          actions_json: string;
          resources_json: string;
          effects_json: string;
          domains_json: string;
          risk: string;
          level: Level;
          budget_micros: number;
          config_version: number;
        } | undefined;
        if (existing) {
          if (existing.account_id !== principal.account_id || existing.data_domain !== domain) throw new Error('CONFLICT');
          return;
        }
        db.prepare(`INSERT INTO mandate_types (
          type_id, account_id, data_domain, actions_json, resources_json, effects_json, domains_json, risk, level,
          budget_micros, config_version, schema_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0', ?)`).run(
          input.type_id,
          principal.account_id,
          domain,
          JSON.stringify(input.actions),
          JSON.stringify(input.resources),
          JSON.stringify(input.effects),
          JSON.stringify(input.domains),
          input.risk,
          input.level,
          input.budget_micros,
          input.config_version,
          stamped,
        );
      });
    },

    async openMandate(input: MandateInput): Promise<DelegationView> {
      assertDomain();
      assertMicros(input.budget_micros);
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const type = requireType(db, principal, domain, input.type_id);
        assertInsideType(input, type);
        if (input.expires_at <= stamped) throw new Error('UNPROCESSABLE');
        const scope = scopeHash(input);
        const existing = db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(input.mandate_id) as MandateRow | undefined;
        if (existing) {
          if (existing.account_id !== principal.account_id || existing.scope_hash !== scope) throw new Error('CONFLICT');
          return viewMandate(existing);
        }
        db.prepare(`INSERT INTO mandates (
          mandate_id, type_id, account_id, data_domain, status, actions_json, resources_json, effects_json, domains_json,
          risk, level, budget_micros, expires_at, revision, scope_hash, config_version, schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '1.0', ?, ?)`).run(
          input.mandate_id,
          input.type_id,
          principal.account_id,
          domain,
          JSON.stringify(input.actions),
          JSON.stringify(input.resources),
          JSON.stringify(input.effects),
          JSON.stringify(input.domains),
          input.risk,
          input.level,
          input.budget_micros,
          input.expires_at,
          scope,
          type.config_version,
          stamped,
          stamped,
        );
        const stored = requireMandate(db, input.mandate_id);
        return viewMandate(stored);
      });
    },

    async setCapability(input: CapabilityInput): Promise<void> {
      assertDomain();
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const current = db.prepare('SELECT profile_id FROM capability_profiles WHERE account_id = ? AND data_domain = ?').get(
          principal.account_id,
          domain,
        ) as { profile_id: string } | undefined;
        if (current && current.profile_id !== input.profile_id) {
          db.prepare('DELETE FROM capability_profiles WHERE profile_id = ?').run(current.profile_id);
        }
        db.prepare(`INSERT INTO capability_profiles (
          profile_id, account_id, data_domain, level, actions_json, report_id, report_version, config_version,
          schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1.0', ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
          level = excluded.level,
          actions_json = excluded.actions_json,
          report_id = excluded.report_id,
          report_version = excluded.report_version,
          config_version = excluded.config_version,
          updated_at = excluded.updated_at`).run(
          input.profile_id,
          principal.account_id,
          domain,
          input.level,
          JSON.stringify(input.actions),
          input.report_id,
          input.report_version,
          input.config_version,
          stamped,
          stamped,
        );
      });
    },

    async ensureJudgmentPolicy(): Promise<void> {
      assertDomain();
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const existing = db.prepare('SELECT policy_id FROM evaluation_policies WHERE data_domain = ? LIMIT 1').get(domain);
        if (existing) return;
        db.prepare(`INSERT INTO evaluation_policies (
          policy_id, policy_version, data_domain, dataset_id, min_samples, threshold_thousandths, budget_micros,
          external_method_id, external_method_revision, external_rules_json, schema_version, created_at
        ) VALUES ('policy-external', 1, ?, 'dataset-external', 1, 0, 0, 'method-demand-interview', '2026.1', ?, '1.0', ?)`).run(
          domain,
          JSON.stringify([{ when: [], unless: [], choice: 'interview' }]),
          stamped,
        );
      });
    },

    async openWork(input: WorkInput): Promise<void> {
      assertDomain();
      assertMicros(input.budget_micros);
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const mandate = requireMandate(db, input.mandate_id);
        if (mandate.account_id !== principal.account_id || mandate.data_domain !== domain) throw new Error('FORBIDDEN');
        if (input.budget_micros > mandate.budget_micros) throw new Error('UNPROCESSABLE');
        const existing = loadWork(db, input.work_id, input.generation);
        if (!existing) {
          db.prepare(`INSERT INTO work_generations (
            work_id, generation, account_id, data_domain, root_id, mandate_id, phase, next_action,
            awaiting_answer, evidence_ready, collection_id, control_state, process_tree_stopped, effects_reconciled,
            attempt_closed, current_attempt_id, revision, schema_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 'running', 0, 0, 0, NULL, 0, '1.0', ?, ?)`).run(
            input.work_id,
            input.generation,
            principal.account_id,
            domain,
            input.work_id,
            input.mandate_id,
            input.phase,
            input.next_action,
            stamped,
            stamped,
          );
        }
        db.prepare(`INSERT INTO business_budgets (
          business_id, account_id, data_domain, subject_kind, limit_micros, held_micros, spent_micros,
          schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, 'work', ?, 0, 0, '1.0', ?, ?)
        ON CONFLICT(business_id) DO NOTHING`).run(
          `work:${input.work_id}`,
          principal.account_id,
          domain,
          input.budget_micros,
          stamped,
          stamped,
        );
      });
    },

    async setWorkGate(workId: string, generation: number, gate: WorkGate): Promise<void> {
      assertDomain();
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const work = requireVisibleWork(db, principal, workId, generation);
        db.prepare(`UPDATE work_generations SET
          phase = ?, next_action = ?, awaiting_answer = ?, evidence_ready = ?, collection_id = ?, updated_at = ?
          WHERE work_id = ? AND generation = ?`).run(
          gate.phase ?? work.phase,
          gate.phase === 'collect_evidence' && gate.collection_id ? `collect:${gate.collection_id}` : work.next_action,
          gate.awaiting_answer === undefined ? work.awaiting_answer : gate.awaiting_answer ? 1 : 0,
          gate.evidence_ready === undefined ? work.evidence_ready : gate.evidence_ready ? 1 : 0,
          gate.collection_id === undefined ? work.collection_id : gate.collection_id,
          stamped,
          workId,
          generation,
        );
      });
    },

    async noteAttemptFinished(workId: string, generation: number): Promise<void> {
      assertDomain();
      withImmediateTransaction(db, () => {
        requireVisibleWork(db, principal, workId, generation);
        db.prepare('UPDATE work_generations SET attempt_closed = 1, updated_at = ? WHERE work_id = ? AND generation = ?').run(
          stamp(),
          workId,
          generation,
        );
      });
    },

    async openConsultation(input: ConsultationInput): Promise<void> {
      assertDomain();
      assertMicros(input.budget_micros);
      if (!input.domains.includes(domain) || input.domains.some((item) => !principal.domains.includes(item))) throw new Error('FORBIDDEN');
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        db.prepare(`INSERT INTO consultations (
          request_id, account_id, caller_id, data_domain, parent_work_id, result_version, status, domains_json, tools_json,
          deadline_at, budget_micros, permission_revision, cancelled_at, schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, '1.0', ?, ?)`).run(
          input.request_id,
          principal.account_id,
          input.caller_id,
          domain,
          input.parent_work_id,
          input.result_version,
          JSON.stringify(input.domains),
          JSON.stringify(input.tools),
          input.deadline_at,
          input.budget_micros,
          input.permission_revision,
          stamped,
          stamped,
        );
        db.prepare(`INSERT INTO business_budgets (
          business_id, account_id, data_domain, subject_kind, limit_micros, held_micros, spent_micros,
          schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, 'consultation', ?, 0, 0, '1.0', ?, ?)`).run(
          `consultation:${input.request_id}`,
          principal.account_id,
          domain,
          input.budget_micros,
          stamped,
          stamped,
        );
      });
    },

    async setConsultationPermission(requestId: string, permissionRevision: number): Promise<void> {
      assertDomain();
      withImmediateTransaction(db, () => {
        const info = db.prepare(`UPDATE consultations SET permission_revision = ?, updated_at = ?
          WHERE request_id = ? AND account_id = ? AND data_domain = ?`).run(
          permissionRevision,
          stamp(),
          requestId,
          principal.account_id,
          domain,
        );
        if (info.changes !== 1) throw new Error('NOT_FOUND');
      });
    },

    async cancelConsultation(requestId: string): Promise<void> {
      assertDomain();
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const info = db.prepare(`UPDATE consultations SET status = 'cancelled', cancelled_at = ?, updated_at = ?
          WHERE request_id = ? AND account_id = ? AND data_domain = ? AND status = 'pending'`).run(
          stamped,
          stamped,
          requestId,
          principal.account_id,
          domain,
        );
        if (info.changes !== 1) throw new Error('CONFLICT');
      });
    },

    async openMaintenance(input: MaintenanceInput): Promise<void> {
      assertDomain();
      assertMicros(input.budget_micros);
      if (!isMaintenanceKind(input.kind)) throw new Error('UNPROCESSABLE');
      if (input.owner_id !== principal.account_id) throw new Error('FORBIDDEN');
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        db.prepare(`INSERT INTO maintenance_jobs (
          job_id, owner_id, account_id, data_domain, kind, status, budget_micros, result_ref, expires_at, cancelled_at,
          schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, '1.0', ?, ?)`).run(
          input.job_id,
          input.owner_id,
          principal.account_id,
          domain,
          input.kind,
          input.budget_micros,
          input.result_ref,
          input.expires_at,
          stamped,
          stamped,
        );
        db.prepare(`INSERT INTO business_budgets (
          business_id, account_id, data_domain, subject_kind, limit_micros, held_micros, spent_micros,
          schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, 'maintenance', ?, 0, 0, '1.0', ?, ?)`).run(
          `maintenance:${input.job_id}`,
          principal.account_id,
          domain,
          input.budget_micros,
          stamped,
          stamped,
        );
      });
    },

    async cancelMaintenance(jobId: string): Promise<void> {
      assertDomain();
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const info = db.prepare(`UPDATE maintenance_jobs SET status = 'cancelled', cancelled_at = ?, updated_at = ?
          WHERE job_id = ? AND account_id = ? AND data_domain = ? AND status = 'open'`).run(
          stamped,
          stamped,
          jobId,
          principal.account_id,
          domain,
        );
        if (info.changes !== 1) throw new Error('CONFLICT');
      });
    },

    async authorizeAction(request: ActionRequest): Promise<ExecutionGrant> {
      assertDomain();
      requireVisibleWork(db, principal, request.work_id, request.generation);
      const basis = await standards.freezeJudgmentBasis(request.work_id, request.generation);
      return withImmediateTransaction(db, () => issueWorkGrant(db, principal, domain, stamp(), request, basis));
    },

    async authorizeConsultation(requestId: string, attemptId: string): Promise<ConsultationGrant> {
      assertDomain();
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const row = loadConsultation(db, requestId);
        if (!row || row.account_id !== principal.account_id || row.data_domain !== domain) throw new Error('NOT_FOUND');
        if (row.caller_id !== principal.caller_id) throw new Error('FORBIDDEN');
        if (row.status !== 'pending' || row.cancelled_at || row.deadline_at <= stamped) throw new Error('DENIED');
        const existing = activeConsultationGrant(db, requestId);
        if (existing) {
          if (existing.attempt_id === attemptId && existing.permission_revision === row.permission_revision && existing.result_version === row.result_version) {
            return mapConsultation(existing);
          }
          throw new Error('DENIED');
        }
        const grantId = `grant_${randomUUID()}`;
        db.prepare(`INSERT INTO execution_grants (
          grant_id, subject_kind, account_id, data_domain, work_id, generation, request_id, parent_work_id, result_version,
          job_id, owner_id, caller_id, attempt_id, mandate_id, next_action, allowed_effects_json, allowed_domains_json,
          readonly_tools_json, basis_hash, phase, collection_id, scope_hash, permission_revision, kind, result_ref,
          expires_at, revoked_at, schema_version, created_at
        ) VALUES (
          ?, 'consultation', ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?, NULL, 'consult', '[]', ?, ?, NULL, NULL, NULL, NULL,
          ?, NULL, NULL, ?, NULL, '1.0', ?
        )`).run(
          grantId,
          principal.account_id,
          domain,
          requestId,
          row.parent_work_id,
          row.result_version,
          row.caller_id,
          attemptId,
          row.domains_json,
          row.tools_json,
          row.permission_revision,
          row.deadline_at,
          stamped,
        );
        const stored = requireGrant(db, grantId);
        return mapConsultation(stored);
      });
    },

    async authorizeMaintenance(ownerId: string, jobId: string, attemptId: string): Promise<MaintenanceGrant> {
      assertDomain();
      if (ownerId !== principal.account_id) throw new Error('FORBIDDEN');
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const job = db.prepare('SELECT * FROM maintenance_jobs WHERE job_id = ?').get(jobId) as {
          owner_id: string;
          account_id: string;
          data_domain: string;
          kind: string;
          status: string;
          result_ref: string;
          expires_at: string;
          cancelled_at: string | null;
        } | undefined;
        if (!job || job.account_id !== principal.account_id || job.data_domain !== domain) throw new Error('NOT_FOUND');
        if (job.owner_id !== ownerId) throw new Error('FORBIDDEN');
        if (!isMaintenanceKind(job.kind)) throw new Error('UNPROCESSABLE');
        if (job.status !== 'open' || job.cancelled_at || job.expires_at <= stamped) throw new Error('DENIED');
        const existing = db.prepare(`SELECT * FROM execution_grants
          WHERE subject_kind = 'maintenance' AND job_id = ? AND revoked_at IS NULL`).get(jobId) as GrantRow | undefined;
        if (existing) {
          if (existing.attempt_id === attemptId) return mapMaintenance(existing);
          throw new Error('DENIED');
        }
        const grantId = `grant_${randomUUID()}`;
        db.prepare(`INSERT INTO execution_grants (
          grant_id, subject_kind, account_id, data_domain, work_id, generation, request_id, parent_work_id, result_version,
          job_id, owner_id, caller_id, attempt_id, mandate_id, next_action, allowed_effects_json, allowed_domains_json,
          readonly_tools_json, basis_hash, phase, collection_id, scope_hash, permission_revision, kind, result_ref,
          expires_at, revoked_at, schema_version, created_at
        ) VALUES (
          ?, 'maintenance', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', NULL, NULL, NULL, NULL,
          0, ?, ?, ?, NULL, '1.0', ?
        )`).run(
          grantId,
          principal.account_id,
          domain,
          jobId,
          ownerId,
          principal.caller_id,
          attemptId,
          job.kind,
          job.kind,
          job.result_ref,
          job.expires_at,
          stamped,
        );
        return mapMaintenance(requireGrant(db, grantId));
      });
    },

    async authorizeBusinessEffect(grant: RunGrant, request: WorkEffectRequest): Promise<boolean> {
      if (grant.subject_kind !== 'work') return false;
      if (grant.work_id !== request.work_id || grant.generation !== request.generation) return false;
      if (!grant.allowed_effects.includes(request.action)) return false;
      return dispatchAllowed(db, principal, stamp(), {
        grantId: grant.grant_id,
        attemptId: grant.attempt_id,
        businessId: `work:${grant.work_id}`,
      });
    },

    canWriteConsultationAnswer(grant: RunGrant, requestId: string): boolean {
      return grant.subject_kind === 'consultation' && grant.request_id === requestId && grant.allowed_effects.length === 0;
    },

    async revokeGrant(grantId: string): Promise<void> {
      assertDomain();
      withImmediateTransaction(db, () => {
        const info = db.prepare(`UPDATE execution_grants SET revoked_at = ?
          WHERE grant_id = ? AND account_id = ? AND revoked_at IS NULL`).run(stamp(), grantId, principal.account_id);
        if (info.changes !== 1) throw new Error('NOT_FOUND');
      });
    },

    async pauseMandate(mandateId: string, expectedRevision?: number): Promise<DelegationView> {
      return changeMandate(db, principal, domain, stamp(), mandateId, 'pause', expectedRevision);
    },

    async resumeMandate(mandateId: string, expectedRevision?: number): Promise<DelegationView> {
      return changeMandate(db, principal, domain, stamp(), mandateId, 'resume', expectedRevision);
    },

    async stopMandate(mandateId: string, expectedRevision?: number): Promise<DelegationView> {
      return changeMandate(db, principal, domain, stamp(), mandateId, 'stop', expectedRevision);
    },

    async activeGrantCount(workId: string, generation: number): Promise<number> {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM execution_grants
        WHERE subject_kind = 'work' AND work_id = ? AND generation = ? AND revoked_at IS NULL`).get(workId, generation) as { n: number };
      return row.n;
    },

    async activeWorkGrant(workId: string, generation: number): Promise<ExecutionGrant | null> {
      const row = activeWorkGrant(db, workId, generation);
      return row ? mapWork(row) : null;
    },

    async listDelegations(): Promise<DelegationView[]> {
      const rows = db.prepare(`SELECT * FROM mandates WHERE account_id = ? ORDER BY mandate_id`).all(principal.account_id) as MandateRow[];
      return rows.filter((row) => principal.domains.includes(row.data_domain)).map(viewMandate);
    },

    async getDelegation(mandateId: string): Promise<DelegationView> {
      const row = db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(mandateId) as MandateRow | undefined;
      if (!row || row.account_id !== principal.account_id || !principal.domains.includes(row.data_domain)) throw new Error('NOT_FOUND');
      return viewMandate(row);
    },
  };
}

export function dispatchAllowed(
  db: SqliteDatabase,
  principal: AdmissionPrincipal,
  nowIso: string,
  input: { grantId: string; attemptId: string; businessId: string },
): boolean {
  const grant = db.prepare('SELECT * FROM execution_grants WHERE grant_id = ?').get(input.grantId) as GrantRow | undefined;
  if (!grant || grant.account_id !== principal.account_id || !principal.domains.includes(grant.data_domain)) return false;
  if (grant.revoked_at || grant.expires_at <= nowIso || grant.attempt_id !== input.attemptId) return false;
  if (businessOf(grant) !== input.businessId) return false;
  if (grant.subject_kind === 'work') return workStillDispatchable(db, principal, nowIso, grant);
  if (grant.subject_kind === 'consultation') return consultationStillDispatchable(db, nowIso, grant);
  return maintenanceStillDispatchable(db, principal, nowIso, grant);
}

export function workResumeAllowed(
  db: SqliteDatabase,
  principal: AdmissionPrincipal,
  nowIso: string,
  workId: string,
  generation: number,
): boolean {
  const work = loadWork(db, workId, generation);
  if (!work || work.account_id !== principal.account_id || !principal.domains.includes(work.data_domain)) return false;
  const grant = activeWorkGrant(db, workId, generation);
  if (!grant) return false;
  return workStillDispatchable(db, principal, nowIso, grant, { ignoreControl: true });
}

function issueWorkGrant(
  db: SqliteDatabase,
  principal: AdmissionPrincipal,
  domain: string,
  stamped: string,
  request: ActionRequest,
  basis: JudgmentBasis,
): ExecutionGrant {
  const work = requireVisibleWork(db, principal, request.work_id, request.generation);
  if (work.data_domain !== domain) throw new Error('FORBIDDEN');
  const mandate = requireMandate(db, work.mandate_id);
  const capability = requireCapability(db, principal.account_id, domain);
  assertWorkRequest(db, request, work, mandate, capability, basis, stamped);
  const existing = activeWorkGrant(db, request.work_id, request.generation);
  if (existing) {
    if (existing.attempt_id === request.attempt_id && sameWorkGrant(existing, request)) return mapWork(existing);
    const retryReady = work.attempt_closed === 1 && work.process_tree_stopped === 1 && work.effects_reconciled === 1;
    if (existing.attempt_id === request.attempt_id || !retryReady) throw new Error('DENIED');
    db.prepare('UPDATE execution_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(stamped, existing.grant_id);
  } else if (work.control_state === 'paused' || work.control_state === 'processing' || work.awaiting_answer === 1) {
    throw new Error('DENIED');
  } else if (work.control_state === 'stopped' && !(work.attempt_closed === 1 && work.process_tree_stopped === 1 && work.effects_reconciled === 1)) {
    throw new Error('DENIED');
  }
  if (basisBlocked(db, domain, request.work_id, request.generation, basis.hash)) throw new Error('DENIED');
  const grantId = `grant_${randomUUID()}`;
  db.prepare(`INSERT INTO execution_grants (
    grant_id, subject_kind, account_id, data_domain, work_id, generation, request_id, parent_work_id, result_version,
    job_id, owner_id, caller_id, attempt_id, mandate_id, next_action, allowed_effects_json, allowed_domains_json,
    readonly_tools_json, basis_hash, phase, collection_id, scope_hash, permission_revision, kind, result_ref,
    expires_at, revoked_at, schema_version, created_at
  ) VALUES (
    ?, 'work', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, '1.0', ?
  )`).run(
    grantId,
    principal.account_id,
    domain,
    request.work_id,
    request.generation,
    principal.caller_id,
    request.attempt_id,
    mandate.mandate_id,
    request.next_action,
    JSON.stringify(request.allowed_effects),
    JSON.stringify(parseList(mandate.domains_json)),
    basis.hash,
    request.phase,
    request.collection_id ?? null,
    mandate.scope_hash,
    mandate.revision,
    request.expires_at,
    stamped,
  );
  const swapped = existing !== undefined && existing.attempt_id !== request.attempt_id;
  if (swapped || work.control_state === 'stopped') {
    db.prepare(`UPDATE work_generations SET
      control_state = 'running', attempt_closed = 0, process_tree_stopped = 0, effects_reconciled = 0,
      current_attempt_id = ?, updated_at = ?
      WHERE work_id = ? AND generation = ?`).run(request.attempt_id, stamped, request.work_id, request.generation);
  } else {
    db.prepare('UPDATE work_generations SET current_attempt_id = ?, updated_at = ? WHERE work_id = ? AND generation = ?').run(
      request.attempt_id,
      stamped,
      request.work_id,
      request.generation,
    );
  }
  return mapWork(requireGrant(db, grantId));
}

function assertWorkRequest(
  db: SqliteDatabase,
  request: ActionRequest,
  work: WorkRow,
  mandate: MandateRow,
  capability: CapabilityRow,
  basis: JudgmentBasis,
  stamped: string,
): void {
  if (request.expires_at <= stamped) throw new Error('DENIED');
  if (work.phase !== request.phase) throw new Error('DENIED');
  if (mandate.status !== 'active' || mandate.expires_at <= stamped) throw new Error('DENIED');
  if (work.awaiting_answer === 1) throw new Error('DENIED');
  const mandateActions = parseList(mandate.actions_json);
  const capabilityActions = parseList(capability.actions_json);
  if (!actionAllowed(request.next_action, mandateActions) || !actionAllowed(request.next_action, capabilityActions)) throw new Error('DENIED');
  if (request.phase === 'collect_evidence') {
    const collectionId = request.collection_id ?? null;
    const only = collectionId ? `collect:${collectionId}` : '';
    if (!collectionId || work.collection_id !== collectionId || request.next_action !== only) throw new Error('DENIED');
    if (request.allowed_effects.length !== 1 || request.allowed_effects[0] !== only) throw new Error('DENIED');
  } else if (request.phase === 'delivery') {
    if (work.evidence_ready !== 1) throw new Error('DENIED');
    if (request.allowed_effects.length === 0 || !subset(request.allowed_effects, parseList(mandate.effects_json))) throw new Error('DENIED');
  } else if (!subset(request.allowed_effects, parseList(mandate.effects_json))) {
    throw new Error('DENIED');
  }
  if (reportBlocked(db, capability)) throw new Error('DENIED');
  if (basis.work_id !== work.work_id || basis.generation !== work.generation) throw new Error('DENIED');
}

function workStillDispatchable(
  db: SqliteDatabase,
  principal: AdmissionPrincipal,
  nowIso: string,
  grant: GrantRow,
  options: { ignoreControl?: boolean } = {},
): boolean {
  if (grant.work_id === null || grant.generation === null || grant.mandate_id === null || grant.basis_hash === null || grant.phase === null) return false;
  const work = loadWork(db, grant.work_id, grant.generation);
  if (!work || work.account_id !== principal.account_id) return false;
  if (!options.ignoreControl && (work.control_state !== 'running' || work.awaiting_answer === 1)) return false;
  if (work.phase !== grant.phase) return false;
  const mandate = db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(grant.mandate_id) as MandateRow | undefined;
  if (!mandate || mandate.status !== 'active' || mandate.expires_at <= nowIso || mandate.scope_hash !== grant.scope_hash) return false;
  const capability = db.prepare('SELECT * FROM capability_profiles WHERE account_id = ? AND data_domain = ?').get(
    principal.account_id,
    grant.data_domain,
  ) as CapabilityRow | undefined;
  if (!capability) return false;
  if (!actionAllowed(grant.next_action, parseList(mandate.actions_json)) || !actionAllowed(grant.next_action, parseList(capability.actions_json))) return false;
  if (reportBlocked(db, capability)) return false;
  return !basisBlocked(db, grant.data_domain, grant.work_id, grant.generation, grant.basis_hash);
}

function consultationStillDispatchable(db: SqliteDatabase, nowIso: string, grant: GrantRow): boolean {
  if (!grant.request_id) return false;
  const row = loadConsultation(db, grant.request_id);
  if (!row) return false;
  if (row.status !== 'pending' || row.cancelled_at || row.deadline_at <= nowIso) return false;
  if (row.permission_revision !== grant.permission_revision || row.result_version !== grant.result_version) return false;
  if (row.caller_id !== grant.caller_id) return false;
  return true;
}

function maintenanceStillDispatchable(db: SqliteDatabase, principal: AdmissionPrincipal, nowIso: string, grant: GrantRow): boolean {
  if (!grant.job_id || !grant.owner_id || grant.owner_id !== principal.account_id) return false;
  const job = db.prepare('SELECT status, cancelled_at, expires_at, kind, owner_id FROM maintenance_jobs WHERE job_id = ?').get(grant.job_id) as {
    status: string;
    cancelled_at: string | null;
    expires_at: string;
    kind: string;
    owner_id: string;
  } | undefined;
  if (!job || job.owner_id !== grant.owner_id || job.status !== 'open' || job.cancelled_at || job.expires_at <= nowIso) return false;
  return isMaintenanceKind(job.kind) && job.kind === grant.kind;
}

function basisBlocked(db: SqliteDatabase, domain: string, workId: string, generation: number, basisHash: string): boolean {
  const basis = db.prepare('SELECT basis_hash, standards_json, evidence_watermark FROM judgment_bases WHERE work_id = ? AND generation = ?').get(
    workId,
    generation,
  ) as { basis_hash: string; standards_json: string; evidence_watermark: number } | undefined;
  if (!basis || basis.basis_hash !== basisHash) return true;
  const standards = JSON.parse(basis.standards_json) as Array<{ standard_id: string; standard_version: number }>;
  for (const item of standards) {
    const withdrawn = db.prepare(`SELECT 1 AS ok FROM withdrawal_events
      WHERE data_domain = ? AND target_kind = 'standard' AND target_id = ? AND target_version = ? AND epoch > ? LIMIT 1`).get(
      domain,
      item.standard_id,
      item.standard_version,
      basis.evidence_watermark,
    );
    if (withdrawn) return true;
  }
  return false;
}

function reportBlocked(db: SqliteDatabase, capability: CapabilityRow): boolean {
  const withdrawn = db.prepare(`SELECT 1 AS ok FROM withdrawal_events
    WHERE data_domain = ? AND target_kind = 'report' AND target_id = ? AND target_version = ? LIMIT 1`).get(
    capability.data_domain,
    capability.report_id,
    capability.report_version,
  );
  return Boolean(withdrawn);
}

function changeMandate(
  db: SqliteDatabase,
  principal: AdmissionPrincipal,
  domain: string,
  stamped: string,
  mandateId: string,
  action: 'pause' | 'resume' | 'stop',
  expectedRevision?: number,
): DelegationView {
  return withImmediateTransaction(db, () => {
    const mandate = requireMandate(db, mandateId);
    if (mandate.account_id !== principal.account_id || mandate.data_domain !== domain) throw new Error('FORBIDDEN');
    if (expectedRevision !== undefined && mandate.revision !== expectedRevision) throw new Error('CONFLICT');
    if (action === 'pause') {
      db.prepare(`UPDATE mandates SET status = 'paused', revision = revision + 1, updated_at = ? WHERE mandate_id = ?`).run(stamped, mandateId);
    } else if (action === 'resume') {
      if (mandate.status === 'stopped' || mandate.expires_at <= stamped) throw new Error('DENIED');
      db.prepare(`UPDATE mandates SET status = 'active', revision = revision + 1, updated_at = ? WHERE mandate_id = ?`).run(stamped, mandateId);
    } else {
      db.prepare(`UPDATE mandates SET status = 'stopped', revision = revision + 1, updated_at = ? WHERE mandate_id = ?`).run(stamped, mandateId);
      db.prepare(`UPDATE execution_grants SET revoked_at = ?
        WHERE mandate_id = ? AND revoked_at IS NULL`).run(stamped, mandateId);
    }
    return viewMandate(requireMandate(db, mandateId));
  });
}

function sameWorkGrant(row: GrantRow, request: ActionRequest): boolean {
  return row.phase === request.phase
    && row.next_action === request.next_action
    && row.collection_id === (request.collection_id ?? null)
    && row.expires_at === request.expires_at
    && JSON.stringify(parseList(row.allowed_effects_json)) === JSON.stringify(request.allowed_effects);
}

function activeWorkGrant(db: SqliteDatabase, workId: string, generation: number): GrantRow | undefined {
  return db.prepare(`SELECT * FROM execution_grants
    WHERE subject_kind = 'work' AND work_id = ? AND generation = ? AND revoked_at IS NULL`).get(workId, generation) as GrantRow | undefined;
}

function activeConsultationGrant(db: SqliteDatabase, requestId: string): GrantRow | undefined {
  return db.prepare(`SELECT * FROM execution_grants
    WHERE subject_kind = 'consultation' AND request_id = ? AND revoked_at IS NULL`).get(requestId) as GrantRow | undefined;
}

function mapWork(row: GrantRow): ExecutionGrant {
  if (row.work_id === null || row.generation === null || row.mandate_id === null || row.basis_hash === null || row.phase === null) {
    throw new Error('UNPROCESSABLE');
  }
  return {
    grant_id: row.grant_id,
    subject_kind: 'work',
    work_id: row.work_id,
    generation: row.generation,
    attempt_id: row.attempt_id,
    mandate_id: row.mandate_id,
    next_action: row.next_action,
    allowed_effects: parseList(row.allowed_effects_json),
    basis_hash: row.basis_hash,
    phase: row.phase,
    collection_id: row.collection_id,
    expires_at: row.expires_at,
  };
}

function mapConsultation(row: GrantRow): ConsultationGrant {
  if (row.request_id === null || row.result_version === null) throw new Error('UNPROCESSABLE');
  return {
    grant_id: row.grant_id,
    subject_kind: 'consultation',
    request_id: row.request_id,
    result_version: row.result_version,
    caller_id: row.caller_id,
    parent_work_id: row.parent_work_id,
    allowed_domains: parseList(row.allowed_domains_json),
    readonly_tools: parseList(row.readonly_tools_json),
    allowed_effects: [],
    attempt_id: row.attempt_id,
    expires_at: row.expires_at,
  };
}

function mapMaintenance(row: GrantRow): MaintenanceGrant {
  if (row.job_id === null || row.owner_id === null || row.result_ref === null || !isMaintenanceKind(row.kind)) throw new Error('UNPROCESSABLE');
  return {
    grant_id: row.grant_id,
    subject_kind: 'maintenance',
    owner_id: row.owner_id,
    job_id: row.job_id,
    kind: row.kind,
    attempt_id: row.attempt_id,
    allowed_effects: [],
    result_ref: row.result_ref,
    expires_at: row.expires_at,
  };
}

function businessOf(grant: GrantRow): string {
  if (grant.subject_kind === 'work' && grant.work_id) return `work:${grant.work_id}`;
  if (grant.subject_kind === 'consultation' && grant.request_id) return `consultation:${grant.request_id}`;
  if (grant.subject_kind === 'maintenance' && grant.job_id) return `maintenance:${grant.job_id}`;
  return '';
}

function requireVisibleWork(db: SqliteDatabase, principal: AdmissionPrincipal, workId: string, generation: number): WorkRow {
  const work = loadWork(db, workId, generation);
  if (!work || work.account_id !== principal.account_id || !principal.domains.includes(work.data_domain)) throw new Error('NOT_FOUND');
  return work;
}

function loadWork(db: SqliteDatabase, workId: string, generation: number): WorkRow | undefined {
  return db.prepare('SELECT * FROM work_generations WHERE work_id = ? AND generation = ?').get(workId, generation) as WorkRow | undefined;
}

function requireMandate(db: SqliteDatabase, mandateId: string): MandateRow {
  const row = db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(mandateId) as MandateRow | undefined;
  if (!row) throw new Error('NOT_FOUND');
  return row;
}

function requireType(db: SqliteDatabase, principal: AdmissionPrincipal, domain: string, typeId: string): MandateTypeInput & { account_id: string } {
  const row = db.prepare('SELECT * FROM mandate_types WHERE type_id = ?').get(typeId) as {
    account_id: string;
    data_domain: string;
    actions_json: string;
    resources_json: string;
    effects_json: string;
    domains_json: string;
    risk: string;
    level: Level;
    budget_micros: number;
    config_version: number;
  } | undefined;
  if (!row || row.account_id !== principal.account_id || row.data_domain !== domain) throw new Error('NOT_FOUND');
  return {
    account_id: row.account_id,
    type_id: typeId,
    actions: parseList(row.actions_json),
    resources: parseList(row.resources_json),
    effects: parseList(row.effects_json),
    domains: parseList(row.domains_json),
    risk: row.risk,
    level: row.level,
    budget_micros: row.budget_micros,
    config_version: row.config_version,
  };
}

function requireCapability(db: SqliteDatabase, accountId: string, domain: string): CapabilityRow {
  const row = db.prepare('SELECT * FROM capability_profiles WHERE account_id = ? AND data_domain = ?').get(accountId, domain) as CapabilityRow | undefined;
  if (!row) throw new Error('DENIED');
  return row;
}

function requireGrant(db: SqliteDatabase, grantId: string): GrantRow {
  const row = db.prepare('SELECT * FROM execution_grants WHERE grant_id = ?').get(grantId) as GrantRow | undefined;
  if (!row) throw new Error('NOT_FOUND');
  return row;
}

function loadConsultation(db: SqliteDatabase, requestId: string) {
  return db.prepare('SELECT * FROM consultations WHERE request_id = ?').get(requestId) as {
    request_id: string;
    account_id: string;
    caller_id: string;
    data_domain: string;
    parent_work_id: string | null;
    result_version: number;
    status: string;
    domains_json: string;
    tools_json: string;
    deadline_at: string;
    permission_revision: number;
    cancelled_at: string | null;
  } | undefined;
}

function assertInsideType(input: MandateInput, type: MandateTypeInput): void {
  if (input.budget_micros > type.budget_micros) throw new Error('UNPROCESSABLE');
  if (levelRank(input.level) > levelRank(type.level)) throw new Error('UNPROCESSABLE');
  if (input.risk !== type.risk) throw new Error('UNPROCESSABLE');
  if (!subset(input.actions, type.actions) || !subset(input.resources, type.resources) || !subset(input.effects, type.effects)) {
    throw new Error('UNPROCESSABLE');
  }
  if (!subset(input.domains, type.domains)) throw new Error('UNPROCESSABLE');
}

function viewMandate(row: MandateRow): DelegationView {
  return {
    mandate_id: row.mandate_id,
    type_id: row.type_id,
    status: row.status,
    level: row.level,
    budget_micros: row.budget_micros,
    actions: parseList(row.actions_json),
    effects: parseList(row.effects_json),
    domains: parseList(row.domains_json),
    risk: row.risk,
    expires_at: row.expires_at,
    revision: row.revision,
  };
}

function scopeHash(input: MandateInput): string {
  return sha256(canonicalPayload({
    actions: [...input.actions].sort(),
    budget_micros: input.budget_micros,
    domains: [...input.domains].sort(),
    effects: [...input.effects].sort(),
    level: input.level,
    resources: [...input.resources].sort(),
    risk: input.risk,
  }));
}

function subset(requested: readonly string[], granted: readonly string[]): boolean {
  return requested.every((item) => granted.includes(item));
}

function actionAllowed(action: string, granted: readonly string[]): boolean {
  if (granted.includes(action)) return true;
  return action.startsWith('collect:') && granted.includes('collect');
}

function parseList(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('UNPROCESSABLE');
  return parsed;
}

function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

function isMaintenanceKind(kind: string | null): kind is MaintenanceKind {
  return kind !== null && MAINTENANCE_KINDS.has(kind as MaintenanceKind);
}

function assertMicros(amount: number): void {
  if (!Number.isInteger(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) throw new Error('UNPROCESSABLE');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
