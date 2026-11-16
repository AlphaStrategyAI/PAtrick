import { createHash, randomUUID } from 'node:crypto';
import { canonicalPayload } from '@patrick/contracts';
import { appendDomainEvent, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import {
  decideTraining,
  evaluateFrozen,
  parseRules,
  readProductFixture,
  scoreTrainingOnly,
  type FrozenCase,
  type ProductCase,
  type StandardRule,
} from './evaluation.js';

export { decideTraining, scoreTrainingOnly };
export type { FrozenCase, StandardRule };

export const ADOPT_STANDARD_SQL = `UPDATE standards SET active_version = @next_version, revision = revision + 1
WHERE standard_id = @standard_id AND data_domain = @data_domain
  AND revision = @expected_revision AND active_version IS @base_version
RETURNING standard_id, active_version, revision;`;

const CONTROL_ORIGIN = 'http://localhost';
const CONTROL_RP_ID = 'localhost';

export type StandardsPrincipal = {
  account_id: string;
  caller_id: string;
  auth_epoch: number;
  domains: readonly string[];
  operations: readonly string[];
};

export type StandardsOptions = {
  now?: () => Date;
  domain: string;
};

export type IngestedHead = {
  vault_id: string;
  standard_id: string;
  draft_key: string;
  document_id: string;
  source_revision: number;
  content_hash: string;
};

export type Candidate = {
  id: string;
  standard_id: string;
  revision: number;
  base_version: number | null;
  source_revision: number;
  content_hash: string;
  data_domain: string;
};

export type ReportView = {
  id: string;
  candidate_id: string;
  dataset_id: string;
  policy_version: number;
  decision: 'pass' | 'fail' | 'insufficient' | 'leak';
  training_correct: number;
  training_total: number;
  holdout_correct: number;
  holdout_total: number;
  baseline_correct: number | null;
  external_correct: number;
  threshold_thousandths: number;
  min_samples: number;
  budget_micros: number;
  source_revision: number;
  content_hash: string;
  evidence_watermark: number;
  base_version: number | null;
};

export type EvaluationInput = {
  candidate_id: string;
  policy_version: number;
  dataset_id: string;
  training: FrozenCase[];
  holdout: FrozenCase[];
  holdout_ids: string[];
  min_samples: number;
  threshold_thousandths: number;
  budget_micros: number;
  evidence_watermark: number;
  source_revision: number;
  content_hash: string;
  base_version: number | null;
  permission_hash: string;
  external_method_id: string;
  external_method_revision: string;
};

export type CaseOutcome = {
  result: 'accepted' | 'rejected' | 'rework' | 'failure' | 'unknown';
  source: string;
  observed_at: string;
};

export type JudgmentBasis = {
  work_id: string;
  generation: number;
  standards: Array<{ standard_id: string; standard_version: number }>;
  external_method_id: string | null;
  external_method_revision: string | null;
  hash: string;
  evidence_watermark: number;
};

export type SeedDatasetInput = {
  datasetId: string;
  policyId: string;
  policyVersion: number;
  minSamples: number;
  thresholdThousandths: number;
  budgetMicros: number;
  cases: ProductCase[];
  externalMethodId?: string;
  externalMethodRevision?: string;
  externalRules?: StandardRule[];
};

type CandidateRow = {
  candidate_id: string;
  standard_id: string;
  account_id: string;
  data_domain: string;
  draft_key: string;
  base_version: number | null;
  document_id: string;
  source_revision: number;
  content_hash: string;
  pointer_revision: number;
  rules_json: string;
  evidence_watermark: number;
  permission_hash: string;
  edit_id: string | null;
  status: string;
};

type ReportRow = {
  report_id: string;
  candidate_id: string;
  standard_id: string;
  account_id: string;
  data_domain: string;
  dataset_id: string;
  policy_version: number;
  decision: ReportView['decision'];
  training_correct: number;
  training_total: number;
  holdout_correct: number;
  holdout_total: number;
  baseline_correct: number | null;
  external_correct: number;
  threshold_thousandths: number;
  min_samples: number;
  budget_micros: number;
  source_revision: number;
  content_hash: string;
  evidence_watermark: number;
  permission_hash: string;
  base_version: number | null;
  pointer_revision: number;
};

export function createStandardsApi(db: SqliteDatabase, principal: StandardsPrincipal, options: StandardsOptions) {
  const now = options.now ?? (() => new Date());
  const domain = options.domain;

  function assertDomain(): void {
    if (!principal.domains.includes(domain)) throw new Error('FORBIDDEN');
  }

  function stamp(): string {
    return now().toISOString();
  }

  return {
    async seedProductDataset() {
      assertDomain();
      const fixture = readProductFixture();
      return seedDataset(db, domain, stamp(), {
        datasetId: fixture.dataset_id,
        policyId: fixture.policy_id,
        policyVersion: fixture.policy_version,
        minSamples: fixture.min_samples,
        thresholdThousandths: fixture.threshold_thousandths,
        budgetMicros: fixture.budget_micros,
        cases: fixture.cases,
        externalMethodId: fixture.external_method.id,
        externalMethodRevision: fixture.external_method.revision,
        externalRules: fixture.external_method.rules,
      });
    },

    async seedDataset(input: SeedDatasetInput) {
      assertDomain();
      return seedDataset(db, domain, stamp(), input);
    },

    async ingestStandardDraft(input: {
      vaultId: string;
      standardId: string;
      draftKey: string;
      rules: StandardRule[];
      note?: string;
      thresholdClaim?: number;
    }): Promise<IngestedHead> {
      assertDomain();
      const body = renderStandard(input);
      const bytes = Buffer.from(body, 'utf8');
      const hash = sha256(bytes);
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const vault = db.prepare('SELECT vault_id, account_id, data_domain FROM vaults WHERE vault_id = ?').get(input.vaultId) as {
          vault_id: string;
          account_id: string;
          data_domain: string;
        } | undefined;
        if (!vault || vault.account_id !== principal.account_id || vault.data_domain !== domain) throw new Error('FORBIDDEN');
        const relativePath = `标准修订/${safeSegment(input.draftKey)}.md`;
        db.prepare('INSERT INTO blobs (sha256, byte_length, created_at) VALUES (?, ?, ?) ON CONFLICT(sha256) DO NOTHING').run(
          hash,
          bytes.byteLength,
          stamped,
        );
        const existing = db.prepare(`SELECT document_id, content_hash, observed_seq, tombstone FROM vault_documents
          WHERE vault_id = ? AND relative_path = ?`).get(vault.vault_id, relativePath) as {
          document_id: string;
          content_hash: string | null;
          observed_seq: number;
          tombstone: number;
        } | undefined;
        if (existing && existing.tombstone === 0 && existing.content_hash === hash) {
          return {
            vault_id: vault.vault_id,
            standard_id: input.standardId,
            draft_key: input.draftKey,
            document_id: existing.document_id,
            source_revision: existing.observed_seq,
            content_hash: hash,
          };
        }
        const documentId = existing?.document_id ?? `doc_${sha256(`${vault.vault_id}\0${relativePath}`).slice(0, 24)}`;
        const sourceRevision = (existing?.observed_seq ?? 0) + 1;
        const revisionId = `rev_${sha256(`${documentId}\0${sourceRevision}`).slice(0, 24)}`;
        if (!existing) {
          db.prepare(`INSERT INTO vault_documents (
            document_id, vault_id, relative_path, identity_key, kind, knowledge_id, patrick_id, body_text, content_hash,
            byte_length, observed_seq, tombstone, parse_error, account_id, data_domain, schema_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'note', NULL, ?, ?, ?, ?, ?, 0, NULL, ?, ?, '1.0', ?, ?)`).run(
            documentId,
            vault.vault_id,
            relativePath,
            `direct:${documentId}`,
            input.standardId,
            body,
            hash,
            bytes.byteLength,
            sourceRevision,
            principal.account_id,
            domain,
            stamped,
            stamped,
          );
        } else {
          db.prepare(`UPDATE vault_documents
            SET patrick_id = ?, body_text = ?, content_hash = ?, byte_length = ?, observed_seq = ?, tombstone = 0,
              parse_error = NULL, updated_at = ?
            WHERE document_id = ?`).run(
            input.standardId,
            body,
            hash,
            bytes.byteLength,
            sourceRevision,
            stamped,
            documentId,
          );
        }
        db.prepare(`INSERT INTO vault_revisions (
          vault_id, document_id, observed_seq, revision_id, content_hash, identity_key, relative_path, tombstone,
          account_id, data_domain, schema_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '1.0', ?)`).run(
          vault.vault_id,
          documentId,
          sourceRevision,
          revisionId,
          hash,
          `direct:${documentId}`,
          relativePath,
          principal.account_id,
          domain,
          stamped,
        );
        return {
          vault_id: vault.vault_id,
          standard_id: input.standardId,
          draft_key: input.draftKey,
          document_id: documentId,
          source_revision: sourceRevision,
          content_hash: hash,
        };
      });
    },

    async openCandidate(input: IngestedHead & { baseVersion?: number | null; editId?: string | null }): Promise<Candidate> {
      assertDomain();
      const baseVersion = input.baseVersion === undefined ? null : input.baseVersion;
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const document = db.prepare(`SELECT document_id, vault_id, body_text, observed_seq, content_hash, account_id, data_domain
          FROM vault_documents WHERE document_id = ?`).get(input.document_id) as {
          document_id: string;
          vault_id: string;
          body_text: string | null;
          observed_seq: number;
          content_hash: string | null;
          account_id: string;
          data_domain: string;
        } | undefined;
        if (!document || document.account_id !== principal.account_id || document.data_domain !== domain) throw new Error('FORBIDDEN');
        if (document.vault_id !== input.vault_id || document.observed_seq !== input.source_revision || document.content_hash !== input.content_hash) {
          throw new Error('CONFLICT');
        }
        if (!document.body_text) throw new Error('UNPROCESSABLE');
        const rules = parseRules(document.body_text);
        const existingStandard = db.prepare('SELECT active_version, revision, account_id, data_domain FROM standards WHERE standard_id = ?').get(input.standard_id) as {
          active_version: number | null;
          revision: number;
          account_id: string;
          data_domain: string;
        } | undefined;
        if (existingStandard && (existingStandard.account_id !== principal.account_id || existingStandard.data_domain !== domain)) {
          throw new Error('FORBIDDEN');
        }
        if (!existingStandard) {
          if (baseVersion !== null) throw new Error('CONFLICT');
          db.prepare(`INSERT INTO standards (
            standard_id, account_id, data_domain, active_version, revision, schema_version, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, 0, '1.0', ?, ?)`).run(input.standard_id, principal.account_id, domain, stamped, stamped);
        } else if (existingStandard.active_version !== baseVersion) {
          throw new Error('CONFLICT');
        }
        const pointer = db.prepare('SELECT revision FROM standards WHERE standard_id = ?').get(input.standard_id) as { revision: number };
        const candidateId = `cand_${sha256(canonicalPayload({
          standard_id: input.standard_id,
          draft_key: input.draft_key,
          source_revision: input.source_revision,
          content_hash: input.content_hash,
        })).slice(0, 24)}`;
        const current = db.prepare('SELECT candidate_id FROM standard_candidates WHERE candidate_id = ?').get(candidateId) as {
          candidate_id: string;
        } | undefined;
        const permission = permissionSnapshot(db, principal, domain);
        const watermark = evidenceWatermark(db, domain);
        if (!current) {
          const editId = linkedEditId(db, principal, domain, input);
          db.prepare(`INSERT INTO standard_candidates (
            candidate_id, standard_id, account_id, data_domain, draft_key, base_version, document_id, source_revision,
            content_hash, pointer_revision, rules_json, evidence_watermark, permission_hash, edit_id, status,
            schema_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '1.0', ?, ?)`).run(
            candidateId,
            input.standard_id,
            principal.account_id,
            domain,
            input.draft_key,
            baseVersion,
            input.document_id,
            input.source_revision,
            input.content_hash,
            pointer.revision,
            JSON.stringify(rules),
            watermark,
            permission,
            editId,
            stamped,
            stamped,
          );
        }
        return candidateView(requireCandidate(db, candidateId));
      });
    },

    async prepareEvaluation(candidateId: string, policyVersion: number): Promise<EvaluationInput> {
      assertDomain();
      const candidate = requireCandidate(db, candidateId);
      if (candidate.account_id !== principal.account_id || candidate.data_domain !== domain) throw new Error('FORBIDDEN');
      const prepared = loadPrepared(db, policyVersion, domain);
      return {
        candidate_id: candidate.candidate_id,
        policy_version: policyVersion,
        dataset_id: prepared.datasetId,
        training: prepared.training,
        holdout: prepared.holdout,
        holdout_ids: prepared.holdoutIds,
        min_samples: prepared.minSamples,
        threshold_thousandths: prepared.thresholdThousandths,
        budget_micros: prepared.budgetMicros,
        evidence_watermark: evidenceWatermark(db, domain),
        source_revision: candidate.source_revision,
        content_hash: candidate.content_hash,
        base_version: candidate.base_version,
        permission_hash: permissionSnapshot(db, principal, domain),
        external_method_id: prepared.externalMethodId,
        external_method_revision: prepared.externalMethodRevision,
      };
    },

    async evaluate(candidate: { id: string }, policy: { version: number }): Promise<ReportView> {
      assertDomain();
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const row = requireCandidate(db, candidate.id);
        if (row.account_id !== principal.account_id || row.data_domain !== domain) throw new Error('FORBIDDEN');
        const head = documentHead(db, row.document_id);
        if (head.observed_seq !== row.source_revision || head.content_hash !== row.content_hash) throw new Error('CONFLICT');
        const prepared = loadPrepared(db, policy.version, domain);
        const permission = permissionSnapshot(db, principal, domain);
        const watermark = evidenceWatermark(db, domain);
        const existing = db.prepare(`SELECT report_id FROM evaluation_reports
          WHERE candidate_id = ? AND policy_version = ? AND source_revision = ? AND content_hash = ?
            AND evidence_watermark = ? AND permission_hash = ?`).get(
          row.candidate_id,
          policy.version,
          row.source_revision,
          row.content_hash,
          watermark,
          permission,
        ) as { report_id: string } | undefined;
        if (existing) return reportView(requireReport(db, existing.report_id));
        const rules = JSON.parse(row.rules_json) as StandardRule[];
        const baselineRules = baselineRulesFor(db, row.standard_id);
        const scored = evaluateFrozen({
          rules,
          training: prepared.training,
          holdout: prepared.holdout,
          holdoutIds: prepared.holdoutIds,
          baselineRules,
          externalRules: prepared.externalRules,
          minSamples: prepared.minSamples,
          thresholdThousandths: prepared.thresholdThousandths,
        });
        const reportId = `rpt_${sha256(canonicalPayload({
          candidate_id: row.candidate_id,
          policy_version: policy.version,
          source_revision: row.source_revision,
          content_hash: row.content_hash,
          evidence_watermark: watermark,
          permission_hash: permission,
        })).slice(0, 24)}`;
        db.prepare(`INSERT INTO evaluation_reports (
          report_id, candidate_id, standard_id, account_id, data_domain, dataset_id, policy_version, decision,
          training_correct, training_total, holdout_correct, holdout_total, baseline_correct, external_correct,
          threshold_thousandths, min_samples, budget_micros, source_revision, content_hash, evidence_watermark,
          permission_hash, base_version, pointer_revision, schema_version, frozen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0', ?)`).run(
          reportId,
          row.candidate_id,
          row.standard_id,
          row.account_id,
          domain,
          prepared.datasetId,
          policy.version,
          scored.decision,
          scored.training.correct,
          scored.training.total,
          scored.holdout.correct,
          scored.holdout.total,
          scored.baselineCorrect,
          scored.externalCorrect,
          prepared.thresholdThousandths,
          prepared.minSamples,
          prepared.budgetMicros,
          row.source_revision,
          row.content_hash,
          watermark,
          permission,
          row.base_version,
          row.pointer_revision,
          stamped,
        );
        return reportView(requireReport(db, reportId));
      });
    },

    async adoptStandard(candidateId: string, reportId: string, expectedRevision: number): Promise<'adopted' | 'stale' | 'not_adopted'> {
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const already = db.prepare('SELECT fact_id FROM adoption_facts WHERE candidate_id = ? AND report_id = ?').get(candidateId, reportId) as {
          fact_id: string;
        } | undefined;
        if (already) return 'adopted';
        const candidate = requireCandidate(db, candidateId);
        if (candidate.account_id !== principal.account_id) throw new Error('FORBIDDEN');
        const report = requireReport(db, reportId);
        const reject = (result: 'stale' | 'not_adopted'): 'stale' | 'not_adopted' => {
          db.prepare(`UPDATE standard_candidates SET status = ?, updated_at = ? WHERE candidate_id = ?`).run(result, stamped, candidate.candidate_id);
          if (candidate.edit_id) appendEditReceipt(db, candidate.edit_id, result, candidate.candidate_id, report.report_id, null, stamped);
          return result;
        };
        if (report.candidate_id !== candidate.candidate_id || report.account_id !== candidate.account_id) return reject('stale');
        if (report.pointer_revision !== candidate.pointer_revision || report.base_version !== candidate.base_version) return reject('stale');
        if (expectedRevision !== candidate.pointer_revision) return reject('stale');
        const head = documentHead(db, candidate.document_id);
        if (head.observed_seq !== report.source_revision || head.content_hash !== report.content_hash) return reject('stale');
        if (evidenceWatermark(db, candidate.data_domain) !== report.evidence_watermark) return reject('stale');
        if (report.decision !== 'pass') return reject('not_adopted');
        if (!principal.domains.includes(candidate.data_domain)) {
          stageProposal(db, principal, candidate, report, stamped, now);
          return reject('not_adopted');
        }
        if (permissionSnapshot(db, principal, candidate.data_domain) !== report.permission_hash) return reject('stale');
        const nextVersion = candidate.base_version === null ? 1 : candidate.base_version + 1;
        const updated = db.prepare(ADOPT_STANDARD_SQL).get({
          next_version: nextVersion,
          standard_id: candidate.standard_id,
          data_domain: candidate.data_domain,
          expected_revision: expectedRevision,
          base_version: candidate.base_version,
        }) as { standard_id: string; active_version: number; revision: number } | undefined;
        if (!updated) return reject('stale');
        if (updated.active_version !== nextVersion || updated.revision !== expectedRevision + 1) throw new Error('CONFLICT');
        db.prepare('UPDATE standards SET updated_at = ? WHERE standard_id = ?').run(stamped, candidate.standard_id);
        db.prepare(`UPDATE standard_versions SET status = 'retained' WHERE standard_id = ? AND status = 'active'`).run(candidate.standard_id);
        const rules = JSON.parse(candidate.rules_json) as StandardRule[];
        db.prepare(`INSERT INTO standard_versions (
          standard_id, version, data_domain, scope_text, rules_json, exceptions_text, counterexamples_text, source_text,
          document_id, source_revision, content_hash, base_version, status, schema_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '1.0', ?)`).run(
          candidate.standard_id,
          nextVersion,
          candidate.data_domain,
          '产品需求判断',
          JSON.stringify(rules),
          '普通功能冒充故障时仍先访谈',
          '不能用单次高管意见代替已授权的取舍',
          candidate.document_id,
          candidate.document_id,
          report.source_revision,
          report.content_hash,
          candidate.base_version,
          stamped,
        );
        const factId = `fact_${sha256(`${candidate.candidate_id}\0${report.report_id}`).slice(0, 24)}`;
        const intentId = `intent_${factId}`;
        const eventId = `standard.activated:${candidate.standard_id}:${nextVersion}`;
        db.prepare(`INSERT INTO adoption_facts (
          fact_id, candidate_id, report_id, standard_id, data_domain, active_version, standard_revision,
          projection_intent_id, event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          factId,
          candidate.candidate_id,
          report.report_id,
          candidate.standard_id,
          candidate.data_domain,
          nextVersion,
          updated.revision,
          intentId,
          eventId,
          stamped,
        );
        db.prepare(`UPDATE standard_candidates SET status = 'adopted', updated_at = ? WHERE candidate_id = ?`).run(stamped, candidate.candidate_id);
        appendDomainEvent(db, {
          eventId,
          aggregateId: candidate.standard_id,
          aggregateVersion: nextVersion,
          accountId: candidate.account_id,
          dataDomain: candidate.data_domain,
          payload: {
            type: 'standard.activated',
            standard_id: candidate.standard_id,
            active_version: nextVersion,
            candidate_id: candidate.candidate_id,
            report_id: report.report_id,
            fact_id: factId,
          },
          destination: 'vault',
        });
        const vault = db.prepare('SELECT vault_id FROM vault_documents WHERE document_id = ?').get(candidate.document_id) as {
          vault_id: string;
        };
        const pointer = db.prepare(`SELECT COALESCE(MAX(projection_revision), 0) AS revision FROM projection_batches
          WHERE data_domain = ? AND view_kind = 'standards'`).get(candidate.data_domain) as { revision: number };
        const manifest = canonicalPayload({
          standard_id: candidate.standard_id,
          active_version: nextVersion,
          fact_id: factId,
          content_hash: report.content_hash,
        });
        db.prepare(`INSERT INTO projection_batches (
          data_domain, view_kind, projection_revision, vault_id, intent_id, manifest_json, manifest_hash,
          cleanup_state, applied, created_at, updated_at
        ) VALUES (?, 'standards', ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(
          candidate.data_domain,
          pointer.revision + 1,
          vault.vault_id,
          intentId,
          manifest,
          sha256(manifest),
          stamped,
          stamped,
        );
        if (candidate.edit_id) appendEditReceipt(db, candidate.edit_id, 'adopted', candidate.candidate_id, report.report_id, intentId, stamped);
        return 'adopted';
      });
    },

    async recordOutcome(caseId: string, outcome: CaseOutcome): Promise<void> {
      assertDomain();
      const stamped = stamp();
      withImmediateTransaction(db, () => {
        const row = db.prepare('SELECT dataset_id, data_domain FROM cases WHERE case_id = ? AND data_domain = ?').get(caseId, domain) as {
          dataset_id: string;
          data_domain: string;
        } | undefined;
        if (!row) throw new Error('NOT_FOUND');
        const outcomeId = `outcome_${sha256(canonicalPayload({
          case_id: caseId,
          dataset_id: row.dataset_id,
          result: outcome.result,
          source: outcome.source,
          observed_at: outcome.observed_at,
        })).slice(0, 24)}`;
        db.prepare(`INSERT INTO case_outcomes (outcome_id, dataset_id, case_id, result, source, observed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(outcome_id) DO NOTHING`).run(
          outcomeId,
          row.dataset_id,
          caseId,
          outcome.result,
          outcome.source,
          outcome.observed_at,
          stamped,
        );
      });
    },

    async getEvaluation(reportId: string): Promise<ReportView> {
      const report = requireReport(db, reportId);
      if (report.account_id !== principal.account_id || !principal.domains.includes(report.data_domain)) throw new Error('FORBIDDEN');
      return reportView(report);
    },

    async activeStandardVersion(standardId: string): Promise<number | null> {
      const row = db.prepare('SELECT active_version, account_id, data_domain FROM standards WHERE standard_id = ?').get(standardId) as {
        active_version: number | null;
        account_id: string;
        data_domain: string;
      } | undefined;
      if (!row || row.account_id !== principal.account_id || row.data_domain !== domain) return null;
      return row.active_version;
    },

    async activeStandardCount(): Promise<number> {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM standards
        WHERE account_id = ? AND data_domain = ? AND active_version IS NOT NULL`).get(principal.account_id, domain) as { n: number };
      return row.n;
    },

    async listStandards(): Promise<Array<{ standard_id: string; active_version: number | null }>> {
      const rows = db.prepare(`SELECT standard_id, active_version, data_domain FROM standards
        WHERE account_id = ? ORDER BY standard_id`).all(principal.account_id) as Array<{
        standard_id: string;
        active_version: number | null;
        data_domain: string;
      }>;
      return rows
        .filter((row) => principal.domains.includes(row.data_domain))
        .map((row) => ({ standard_id: row.standard_id, active_version: row.active_version }));
    },

    async listVersions(standardId: string): Promise<Array<{ version: number; status: string }>> {
      const standard = db.prepare('SELECT account_id, data_domain FROM standards WHERE standard_id = ?').get(standardId) as {
        account_id: string;
        data_domain: string;
      } | undefined;
      if (!standard || standard.account_id !== principal.account_id || !principal.domains.includes(standard.data_domain)) {
        throw new Error('FORBIDDEN');
      }
      return db.prepare('SELECT version, status FROM standard_versions WHERE standard_id = ? ORDER BY version').all(standardId) as Array<{
        version: number;
        status: string;
      }>;
    },

    async freezeJudgmentBasis(workId: string, generation: number): Promise<JudgmentBasis> {
      assertDomain();
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const existing = loadBasis(db, workId, generation);
        if (existing) {
          if (existing.account_id !== principal.account_id || existing.data_domain !== domain) throw new Error('FORBIDDEN');
          return basisView(existing);
        }
        const active = db.prepare(`SELECT standard_id, active_version FROM standards
          WHERE account_id = ? AND data_domain = ? AND active_version IS NOT NULL
          ORDER BY standard_id`).all(principal.account_id, domain) as Array<{ standard_id: string; active_version: number }>;
        const standards = active.map((row) => ({ standard_id: row.standard_id, standard_version: row.active_version }));
        const policy = db.prepare(`SELECT external_method_id, external_method_revision FROM evaluation_policies
          WHERE data_domain = ? ORDER BY policy_version LIMIT 1`).get(domain) as {
          external_method_id: string;
          external_method_revision: string;
        } | undefined;
        const externalMethodId = standards.length === 0 ? policy?.external_method_id ?? null : null;
        const externalMethodRevision = standards.length === 0 ? policy?.external_method_revision ?? null : null;
        if (standards.length === 0 && (!externalMethodId || !externalMethodRevision)) throw new Error('UNPROCESSABLE');
        const watermark = evidenceWatermark(db, domain);
        const hash = sha256(canonicalPayload({
          standards,
          external_method_id: externalMethodId,
          external_method_revision: externalMethodRevision,
        }));
        db.prepare(`INSERT INTO judgment_bases (
          work_id, generation, account_id, data_domain, basis_hash, standards_json, external_method_id,
          external_method_revision, evidence_watermark, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          workId,
          generation,
          principal.account_id,
          domain,
          hash,
          JSON.stringify(standards),
          externalMethodId,
          externalMethodRevision,
          watermark,
          stamped,
        );
        for (const item of standards) {
          db.prepare(`INSERT INTO evidence_dependencies (
            dependency_id, from_kind, from_id, from_version, to_kind, to_id, to_version, data_domain, epoch, created_at
          ) VALUES (?, 'work', ?, ?, 'standard', ?, ?, ?, ?, ?)`).run(
            `dep_${sha256(`${workId}\0${generation}\0${item.standard_id}\0${item.standard_version}`).slice(0, 24)}`,
            workId,
            generation,
            item.standard_id,
            item.standard_version,
            domain,
            watermark,
            stamped,
          );
        }
        const stored = loadBasis(db, workId, generation);
        if (!stored) throw new Error('CONFLICT');
        return basisView(stored);
      });
    },

    async withdrawStandardVersion(standardId: string, version: number, reason: string): Promise<{ epoch: number }> {
      assertDomain();
      const stamped = stamp();
      return withImmediateTransaction(db, () => {
        const versionRow = db.prepare(`SELECT data_domain FROM standard_versions WHERE standard_id = ? AND version = ?`).get(standardId, version) as {
          data_domain: string;
        } | undefined;
        if (!versionRow || versionRow.data_domain !== domain) throw new Error('NOT_FOUND');
        const epoch = evidenceWatermark(db, domain) + 1;
        db.prepare(`INSERT INTO withdrawal_events (
          event_id, data_domain, target_kind, target_id, target_version, epoch, reason, created_at
        ) VALUES (?, ?, 'standard', ?, ?, ?, ?, ?)`).run(
          `withdraw:standard:${standardId}:${version}:${epoch}`,
          domain,
          standardId,
          version,
          epoch,
          reason,
          stamped,
        );
        db.prepare(`UPDATE standard_versions SET status = 'withdrawn' WHERE standard_id = ? AND version = ?`).run(standardId, version);
        return { epoch };
      });
    },

    async admitJudgmentAction(workId: string, generation: number): Promise<'allowed' | 'blocked'> {
      assertDomain();
      const basis = loadBasis(db, workId, generation);
      if (!basis || basis.account_id !== principal.account_id || basis.data_domain !== domain) throw new Error('NOT_FOUND');
      const standards = JSON.parse(basis.standards_json) as Array<{ standard_id: string; standard_version: number }>;
      for (const item of standards) {
        const withdrawn = db.prepare(`SELECT epoch FROM withdrawal_events
          WHERE data_domain = ? AND target_kind = 'standard' AND target_id = ? AND target_version = ?
            AND epoch > ? LIMIT 1`).get(domain, item.standard_id, item.standard_version, basis.evidence_watermark) as {
          epoch: number;
        } | undefined;
        if (withdrawn) return 'blocked';
      }
      return 'allowed';
    },
  };
}

function seedDataset(
  db: SqliteDatabase,
  domain: string,
  stamped: string,
  input: SeedDatasetInput,
): { training: number; holdout: number; training_ids: string[]; holdout_ids: string[]; dataset_id: string } {
  const trainingIds = input.cases.filter((item) => item.role === 'training').map((item) => item.case_id);
  const holdoutIds = input.cases.filter((item) => item.role === 'holdout').map((item) => item.case_id);
  if (trainingIds.length + holdoutIds.length !== input.cases.length) throw new Error('UNPROCESSABLE');
  if (new Set([...trainingIds, ...holdoutIds]).size !== input.cases.length) throw new Error('UNPROCESSABLE');
  const externalRules = input.externalRules ?? [{ when: [], unless: [], choice: 'interview' }];
  const splitHash = sha256(canonicalPayload({ training_ids: trainingIds, holdout_ids: holdoutIds }));
  withImmediateTransaction(db, () => {
    db.prepare(`INSERT INTO evaluation_policies (
      policy_id, policy_version, data_domain, dataset_id, min_samples, threshold_thousandths, budget_micros,
      external_method_id, external_method_revision, external_rules_json, schema_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0', ?)`).run(
      input.policyId,
      input.policyVersion,
      domain,
      input.datasetId,
      input.minSamples,
      input.thresholdThousandths,
      input.budgetMicros,
      input.externalMethodId ?? 'method-demand-interview',
      input.externalMethodRevision ?? '2026.1',
      JSON.stringify(externalRules),
      stamped,
    );
    db.prepare(`INSERT INTO evaluation_datasets (
      dataset_id, data_domain, policy_id, policy_version, training_ids, holdout_ids, split_hash, schema_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '1.0', ?)`).run(
      input.datasetId,
      domain,
      input.policyId,
      input.policyVersion,
      JSON.stringify(trainingIds),
      JSON.stringify(holdoutIds),
      splitHash,
      stamped,
    );
    const insertCase = db.prepare(`INSERT INTO cases (
      dataset_id, case_id, data_domain, role, situation, visible_evidence, options_json, expected_choice,
      case_version, schema_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '1.0', ?)`);
    for (const item of input.cases) {
      insertCase.run(
        input.datasetId,
        item.case_id,
        domain,
        item.role,
        item.situation,
        JSON.stringify(item.visible_evidence),
        JSON.stringify(item.options),
        item.expected_choice,
        stamped,
      );
    }
  });
  return { training: trainingIds.length, holdout: holdoutIds.length, training_ids: trainingIds, holdout_ids: holdoutIds, dataset_id: input.datasetId };
}

function loadPrepared(db: SqliteDatabase, policyVersion: number, domain: string) {
  const policy = db.prepare(`SELECT dataset_id, min_samples, threshold_thousandths, budget_micros, external_method_id,
      external_method_revision, external_rules_json
    FROM evaluation_policies WHERE data_domain = ? AND policy_version = ?`).get(domain, policyVersion) as {
    dataset_id: string;
    min_samples: number;
    threshold_thousandths: number;
    budget_micros: number;
    external_method_id: string;
    external_method_revision: string;
    external_rules_json: string;
  } | undefined;
  if (!policy) throw new Error('NOT_FOUND');
  const dataset = db.prepare('SELECT holdout_ids, training_ids, data_domain FROM evaluation_datasets WHERE dataset_id = ?').get(policy.dataset_id) as {
    holdout_ids: string;
    training_ids: string;
    data_domain: string;
  } | undefined;
  if (!dataset || dataset.data_domain !== domain) throw new Error('NOT_FOUND');
  const holdoutIds = JSON.parse(dataset.holdout_ids) as string[];
  const training = loadCases(db, policy.dataset_id, 'training');
  const holdout = loadCases(db, policy.dataset_id, 'holdout');
  return {
    datasetId: policy.dataset_id,
    training,
    holdout,
    holdoutIds,
    minSamples: policy.min_samples,
    thresholdThousandths: policy.threshold_thousandths,
    budgetMicros: policy.budget_micros,
    externalMethodId: policy.external_method_id,
    externalMethodRevision: policy.external_method_revision,
    externalRules: JSON.parse(policy.external_rules_json) as StandardRule[],
  };
}

function loadCases(db: SqliteDatabase, datasetId: string, role: 'training' | 'holdout'): FrozenCase[] {
  const rows = db.prepare(`SELECT case_id, role, situation, visible_evidence, options_json, expected_choice, case_version
    FROM cases WHERE dataset_id = ? AND role = ? ORDER BY case_id`).all(datasetId, role) as Array<{
    case_id: string;
    role: 'training' | 'holdout';
    situation: string;
    visible_evidence: string;
    options_json: string;
    expected_choice: string;
    case_version: number;
  }>;
  return rows.map((row) => ({
    case_id: row.case_id,
    role: row.role,
    situation: row.situation,
    visible_evidence: JSON.parse(row.visible_evidence) as string[],
    options: JSON.parse(row.options_json) as string[],
    expected_choice: row.expected_choice,
    case_version: row.case_version,
  }));
}

function baselineRulesFor(db: SqliteDatabase, standardId: string): StandardRule[] | null {
  const active = db.prepare('SELECT active_version FROM standards WHERE standard_id = ?').get(standardId) as {
    active_version: number | null;
  } | undefined;
  if (!active?.active_version) return null;
  const version = db.prepare('SELECT rules_json FROM standard_versions WHERE standard_id = ? AND version = ?').get(standardId, active.active_version) as {
    rules_json: string;
  } | undefined;
  if (!version) return null;
  return JSON.parse(version.rules_json) as StandardRule[];
}

function stageProposal(
  db: SqliteDatabase,
  principal: StandardsPrincipal,
  candidate: CandidateRow,
  report: ReportRow,
  stamped: string,
  now: () => Date,
): void {
  const standard = db.prepare('SELECT revision FROM standards WHERE standard_id = ?').get(candidate.standard_id) as { revision: number };
  const challengeToken = randomUUID();
  const challengeHash = sha256(challengeToken);
  const proposalHash = sha256(canonicalPayload({
    candidate_id: candidate.candidate_id,
    report_id: report.report_id,
    standard_id: candidate.standard_id,
    data_domain: candidate.data_domain,
    expected_revision: candidate.pointer_revision,
  }));
  const expiresAt = new Date(now().getTime() + 5 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO auth_challenges (
    challenge_id, account_id, purpose, challenge, challenge_hash, origin, rp_id, expires_at, consumed_at, created_at
  ) VALUES (?, ?, 'control', ?, ?, ?, ?, ?, NULL, ?)`).run(
    `ch_${randomUUID()}`,
    principal.account_id,
    challengeToken,
    challengeHash,
    CONTROL_ORIGIN,
    CONTROL_RP_ID,
    expiresAt,
    stamped,
  );
  db.prepare(`INSERT INTO control_proposals (
    proposal_id, account_id, proposal_hash, target, action, scope, base_revision, challenge_hash, expires_at, confirmed_at, created_at
  ) VALUES (?, ?, ?, ?, 'adopt_standard', ?, ?, ?, ?, NULL, ?)`).run(
    `prop_${randomUUID()}`,
    principal.account_id,
    proposalHash,
    candidate.standard_id,
    candidate.data_domain,
    standard.revision,
    challengeHash,
    expiresAt,
    stamped,
  );
}

function linkedEditId(
  db: SqliteDatabase,
  principal: StandardsPrincipal,
  domain: string,
  input: IngestedHead & { editId?: string | null },
): string | null {
  if (input.editId) {
    const chosen = db.prepare(`SELECT edit_id FROM edit_intents
      WHERE edit_id = ? AND account_id = ? AND data_domain = ? AND target_id = ? AND draft_key = ? AND closed_at IS NULL`).get(
      input.editId,
      principal.account_id,
      domain,
      input.standard_id,
      input.draft_key,
    ) as { edit_id: string } | undefined;
    if (!chosen) throw new Error('CONFLICT');
    return chosen.edit_id;
  }
  const edit = db.prepare(`SELECT edit_id FROM edit_intents
    WHERE account_id = ? AND data_domain = ? AND target_id = ? AND draft_key = ? AND closed_at IS NULL
    ORDER BY created_at DESC LIMIT 1`).get(principal.account_id, domain, input.standard_id, input.draft_key) as {
    edit_id: string;
  } | undefined;
  return edit?.edit_id ?? null;
}

function appendEditReceipt(
  db: SqliteDatabase,
  editId: string,
  business: 'adopted' | 'stale' | 'not_adopted',
  candidateId: string,
  resultRef: string,
  intentId: string | null,
  stamped: string,
): void {
  const latest = db.prepare(`SELECT receipt_revision, file_state, file_proof_ref FROM edit_receipts
    WHERE edit_id = ? ORDER BY receipt_revision DESC LIMIT 1`).get(editId) as {
    receipt_revision: number;
    file_state: string;
    file_proof_ref: string | null;
  } | undefined;
  if (!latest) return;
  db.prepare(`INSERT INTO edit_receipts (
    edit_id, receipt_revision, file_state, file_proof_ref, business_state, candidate_id, result_ref,
    projection_state, projection_intent_id, projection_revision, superseded_by, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`).run(
    editId,
    latest.receipt_revision + 1,
    latest.file_state,
    latest.file_proof_ref,
    business,
    candidateId,
    resultRef,
    business === 'adopted' ? 'pending' : 'not_due',
    intentId,
    stamped,
  );
}

function documentHead(db: SqliteDatabase, documentId: string): { observed_seq: number; content_hash: string } {
  const head = db.prepare('SELECT observed_seq, content_hash FROM vault_documents WHERE document_id = ? AND tombstone = 0').get(documentId) as {
    observed_seq: number;
    content_hash: string | null;
  } | undefined;
  if (!head?.content_hash) throw new Error('CONFLICT');
  return { observed_seq: head.observed_seq, content_hash: head.content_hash };
}

function evidenceWatermark(db: SqliteDatabase, domain: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(epoch), 0) AS epoch FROM withdrawal_events WHERE data_domain = ?').get(domain) as {
    epoch: number;
  };
  return row.epoch;
}

function permissionSnapshot(db: SqliteDatabase, principal: StandardsPrincipal, domain: string): string {
  const account = db.prepare('SELECT auth_epoch FROM accounts WHERE account_id = ?').get(principal.account_id) as {
    auth_epoch: number;
  } | undefined;
  const scopes = db.prepare(`SELECT permission FROM caller_scopes
    WHERE account_id = ? AND caller_id = ? AND data_domain = ? AND revoked_at IS NULL
    ORDER BY permission`).all(principal.account_id, principal.caller_id, domain) as { permission: string }[];
  const operations = scopes.length > 0 ? scopes.map((scope) => scope.permission) : [...principal.operations].sort();
  return sha256(canonicalPayload({
    account_id: principal.account_id,
    caller_id: principal.caller_id,
    data_domain: domain,
    auth_epoch: account?.auth_epoch ?? principal.auth_epoch,
    operations,
  }));
}

function requireCandidate(db: SqliteDatabase, candidateId: string): CandidateRow {
  const row = db.prepare(`SELECT candidate_id, standard_id, account_id, data_domain, draft_key, base_version, document_id,
      source_revision, content_hash, pointer_revision, rules_json, evidence_watermark, permission_hash, edit_id, status
    FROM standard_candidates WHERE candidate_id = ?`).get(candidateId) as CandidateRow | undefined;
  if (!row) throw new Error('NOT_FOUND');
  return row;
}

function requireReport(db: SqliteDatabase, reportId: string): ReportRow {
  const row = db.prepare(`SELECT report_id, candidate_id, standard_id, account_id, data_domain, dataset_id, policy_version,
      decision, training_correct, training_total, holdout_correct, holdout_total, baseline_correct, external_correct,
      threshold_thousandths, min_samples, budget_micros, source_revision, content_hash, evidence_watermark,
      permission_hash, base_version, pointer_revision
    FROM evaluation_reports WHERE report_id = ?`).get(reportId) as ReportRow | undefined;
  if (!row) throw new Error('NOT_FOUND');
  return row;
}

function candidateView(row: CandidateRow): Candidate {
  return {
    id: row.candidate_id,
    standard_id: row.standard_id,
    revision: row.pointer_revision,
    base_version: row.base_version,
    source_revision: row.source_revision,
    content_hash: row.content_hash,
    data_domain: row.data_domain,
  };
}

function reportView(row: ReportRow): ReportView {
  return {
    id: row.report_id,
    candidate_id: row.candidate_id,
    dataset_id: row.dataset_id,
    policy_version: row.policy_version,
    decision: row.decision,
    training_correct: row.training_correct,
    training_total: row.training_total,
    holdout_correct: row.holdout_correct,
    holdout_total: row.holdout_total,
    baseline_correct: row.baseline_correct,
    external_correct: row.external_correct,
    threshold_thousandths: row.threshold_thousandths,
    min_samples: row.min_samples,
    budget_micros: row.budget_micros,
    source_revision: row.source_revision,
    content_hash: row.content_hash,
    evidence_watermark: row.evidence_watermark,
    base_version: row.base_version,
  };
}

type BasisRow = {
  work_id: string;
  generation: number;
  account_id: string;
  data_domain: string;
  basis_hash: string;
  standards_json: string;
  external_method_id: string | null;
  external_method_revision: string | null;
  evidence_watermark: number;
};

function loadBasis(db: SqliteDatabase, workId: string, generation: number): BasisRow | undefined {
  return db.prepare(`SELECT work_id, generation, account_id, data_domain, basis_hash, standards_json,
      external_method_id, external_method_revision, evidence_watermark
    FROM judgment_bases WHERE work_id = ? AND generation = ?`).get(workId, generation) as BasisRow | undefined;
}

function basisView(row: BasisRow): JudgmentBasis {
  return {
    work_id: row.work_id,
    generation: row.generation,
    standards: JSON.parse(row.standards_json) as JudgmentBasis['standards'],
    external_method_id: row.external_method_id,
    external_method_revision: row.external_method_revision,
    hash: row.basis_hash,
    evidence_watermark: row.evidence_watermark,
  };
}

function renderStandard(input: {
  standardId: string;
  draftKey: string;
  rules: StandardRule[];
  note?: string;
  thresholdClaim?: number;
}): string {
  const claim = input.thresholdClaim === undefined ? '' : `,\n  "threshold_thousandths": ${input.thresholdClaim}`;
  const note = input.note ? `\n${input.note}\n` : '';
  return `---
patrick_id: ${input.draftKey}
kind: standard
standard_id: ${input.standardId}
base_version:
---

# 适用范围

产品需求判断

# 判断规则

\`\`\`json
{
  "rules": ${JSON.stringify(input.rules)}${claim}
}
\`\`\`

# 例外

普通功能冒充故障时仍先访谈

# 正反案例

# 依据
${note}草稿 ${input.draftKey}
`;
}

function safeSegment(value: string): string {
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..') || value.includes('\0')) throw new Error('UNPROCESSABLE');
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
