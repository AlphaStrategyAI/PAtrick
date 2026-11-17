import { createHash } from 'node:crypto';
import { canonicalPayload } from '@patrick/contracts';
import { appendDomainEvent, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { dispatchAllowed, type AdmissionPrincipal, type ExecutionGrant, type RunGrant } from './delegation.js';
import { createStandardsApi, type CaseOutcome } from './standards.js';
export type { CaseOutcome } from './standards.js';
import { deliveryEvidenceCurrent } from './work-continuation.js';

export type FrozenPrTarget = {
  repoId: string;
  headRepoId: string;
  branch: string;
  headSha: string;
  treeSha: string;
  baseRef: string;
};
export type ObservedPr = FrozenPrTarget & { number: number; currentBaseSha: string };
export type VerifiedPr = FrozenPrTarget & { number: number; verifiedBaseSha: string };

export function matchesPrIdentity(actual: ObservedPr, expected: FrozenPrTarget, number?: number | null): boolean {
  return actual.repoId === expected.repoId && actual.headRepoId === expected.headRepoId
    && actual.branch === expected.branch && actual.baseRef === expected.baseRef
    && (number == null || actual.number === number);
}

export function matchesBuiltArtifact(actual: FrozenPrTarget, expected: FrozenPrTarget): boolean {
  return actual.repoId === expected.repoId && actual.headRepoId === expected.headRepoId
    && actual.branch === expected.branch && actual.headSha === expected.headSha
    && actual.treeSha === expected.treeSha && actual.baseRef === expected.baseRef;
}

export function canVerifyFirstPublication(actual: ObservedPr, expected: FrozenPrTarget, frozenBaseSha: string): boolean {
  return matchesBuiltArtifact(actual, expected) && actual.currentBaseSha === frozenBaseSha;
}

export function matchesVerifiedPr(actual: ObservedPr, verified: VerifiedPr): boolean {
  return actual.number === verified.number && matchesBuiltArtifact(actual, verified);
}

export type ApprovedPrTarget = { owner: string; repo: string; repoId: string; baseRef: string };
export type BuiltArtifact = { headSha: string; treeSha: string; baseSha: string; title: string; body: string };
export type BuildCandidate = Pick<BuiltArtifact, 'title' | 'body'> & Partial<Pick<BuiltArtifact, 'baseSha' | 'headSha' | 'treeSha'>>;
type FreezeInput = { workId: string; generation: number; grant: RunGrant; caseId?: string; artifact?: BuiltArtifact };
export type BuildContext = {
  workId: string; generation: number; attemptId: string; grantId: string; sourceRevision: string; sourceHash: string; basisHash: string; evidenceWatermark: number; createdAt: string;
};
export type PlanMaterial = { contentHash: string; length: number; baseTree: string; authoredAt: string; message: string };
export type ApprovedPatch = { path: string; before: string | null; after: string; digest: string; material?: PlanMaterial };
export type BuildVerifier = (target: ApprovedPrTarget, context: BuildContext, candidate: BuildCandidate) => Promise<{ artifact: BuiltArtifact; patch: ApprovedPatch }>;
type BuildRow = { build_id: string; grant_id: string; attempt_id: string; source_revision_id: string; source_config_revision: number;
  source_hash: string; basis_hash: string; repo_id: string; base_ref: string; artifact: string; patch: string };
type BuildBasis = { root_id: string; revision_id: string; content_hash: string; config_revision: number; basis_hash: string; evidence_watermark: number; attempt_id: string; created_at: string };
type EffectStatus = 'pending' | 'blocked' | 'uncertain' | 'conflict' | 'verified';
export type EffectReceipt = {
  intentId: string;
  effectKey: string;
  status: EffectStatus;
  reason: string | null;
  remoteNumber: number | null;
  proof: VerifiedPr | null;
};
export type PrIntent = {
  intentId: string;
  effectKey: string;
  workId: string;
  generation: number;
  caseId: string;
  target: ApprovedPrTarget;
  frozen: FrozenPrTarget;
  artifact: BuiltArtifact;
  patch: ApprovedPatch;
  createdAt: string;
};
type IntentRow = {
  intent_id: string; effect_key: string; account_id: string; data_domain: string; work_id: string; generation: number;
  build_id: string; case_id: string; dataset_id: string; authorization_ref: string; authorization_epoch: number; resource: string; repo_id: string; repo_owner: string; repo_name: string;
  branch: string; base_ref: string; expected_remote_version: string; head_sha: string; tree_sha: string;
  title: string; body: string; payload_hash: string; created_at: string;
};
type ReceiptRow = {
  status: EffectStatus; reason: string | null; remote_number: number | null;
  verified_base_sha: string | null; verified_head_sha: string | null; verified_tree_sha: string | null;
};
type DispatchPhase = 'build_blob' | 'build_tree' | 'build_commit' | 'create_ref' | 'create_pr' | 'rebuild_tree' | 'rebuild_commit' | 'update_ref';
type RebuildRow = { rebuild_id: number; remote_number: number | null; parent_head_sha: string | null; observed_base_sha: string;
  base_tree_sha: string; replacement_tree_sha: string; replacement_head_sha: string; payload: string; applied_at: string | null };
export type GitTreeWrite = { base_tree: string; tree: Array<{ path: string; type: string; mode: string; sha: string }> };
export type GitCommitWrite = { message: string; tree: string; parents: string[];
  author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string } };
export type RebuildPayload = { tree: GitTreeWrite; commit: GitCommitWrite };

const action = 'publish_pr';
const sha = /^[0-9a-f]{40}$/;

export function createEffectRepository(db: SqliteDatabase, principal: AdmissionPrincipal,
  { target: approved, domain, now = () => new Date(), verifyBuild }: { target: ApprovedPrTarget; domain: string; now?: () => Date; verifyBuild?: BuildVerifier }) {
  // This target is supplied by trusted service configuration, never by a model, caller, or remote link.
  const target = { owner: approved.owner, repo: approved.repo, repoId: approved.repoId, baseRef: approved.baseRef };
  if (!/^[A-Za-z0-9-]+$/.test(target.owner) || !/^[A-Za-z0-9_.-]+$/.test(target.repo)
    || target.repo === '.' || target.repo === '..' || !/^[1-9][0-9]*$/.test(target.repoId) || !validBranch(target.baseRef)) {
    throw new Error('UNPROCESSABLE_TARGET');
  }
  const resource = `github:${target.repoId}`;
  const stamped = () => now().toISOString();
  const transaction = <T>(run: () => T): T => withImmediateTransaction(db, run);
  const standards = createStandardsApi(db, principal, { domain, now });

  function hasCurrentIdentity() {
    const account = db.prepare('SELECT auth_epoch FROM accounts WHERE account_id = ?').get(principal.account_id) as { auth_epoch: number } | undefined;
    return principal.domains.includes(domain) && account?.auth_epoch === principal.auth_epoch;
  }
  function requireIntent(intentId: string): IntentRow {
    const row = db.prepare(`SELECT * FROM effect_intents WHERE intent_id = ? AND account_id = ? AND data_domain = ?
      AND repo_id = ? AND repo_owner = ? AND repo_name = ? AND base_ref = ?`).get(
      intentId, principal.account_id, domain, target.repoId, target.owner, target.repo, target.baseRef,
    ) as IntentRow | undefined;
    if (!row || !hasCurrentIdentity()) throw new Error('NOT_FOUND');
    return row;
  }
  function ownsDispatch(intent: IntentRow): boolean {
    return !!db.prepare('SELECT 1 FROM execution_grants WHERE grant_id = ? AND caller_id = ?')
      .get(intent.authorization_ref, principal.caller_id);
  }

  function readReceipt(intent: IntentRow): EffectReceipt {
    const row = db.prepare('SELECT * FROM effect_receipts WHERE intent_id = ?').get(intent.intent_id) as ReceiptRow;
    const proof = row.status === 'verified' && row.remote_number !== null && row.verified_base_sha && row.verified_head_sha && row.verified_tree_sha
      ? { ...toIntent(intent, requireBuild(intent).patch).frozen, number: row.remote_number, verifiedBaseSha: row.verified_base_sha,
        headSha: row.verified_head_sha, treeSha: row.verified_tree_sha } : null;
    return { intentId: intent.intent_id, effectKey: intent.effect_key, status: row.status, reason: row.reason, remoteNumber: row.remote_number, proof };
  }

  function mayDispatch(workId: string, generation: number, grantId: string, stamp: string): boolean {
    const grant = db.prepare(`SELECT g.attempt_id, m.resources_json FROM execution_grants g
      JOIN work_generations w ON w.work_id = g.work_id AND w.generation = g.generation
      JOIN mandates m ON m.mandate_id = g.mandate_id AND m.mandate_id = w.mandate_id
      WHERE g.grant_id = ? AND g.subject_kind = 'work' AND g.account_id = ? AND g.data_domain = ? AND g.caller_id = ?
        AND g.work_id = ? AND g.generation = ? AND g.phase = 'delivery' AND g.next_action = @action
        AND g.permission_revision = m.revision AND g.attempt_id = w.current_attempt_id AND w.attempt_closed = 0
        AND w.account_id = g.account_id AND w.data_domain = g.data_domain AND w.next_action = @action AND w.evidence_ready = 1
        AND EXISTS (SELECT 1 FROM json_each(g.allowed_effects_json) WHERE value = @action)
        AND EXISTS (SELECT 1 FROM json_each(m.effects_json) WHERE value = @action)
        AND EXISTS (SELECT 1 FROM json_each(g.allowed_domains_json) WHERE value = g.data_domain)
        AND EXISTS (SELECT 1 FROM json_each(m.domains_json) WHERE value = g.data_domain)`).get(
      { action }, grantId, principal.account_id, domain, principal.caller_id, workId, generation,
    ) as { attempt_id: string; resources_json: string } | undefined;
    const permission = db.prepare(`SELECT 1 FROM caller_scopes
      WHERE account_id = ? AND caller_id = ? AND data_domain = ? AND permission = ? AND revoked_at IS NULL`)
      .get(principal.account_id, principal.caller_id, domain, action);
    return !!grant && !!permission && hasCurrentIdentity() && (JSON.parse(grant.resources_json) as string[]).includes(resource)
      && dispatchAllowed(db, principal, stamp, { grantId, attemptId: grant.attempt_id, businessId: `work:${workId}` })
      && deliveryEvidenceCurrent(db, principal, domain, workId, generation, grant.attempt_id, stamp);
  }

  function currentBuildBasis(workId: string, generation: number): BuildBasis | undefined {
    return db.prepare(`SELECT w.root_id, sr.revision_id, sr.content_hash, s.config_revision, b.basis_hash, b.evidence_watermark, w.current_attempt_id AS attempt_id, w.created_at
      FROM work_generations w JOIN judgment_bases b ON b.work_id = w.work_id AND b.generation = w.generation
      JOIN domain_events e ON e.event_id = w.root_id AND e.account_id = w.account_id AND e.data_domain = w.data_domain
      JOIN outbox o ON o.event_id = e.event_id AND o.destination = 'source-work'
      JOIN source_revisions sr ON e.event_id = 'work:' || sr.revision_id AND sr.object_id = e.aggregate_id AND sr.observed_seq = e.aggregate_version
      JOIN source_objects so ON so.source_id = sr.source_id AND so.object_id = sr.object_id AND so.observed_seq = sr.observed_seq
      JOIN source_configs s ON s.source_id = sr.source_id
      WHERE w.work_id = ? AND w.generation = ? AND w.account_id = ? AND w.data_domain = ?
      AND b.account_id = w.account_id AND b.data_domain = w.data_domain
      AND sr.account_id = w.account_id AND sr.data_domain = w.data_domain
      AND s.account_id = w.account_id AND s.data_domain = w.data_domain AND s.enabled = 1
      AND sr.tombstone = 0 AND so.tombstone = 0 AND json_extract(e.payload, '$.admitted') = 1`)
      .get(workId, generation, principal.account_id, domain) as BuildBasis | undefined;
  }

  function loadBuild(workId: string, generation: number): BuildRow | undefined {
    return db.prepare('SELECT * FROM work_pr_builds WHERE work_id = ? AND generation = ?').get(workId, generation) as BuildRow | undefined;
  }

  function requireBuild(intent: IntentRow): BuildRow {
    const build = loadBuild(intent.work_id, intent.generation);
    if (!build || build.build_id !== intent.build_id) throw new Error('INVALID_BUILD_PROOF');
    return build;
  }

  function buildCurrent(workId: string, generation: number, grantId: string, build: BuildRow): boolean {
    const basis = currentBuildBasis(workId, generation);
    return !!basis && build.grant_id === grantId && build.attempt_id === basis.attempt_id
      && build.source_revision_id === basis.revision_id && build.source_config_revision === basis.config_revision
      && build.source_hash === basis.content_hash && build.basis_hash === basis.basis_hash
      && build.repo_id === target.repoId && build.base_ref === target.baseRef;
  }

  function originalCase(basis: BuildBasis, stamp: string) {
    const caseId = 'work-case:' + hash(canonicalPayload([principal.account_id, domain, basis.root_id]));
    const datasetId = 'work-feedback:' + hash(canonicalPayload([principal.account_id, domain]));
    const policy = db.prepare(`SELECT policy_id, policy_version FROM evaluation_policies WHERE data_domain = ?
      ORDER BY policy_id, policy_version DESC LIMIT 1`).get(domain) as { policy_id: string; policy_version: number } | undefined;
    if (!policy) throw new Error('NO_WORK_CASE_POLICY');
    db.prepare(`INSERT INTO evaluation_datasets
      (dataset_id, data_domain, policy_id, policy_version, training_ids, holdout_ids, split_hash, schema_version, created_at)
      VALUES (?, ?, ?, ?, '[]', '[]', ?, '1.0', ?) ON CONFLICT DO NOTHING`)
      .run(datasetId, domain, policy.policy_id, policy.policy_version, hash(canonicalPayload([[], []])), stamp);
    db.prepare(`INSERT INTO cases
      (dataset_id, case_id, data_domain, role, situation, visible_evidence, options_json, expected_choice, case_version, schema_version, created_at)
      VALUES (?, ?, ?, 'training', ?, ?, '[]', 'unobserved', 1, '1.0', ?) ON CONFLICT DO NOTHING`)
      .run(datasetId, caseId, domain, basis.root_id, basis.revision_id, stamp);
    db.prepare(`INSERT INTO work_pr_cases (root_id, dataset_id, case_id, source_revision_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(basis.root_id, datasetId, caseId, basis.revision_id);
    return { datasetId, caseId };
  }

  function mark(intent: IntentRow, status: Exclude<EffectStatus, 'verified'>, reason: string | null, number: number | null = null) {
    db.prepare(`UPDATE effect_receipts SET status = ?, reason = ?, remote_number = COALESCE(remote_number, ?), updated_at = ?
      WHERE intent_id = ? AND status NOT IN ('verified', 'conflict', 'blocked')`).run(status, reason, number, stamped(), intent.intent_id);
    return readReceipt(intent);
  }

  function loadRebuild(intentId: string, activeOnly = false) {
    return db.prepare(`SELECT * FROM effect_pr_rebuilds WHERE intent_id = ? ${activeOnly ? 'AND applied_at IS NOT NULL' : ''}
      ORDER BY rebuild_id DESC LIMIT 1`).get(intentId) as RebuildRow | undefined;
  }

  function resolvedIntent(row: IntentRow): PrIntent {
    const intent = toIntent(row, requireBuild(row).patch);
    const active = loadRebuild(row.intent_id, true);
    if (active?.replacement_head_sha && active.replacement_tree_sha) {
      intent.artifact = { ...intent.artifact, baseSha: active.observed_base_sha, headSha: active.replacement_head_sha, treeSha: active.replacement_tree_sha };
      intent.frozen = { ...intent.frozen, headSha: active.replacement_head_sha, treeSha: active.replacement_tree_sha };
    }
    return intent;
  }

  return {
    // Called by the fixed service build producer. No public or model tool exposes this port.
    async prepareBuild(input: { workId: string; generation: number; grant: RunGrant; artifact: BuildCandidate }): Promise<string> {
      const { workId, generation, grant } = input;
      const supplied = { ...input.artifact };
      assertArtifact(supplied);
      if (!verifyBuild || grant.subject_kind !== 'work' || !mayDispatch(workId, generation, grant.grant_id, stamped())) throw new Error('DENIED');
      const basis = currentBuildBasis(workId, generation);
      if (!basis || !basis.attempt_id || basis.attempt_id !== grant.attempt_id) throw new Error('SOURCE_NOT_CURRENT');
      const { artifact, patch } = await verifyBuild({ ...target }, {
        workId, generation, attemptId: basis.attempt_id, grantId: grant.grant_id, sourceRevision: basis.revision_id, sourceHash: basis.content_hash, basisHash: basis.basis_hash, evidenceWatermark: basis.evidence_watermark, createdAt: basis.created_at,
      }, supplied);
      return transaction(() => {
        const stamp = stamped();
        const candidate: BuildRow = { build_id: '', grant_id: grant.grant_id, attempt_id: basis.attempt_id,
          source_revision_id: basis.revision_id, source_config_revision: basis.config_revision, source_hash: basis.content_hash,
          basis_hash: basis.basis_hash, repo_id: target.repoId, base_ref: target.baseRef,
          artifact: canonicalPayload(artifact), patch: canonicalPayload(patch) };
        if (!mayDispatch(workId, generation, grant.grant_id, stamp) || !buildCurrent(workId, generation, grant.grant_id, candidate)) throw new Error('DENIED');
        const buildId = 'build:' + hash(canonicalPayload([workId, generation, candidate]));
        const prior = loadBuild(workId, generation);
        if (prior && prior.build_id !== buildId) throw new Error('CONFLICT');
        if (patch.material) db.prepare('INSERT INTO blobs (sha256, byte_length, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
          .run(patch.material.contentHash, patch.material.length, stamp);
        db.prepare(`INSERT INTO work_pr_builds (build_id, work_id, generation, grant_id, attempt_id, source_revision_id,
          source_config_revision, source_hash, basis_hash, repo_id, base_ref, artifact, patch, output_hash, verified_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .run(buildId, workId, generation, candidate.grant_id, candidate.attempt_id, candidate.source_revision_id, candidate.source_config_revision,
            candidate.source_hash, candidate.basis_hash, target.repoId, target.baseRef, candidate.artifact, candidate.patch, patch.material?.contentHash ?? null, stamp);
        return originalCase(basis, stamp).caseId;
      });
    },

    freezePr(input: FreezeInput): EffectReceipt {
      if (input.grant.subject_kind !== 'work') throw new Error('DENIED');
      const grantId = input.grant.grant_id;
      const { workId, generation } = input;
      return transaction(() => {
        const stamp = stamped();
        if (!mayDispatch(workId, generation, grantId, stamp)) throw new Error('DENIED');
        const build = loadBuild(workId, generation);
        const basis = currentBuildBasis(workId, generation);
        if (!build || !basis || !buildCurrent(workId, generation, grantId, build)) throw new Error('BUILD_PROOF_REQUIRED');
        const original = db.prepare(`SELECT p.case_id, p.dataset_id FROM work_pr_cases p JOIN cases c USING (dataset_id, case_id)
          WHERE p.root_id = ? AND p.source_revision_id = ? AND c.data_domain = ?`).get(basis.root_id, basis.revision_id, domain) as
          { case_id: string; dataset_id: string } | undefined;
        if (!original) throw new Error('WORK_CASE_REQUIRED');
        const { case_id: caseId, dataset_id: datasetId } = original;
        if ((input.caseId !== undefined && input.caseId !== caseId)
          || (input.artifact !== undefined && canonicalPayload(input.artifact) !== build.artifact)) throw new Error('CONFLICT');
        const { headSha, treeSha, baseSha, title, body } = JSON.parse(build.artifact) as BuiltArtifact;
        const effectKey = hash(canonicalPayload([principal.account_id, domain, workId, generation, action]));
        const branch = `patrick/${effectKey}`;
        const intentId = `effect_${effectKey}`;
        const payloadHash = hash(canonicalPayload({ caseId, datasetId, ...target, branch, headSha, treeSha, baseSha, title, body }));
        const old = db.prepare('SELECT * FROM effect_intents WHERE effect_key = ?').get(effectKey) as IntentRow | undefined;
        if (old) {
          if (old.payload_hash !== payloadHash || old.authorization_ref !== grantId) throw new Error('CONFLICT');
          return readReceipt(old);
        }
        db.prepare(`INSERT INTO effect_intents (intent_id, effect_key, account_id, data_domain, work_id, generation,
          origin, action, authorization_ref, authorization_epoch, resource, repo_id, repo_owner, repo_name, branch, base_ref, expected_remote_version,
          head_sha, tree_sha, title, body, payload_hash, dataset_id, case_id, build_id, created_at, schema_version)
          VALUES (?, ?, ?, ?, ?, ?, 'business', 'publish_pr', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0')`).run(
          intentId, effectKey, principal.account_id, domain, workId, generation, grantId, principal.auth_epoch, resource, target.repoId, target.owner,
          target.repo, branch, target.baseRef, baseSha, headSha, treeSha, title, body, payloadHash, datasetId, caseId, build.build_id, stamp,
        );
        db.prepare("INSERT INTO effect_receipts (intent_id, status, updated_at) VALUES (?, 'pending', ?)").run(intentId, stamp);
        return readReceipt(requireIntent(intentId));
      });
    },

    intent(intentId: string): PrIntent {
      const intent = requireIntent(intentId);
      return resolvedIntent(intent);
    },

    receipt(intentId: string): EffectReceipt {
      return readReceipt(requireIntent(intentId));
    },

    ownsDispatch(intentId: string): boolean {
      return ownsDispatch(requireIntent(intentId));
    },

    hasDispatch(intentId: string): boolean {
      requireIntent(intentId);
      return !!db.prepare('SELECT 1 FROM effect_dispatches WHERE intent_id = ? LIMIT 1').get(intentId);
    },

    dispatchVersion(intentId: string, phase: DispatchPhase, rebuildId?: number): string | null {
      requireIntent(intentId);
      const permit = db.prepare('SELECT expected_remote_version FROM effect_dispatches WHERE intent_id = ? AND phase = ? AND operation_key = ?')
        .get(intentId, phase, String(rebuildId ?? 'initial')) as { expected_remote_version: string } | undefined;
      return permit?.expected_remote_version ?? null;
    },

    claimSend(intentId: string, phase: DispatchPhase, expectedRemoteVersion: string, rebuildId?: number, expectedHead?: string): boolean {
      return transaction(() => {
        const intent = requireIntent(intentId);
        const receipt = readReceipt(intent);
        if ((expectedHead !== undefined && phase !== 'create_pr')
          || !ownsDispatch(intent) || (receipt.status !== 'pending' && receipt.status !== 'uncertain')) return false;
        const stamp = stamped();
        if (intent.authorization_epoch !== principal.auth_epoch
          || !mayDispatch(intent.work_id, intent.generation, intent.authorization_ref, stamp)
          || !buildCurrent(intent.work_id, intent.generation, intent.authorization_ref, requireBuild(intent))) {
          const prior = db.prepare('SELECT 1 FROM effect_dispatches WHERE intent_id = ?').get(intentId);
          mark(intent, prior ? 'uncertain' : 'blocked', 'dispatch_denied');
          return false;
        }
        const plan = loadRebuild(intentId);
        const createPermit = db.prepare("SELECT 1 FROM effect_dispatches WHERE intent_id = ? AND phase = 'create_pr'").get(intentId);
        if (phase === 'build_blob' || phase === 'build_tree' || phase === 'build_commit') {
          const built = toIntent(intent, requireBuild(intent).patch);
          const expected = phase === 'build_blob' ? built.patch.after : phase === 'build_tree' ? built.artifact.treeSha : built.artifact.headSha;
          if (!built.patch.material || createPermit || receipt.remoteNumber !== null || rebuildId !== undefined || expectedRemoteVersion !== expected) return false;
        } else if (phase === 'create_ref' || phase === 'create_pr') {
          const active = resolvedIntent(intent);
          const expected = phase === 'create_ref' ? active.frozen.headSha : active.artifact.baseSha;
          if (rebuildId !== undefined || receipt.remoteNumber !== null || expectedRemoteVersion !== expected
            || (phase === 'create_pr' && expectedHead !== active.frozen.headSha) || (plan && !plan.applied_at) || createPermit) return false;
        } else {
          if (!plan || plan.applied_at || plan.rebuild_id !== rebuildId || plan.remote_number !== receipt.remoteNumber
            || !!createPermit !== (plan.remote_number !== null)) return false;
          if (phase === 'rebuild_tree' && plan.replacement_tree_sha !== expectedRemoteVersion) return false;
          if (phase === 'rebuild_commit' && plan.replacement_head_sha !== expectedRemoteVersion) return false;
          if (phase === 'update_ref' && (plan.parent_head_sha !== expectedRemoteVersion || !plan.replacement_head_sha)) return false;
        }
        const claim = db.prepare(`INSERT INTO effect_dispatches
          (intent_id, phase, expected_remote_version, authorization_ref, created_at, operation_key, expected_head_sha)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(intent_id, phase, operation_key) DO NOTHING`).run(
          intentId, phase, expectedRemoteVersion, intent.authorization_ref, stamp, String(rebuildId ?? 'initial'), expectedHead ?? null,
        );
        if (claim.changes !== 1) return false;
        mark(intent, 'uncertain', phase);
        return true;
      });
    },

    mark(intentId: string, status: Exclude<EffectStatus, 'verified'>, reason: string, number?: number) {
      return transaction(() => {
        const intent = requireIntent(intentId);
        const existing = readReceipt(intent);
        if (number !== undefined && existing.remoteNumber !== null && number !== existing.remoteNumber) {
          return mark(intent, 'conflict', 'identity_anomaly');
        }
        const receipt = mark(intent, status, reason, number);
        if (receipt.status === 'uncertain' && status === 'uncertain'
          && reason !== 'awaiting_readback' && reason !== 'awaiting_verification') {
          const eventId = `effect.uncertain:${intentId}`;
          if (!db.prepare('SELECT 1 FROM domain_events WHERE event_id = ?').get(eventId)) {
            appendDomainEvent(db, {
              eventId, aggregateId: intent.work_id, aggregateVersion: intent.generation, accountId: principal.account_id,
              dataDomain: domain, destination: 'local',
              payload: { type: 'effect.uncertain', intent_id: intentId, work_id: intent.work_id, generation: intent.generation, reason },
            });
          }
        }
        return receipt;
      });
    },

    rebuild(intentId: string): RebuildRow | undefined {
      requireIntent(intentId);
      return loadRebuild(intentId);
    },

    prepareRebuild(intentId: string, input: { number: number | null; headSha: string | null; baseSha: string; baseTree: string;
      expectedTree: string; expectedHead: string; payload: RebuildPayload }): RebuildRow {
      return transaction(() => {
        const intent = requireIntent(intentId);
        const receipt = readReceipt(intent);
        const createPermit = db.prepare("SELECT 1 FROM effect_dispatches WHERE intent_id = ? AND phase = 'create_pr'").get(intentId);
        if (!['pending', 'uncertain'].includes(receipt.status) || receipt.remoteNumber !== input.number
          || !!createPermit !== (input.number !== null)
          || ![input.baseSha, input.baseTree, input.expectedTree, input.expectedHead].every((value) => sha.test(value))
          || (input.headSha !== null && !sha.test(input.headSha))) throw new Error('CONFLICT');
        const encoded = canonicalPayload(input.payload);
        const previous = loadRebuild(intentId);
        if (previous && (!previous.applied_at || previous.remote_number !== null)) {
          if (previous.remote_number !== input.number || previous.parent_head_sha !== input.headSha
            || previous.observed_base_sha !== input.baseSha || previous.base_tree_sha !== input.baseTree || previous.replacement_tree_sha !== input.expectedTree
            || previous.replacement_head_sha !== input.expectedHead || previous.payload !== encoded) throw new Error('CONFLICT');
          return previous;
        }
        db.prepare(`INSERT INTO effect_pr_rebuilds (intent_id, remote_number, parent_head_sha, observed_base_sha, base_tree_sha,
          patch_digest, source_revision_id, replacement_tree_sha, replacement_head_sha, payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(intentId, input.number, input.headSha, input.baseSha, input.baseTree,
          resolvedIntent(intent).patch.digest, requireBuild(intent).source_revision_id, input.expectedTree, input.expectedHead, encoded, stamped());
        return loadRebuild(intentId)!;
      });
    },

    activateReplacement(intentId: string, rebuildId: number, head: string, tree: string, base: string): void {
      transaction(() => {
        requireIntent(intentId);
        const result = db.prepare(`UPDATE effect_pr_rebuilds SET applied_at = ? WHERE rebuild_id = ? AND intent_id = ? AND applied_at IS NULL
          AND replacement_head_sha = ? AND replacement_tree_sha = ? AND observed_base_sha = ?`).run(stamped(), rebuildId, intentId, head, tree, base);
        if (result.changes !== 1) throw new Error('CONFLICT');
      });
    },

    verify(intentId: string, actual: ObservedPr, frozenBaseSha: string): EffectReceipt {
      return transaction(() => {
        const intent = requireIntent(intentId);
        const existing = readReceipt(intent);
        if (existing.status !== 'uncertain') return existing;
        const pendingRebuild = loadRebuild(intentId);
        if (pendingRebuild && !pendingRebuild.applied_at) return mark(intent, 'uncertain', 'replacement_unresolved');
        const expected = resolvedIntent(intent).frozen;
        if (!matchesPrIdentity(actual, expected, existing.remoteNumber)) return mark(intent, 'conflict', 'identity_anomaly');
        if (!canVerifyFirstPublication(actual, expected, frozenBaseSha)) return mark(intent, 'uncertain', 'artifact_or_base_changed', actual.number);
        const reused = db.prepare(`SELECT 1 FROM effect_receipts r JOIN effect_intents i USING (intent_id)
          WHERE r.status = 'verified' AND i.repo_id = ? AND r.remote_number = ? AND i.intent_id <> ?`)
          .get(intent.repo_id, actual.number, intentId);
        if (reused) return mark(intent, 'conflict', 'pr_already_bound');
        const stamp = stamped();
        const sent = db.prepare("SELECT 1 FROM effect_dispatches WHERE intent_id = ? AND phase = 'create_pr'").get(intentId);
        if (!sent && !ownsDispatch(intent)) return existing;
        if (!sent && (intent.authorization_epoch !== principal.auth_epoch
          || !mayDispatch(intent.work_id, intent.generation, intent.authorization_ref, stamp)
          || !buildCurrent(intent.work_id, intent.generation, intent.authorization_ref, requireBuild(intent)))) {
          return mark(intent, 'blocked', 'dispatch_denied');
        }
        db.prepare(`UPDATE effect_receipts SET status = 'verified', reason = NULL, remote_number = ?, verified_base_sha = ?,
          verified_head_sha = ?, verified_tree_sha = ?, updated_at = ? WHERE intent_id = ?`).run(
          actual.number, frozenBaseSha, actual.headSha, actual.treeSha, stamp, intentId,
        );
        db.prepare('INSERT INTO outcome_watches (intent_id, dataset_id, case_id, remote_ref) VALUES (?, ?, ?, ?)')
          .run(intentId, intent.dataset_id, intent.case_id, remoteRef(actual));
        const eventId = `work.delivered:${hash(canonicalPayload([principal.account_id, domain, intent.work_id]))}`;
        if (!db.prepare('SELECT 1 FROM domain_events WHERE event_id = ?').get(eventId)) {
          db.prepare("INSERT INTO stage_events (event_id, work_id, generation, kind, created_at) VALUES (?, ?, ?, 'work.delivered', ?)")
            .run(eventId, intent.work_id, intent.generation, stamp);
          appendDomainEvent(db, {
            eventId, aggregateId: intent.work_id, aggregateVersion: intent.generation, accountId: principal.account_id,
            dataDomain: domain, payload: { type: 'work.delivered', work_id: intent.work_id, generation: intent.generation,
              intent_id: intentId, case_id: intent.case_id, remote_ref: remoteRef(actual), proof: readReceipt(intent).proof },
            destination: 'local',
          });
        }
        return readReceipt(intent);
      });
    },

    buildCandidatesAfter(cursor: string, limit: number): ExecutionGrant[] {
      const stamp = stamped();
      const rows = db.prepare(`SELECT g.grant_id, g.work_id, g.generation, g.attempt_id, g.mandate_id, g.basis_hash,
          g.collection_id, g.expires_at
        FROM execution_grants g JOIN work_generations w ON w.work_id = g.work_id AND w.generation = g.generation
        JOIN mandates m ON m.mandate_id = g.mandate_id AND m.mandate_id = w.mandate_id
        WHERE g.grant_id > ? AND g.account_id = ? AND g.data_domain = ? AND g.caller_id = ?
          AND g.subject_kind = 'work' AND g.phase = 'delivery' AND g.next_action = 'publish_pr'
          AND g.revoked_at IS NULL AND g.expires_at > ? AND g.attempt_id = w.current_attempt_id
          AND w.account_id = g.account_id AND w.data_domain = g.data_domain AND w.next_action = 'publish_pr'
          AND w.attempt_closed = 0 AND w.evidence_ready = 1 AND w.control_state = 'running'
          AND EXISTS (SELECT 1 FROM json_each(m.resources_json) WHERE value = ?)
          AND NOT EXISTS (SELECT 1 FROM effect_intents i WHERE i.work_id = w.work_id AND i.generation = w.generation)
        ORDER BY g.grant_id LIMIT ?`).all(cursor, principal.account_id, domain, principal.caller_id, stamp, resource, limit) as
        Array<Omit<ExecutionGrant, 'subject_kind' | 'phase' | 'next_action' | 'allowed_effects'>>;
      return rows.map((row) => ({ ...row, subject_kind: 'work', phase: 'delivery', next_action: 'publish_pr', allowed_effects: ['publish_pr'] }));
    },

    pendingAfter(cursor: string, limit: number) {
      return db.prepare(`SELECT i.intent_id FROM effect_intents i JOIN effect_receipts r USING (intent_id)
        JOIN execution_grants g ON g.grant_id = i.authorization_ref
        WHERE i.account_id = ? AND i.data_domain = ? AND i.repo_id = ? AND i.repo_owner = ? AND i.repo_name = ? AND i.base_ref = ?
          AND g.caller_id = ? AND i.intent_id > ? AND r.status IN ('pending', 'uncertain')
        ORDER BY i.intent_id LIMIT ?`).all(principal.account_id, domain, target.repoId, target.owner, target.repo, target.baseRef,
          principal.caller_id, cursor, limit) as
        { intent_id: string }[];
    },

    watchesAfter(cursor: string, limit: number) {
      return db.prepare(`SELECT w.intent_id, w.case_id, w.remote_ref FROM outcome_watches w JOIN effect_intents i USING (intent_id)
        WHERE i.account_id = ? AND i.data_domain = ? AND i.repo_id = ? AND i.repo_owner = ? AND i.repo_name = ? AND i.base_ref = ?
          AND w.intent_id > ?
        ORDER BY w.intent_id LIMIT ?`).all(principal.account_id, domain, target.repoId, target.owner, target.repo, target.baseRef, cursor, limit) as
        { intent_id: string; case_id: string; remote_ref: string }[];
    },

    markWatchRevision(intentId: string, revision: string) {
      transaction(() => {
        const intent = requireIntent(intentId);
        if (readReceipt(intent).status !== 'verified') throw new Error('CONFLICT');
        db.prepare(`UPDATE outcome_watches SET observed_revision = ? WHERE intent_id = ?
          AND (observed_revision IS NULL OR observed_revision < ?)`).run(revision, intentId, revision);
      });
    },

    intentForOutcome(caseId: string, ref: string): PrIntent {
      const match = /^github:([1-9][0-9]*)\/pull\/([1-9][0-9]*)$/.exec(ref);
      if (!match || match[1] !== target.repoId || !Number.isSafeInteger(Number(match[2]))) throw new Error('NOT_FOUND');
      const found = db.prepare(`SELECT i.intent_id FROM effect_intents i JOIN effect_receipts r USING (intent_id)
        WHERE i.account_id = ? AND i.data_domain = ? AND i.case_id = ? AND i.repo_id = ?
          AND r.status = 'verified' AND r.remote_number = ?`).get(principal.account_id, domain, caseId, target.repoId, Number(match[2])) as
        { intent_id: string } | undefined;
      if (!found) throw new Error('NOT_FOUND');
      return this.intent(found.intent_id);
    },

    async recordOutcome(intentId: string, outcome: CaseOutcome): Promise<void> {
      const original = requireIntent(intentId);
      await standards.recordOutcome(original.case_id, outcome, (outcomeId, datasetId) => {
        const intent = requireIntent(intentId);
        const proof = readReceipt(intent).proof;
        if (!proof || intent.dataset_id !== datasetId || outcome.source !== remoteRef(proof)) throw new Error('CONFLICT');
        const eventId = `outcome.observed:${outcomeId}`;
        if (db.prepare('SELECT 1 FROM domain_events WHERE event_id = ?').get(eventId)) return;
        appendDomainEvent(db, {
          eventId, aggregateId: intent.work_id, aggregateVersion: intent.generation, accountId: principal.account_id,
          dataDomain: domain, destination: 'local',
          payload: { type: 'outcome.observed', intent_id: intentId, case_id: intent.case_id, work_id: intent.work_id, ...outcome },
        });
      });
    },

    observe(intentId: string, kind: 'head_changed' | 'identity_anomaly', key: string, observedAt: string) {
      transaction(() => {
        const intent = requireIntent(intentId);
        if (readReceipt(intent).status !== 'verified') throw new Error('CONFLICT');
        db.prepare(`INSERT INTO effect_observations (intent_id, observation_key, kind, observed_at)
          VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(intentId, hash(canonicalPayload([kind, key])), kind, observedAt);
      });
    },
  };
}

export type EffectRepository = ReturnType<typeof createEffectRepository>;

export function remoteRef(pr: { repoId: string; number: number }): string {
  return `github:${pr.repoId}/pull/${pr.number}`;
}

function toIntent(row: IntentRow, patch: string): PrIntent {
  return {
    intentId: row.intent_id, effectKey: row.effect_key, workId: row.work_id, generation: row.generation, caseId: row.case_id,
    target: { owner: row.repo_owner, repo: row.repo_name, repoId: row.repo_id, baseRef: row.base_ref },
    frozen: { repoId: row.repo_id, headRepoId: row.repo_id, branch: row.branch,
      headSha: row.head_sha, treeSha: row.tree_sha, baseRef: row.base_ref },
    artifact: { headSha: row.head_sha, treeSha: row.tree_sha, baseSha: row.expected_remote_version, title: row.title, body: row.body },
    patch: JSON.parse(patch) as ApprovedPatch, createdAt: row.created_at,
  };
}

function assertArtifact(artifact: BuildCandidate): void {
  if ((artifact.baseSha !== undefined && !sha.test(artifact.baseSha)) || ((artifact.headSha !== undefined || artifact.treeSha !== undefined)
    && ![artifact.headSha, artifact.treeSha, artifact.baseSha].every((value) => typeof value === 'string' && sha.test(value)))
    || !artifact.title.trim() || artifact.title.length > 256 || artifact.body.length > 65000) throw new Error('UNPROCESSABLE_ARTIFACT');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validBranch(ref: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,239}$/.test(ref) && !ref.includes('..')
    && ref.split('/').every((segment) => segment && !segment.startsWith('.') && !segment.endsWith('.lock') && !segment.endsWith('.'));
}
