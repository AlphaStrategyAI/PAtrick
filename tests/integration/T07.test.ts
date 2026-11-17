import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import { createStandardsApi, ADOPT_STANDARD_SQL, type StandardRule, type StandardsPrincipal } from '../../packages/domain/src/standards.js';
import { decideTraining, scoreTrainingOnly } from '../../packages/domain/src/evaluation.js';
import { createVaultApi } from '../../packages/integrations/vault/drafts.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';
import { createApp } from '../../apps/service/src/app.js';
import { issueBootstrapTicket, issueCallerSession, ORIGIN } from '../../apps/service/src/auth.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';

const NOW = '2026-11-16T12:00:00.000Z';
const DOMAIN = 'product';
const MIGRATIONS = fileURLToPath(new URL('../../packages/storage/migrations/', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../fixtures/evaluation/product/manifest.json', import.meta.url));
const PREVIOUS = {
  '0002_core.sql': '6e82bac75d455f28dc498874b61d0d778e1552b4bc5a8d1b5d7f5dfddfc06233',
  '0003_auth_control.sql': '3767d19a3f6c65f5ddae4f5f7d65a057082bfc978fec2d7e7a7a347f4cf2487f',
  '0004_hub_work.sql': 'bcd83075a607244bf5e5ee89efc621d0dd7670e42ace2b5884874ee8047dbcbe',
  '0005_sources.sql': '8bd6d4ee8e06b94247d314030acaf0b312b635a8fccdc457267afdfdc3c22f29',
  '0006_vault_evidence.sql': '320c91d5935e2586a28aee0ba9a5e5a94eb0ee2036931244b9674ad09782f2f1',
} as const;

const owner: StandardsPrincipal = {
  account_id: 'owner',
  caller_id: 'web',
  auth_epoch: 1,
  domains: [DOMAIN],
  operations: ['owner', 'standards.write', 'standards.read'],
};

const editor = {
  account_id: 'owner',
  caller_id: 'web',
  auth_epoch: 1,
  authenticated_at: NOW,
  domains: [DOMAIN],
  operations: ['owner', 'edits.write'],
};

type Api = ReturnType<typeof createStandardsApi>;
type Candidate = Awaited<ReturnType<Api['openCandidate']>>;

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function temporaryDatabase(): { dir: string; db: SqliteDatabase; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t07-'));
  const db = openDatabase(join(dir, 'patrick.sqlite'));
  return {
    dir,
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function apiFor(db: SqliteDatabase, principal: StandardsPrincipal = owner): Api {
  return createStandardsApi(db, principal, { now: () => new Date(NOW), domain: DOMAIN });
}

async function connectProduct(db: SqliteDatabase, root: string): Promise<string> {
  const vault = createVaultApi(db, {
    blobs: createBlobStore(join(root, '..', 'blobs')),
    now: () => new Date(NOW),
    captureHost: 'mac-mini',
  });
  const vaultId = 'vault-product';
  await vault.connectVault({ accountId: 'owner', deviceId: 'mac-mini', vaultId, root, domain: DOMAIN });
  await vault.confirmVault('mac-mini', vaultId);
  return vaultId;
}

function passingRules(): StandardRule[] {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { candidate_rules: StandardRule[] };
  return fixture.candidate_rules;
}

async function ready(principal: StandardsPrincipal = owner) {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(root, { recursive: true });
  const vaultId = await connectProduct(fx.db, root);
  const api = apiFor(fx.db, principal);
  const seeded = await api.seedProductDataset();
  return { fx, api, vaultId, seeded };
}

test('ten seed cases and five holdout cases stay split, and a stale r8 report cannot adopt r9', async () => {
  const { fx, api, vaultId, seeded } = await ready();
  try {
    expect(seeded.training).toBe(10);
    expect(seeded.holdout).toBe(5);
    expect(new Set([...seeded.training_ids, ...seeded.holdout_ids]).size).toBe(15);
    const vaultCases = fx.db.prepare(`SELECT relative_path FROM vault_documents WHERE data_domain = ?`).all(DOMAIN) as { relative_path: string }[];
    for (const caseId of [...seeded.training_ids, ...seeded.holdout_ids]) {
      expect(vaultCases.some((row) => row.relative_path.includes(caseId))).toBe(false);
    }

    const first = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-demand',
      draftKey: 'demand-v1',
      rules: passingRules(),
    }));
    expect(await api.activeStandardVersion(first.standard_id)).toBeNull();
    expect(await api.activeStandardCount()).toBe(0);
    const firstReport = await api.evaluate(first, { version: 1 });
    expect(firstReport.decision).toBe('pass');
    expect(firstReport.training_total).toBe(10);
    expect(firstReport.holdout_total).toBe(5);
    expect(firstReport.holdout_correct).toBeLessThan(firstReport.holdout_total);
    expect(await api.adoptStandard(first.id, firstReport.id, first.revision)).toBe('adopted');
    expect(await api.activeStandardVersion(first.standard_id)).toBe(1);
    expect(await api.activeStandardCount()).toBe(1);

    let candidateR8: Candidate | undefined;
    for (let revision = 1; revision <= 8; revision += 1) {
      const ingested = await api.ingestStandardDraft({
        vaultId,
        standardId: first.standard_id,
        draftKey: 'demand-r8',
        rules: passingRules(),
        note: `修订 ${revision}`,
      });
      expect(ingested.source_revision).toBe(revision);
      if (revision === 8) candidateR8 = await api.openCandidate({ ...ingested, baseVersion: 1 });
    }
    if (!candidateR8) throw new Error('missing r8 candidate');
    const frozenPolicy = { version: 1 };
    const report = await api.evaluate(candidateR8, frozenPolicy);
    const revisionR9 = await api.ingestStandardDraft({
      vaultId,
      standardId: first.standard_id,
      draftKey: 'demand-r8',
      rules: passingRules(),
      note: '修订 9',
    });
    expect(revisionR9.source_revision).toBe(9);
    expect(await api.adoptStandard(candidateR8.id, report.id, candidateR8.revision)).toBe('stale');
    expect(await api.activeStandardVersion(candidateR8.standard_id)).toBe(1);
    expect(await api.activeStandardCount()).toBe(1);
    expect(fx.db.prepare('SELECT decision, source_revision FROM evaluation_reports WHERE report_id = ?').get(report.id)).toEqual({
      decision: 'pass',
      source_revision: 8,
    });
  } finally {
    fx.close();
  }
});

test('a later baseline change keeps the old report and does not adopt it', async () => {
  const { fx, api, vaultId } = await ready();
  try {
    const first = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-base',
      draftKey: 'base',
      rules: passingRules(),
    }));
    const adopted = await api.evaluate(first, { version: 1 });
    expect(await api.adoptStandard(first.id, adopted.id, first.revision)).toBe('adopted');

    const leftHead = await api.ingestStandardDraft({
      vaultId,
      standardId: first.standard_id,
      draftKey: 'base-left',
      rules: passingRules(),
    });
    const rightHead = await api.ingestStandardDraft({
      vaultId,
      standardId: first.standard_id,
      draftKey: 'base-right',
      rules: passingRules(),
    });
    const left = await api.openCandidate({ ...leftHead, baseVersion: 1 });
    const right = await api.openCandidate({ ...rightHead, baseVersion: 1 });
    const oldReport = await api.evaluate(left, { version: 1 });
    const other = await api.evaluate(right, { version: 1 });
    const before = JSON.stringify(await api.getEvaluation(oldReport.id));
    expect(await api.adoptStandard(right.id, other.id, right.revision)).toBe('adopted');
    expect(await api.adoptStandard(left.id, oldReport.id, left.revision)).toBe('stale');
    expect(JSON.stringify(await api.getEvaluation(oldReport.id))).toBe(before);
    expect(await api.activeStandardVersion(first.standard_id)).toBe(2);
    expect(await api.activeStandardCount()).toBe(1);
  } finally {
    fx.close();
  }
});

test('a future outcome does not change a frozen report', async () => {
  const { fx, api, vaultId, seeded } = await ready();
  try {
    const candidate = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-outcome',
      draftKey: 'outcome',
      rules: passingRules(),
    }));
    const report = await api.evaluate(candidate, { version: 1 });
    const before = JSON.stringify(await api.getEvaluation(report.id));
    await api.recordOutcome(seeded.training_ids[0] ?? '', {
      result: 'rejected',
      source: 'pr-feedback',
      observed_at: '2026-12-01T00:00:00.000Z',
    });
    expect(JSON.stringify(await api.getEvaluation(report.id))).toBe(before);
    const outcomes = fx.db.prepare('SELECT result, source FROM case_outcomes WHERE case_id = ?').all(seeded.training_ids[0]) as {
      result: string;
      source: string;
    }[];
    expect(outcomes).toEqual([{ result: 'rejected', source: 'pr-feedback' }]);
  } finally {
    fx.close();
  }
});

test('putting a holdout case into training fails the evaluation and does not adopt', async () => {
  const { fx, api, vaultId, seeded } = await ready();
  try {
    const candidate = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-leak',
      draftKey: 'leak',
      rules: passingRules(),
    }));
    const holdoutId = seeded.holdout_ids[0];
    if (!holdoutId) throw new Error('missing holdout');
    fx.db.prepare(`UPDATE cases SET role = 'training' WHERE case_id = ? AND dataset_id = ?`).run(holdoutId, seeded.dataset_id);
    const report = await api.evaluate(candidate, { version: 1 });
    expect(report.decision).toBe('leak');
    expect(await api.adoptStandard(candidate.id, report.id, candidate.revision)).toBe('not_adopted');
    expect(await api.activeStandardVersion(candidate.standard_id)).toBeNull();
    expect(await api.activeStandardCount()).toBe(0);
    const prepared = await api.prepareEvaluation(candidate.id, 1);
    expect(scoreTrainingOnly(passingRules(), [...prepared.training, prepared.holdout[0]!], prepared.holdout_ids).leak).toBe(true);
    expect(decideTraining({ correct: 10, total: 10, leak: true }, { min_samples: 10, threshold_thousandths: 800 })).toBe('leak');
  } finally {
    fx.close();
  }
});

test('a sample below the policy minimum returns not_adopted and leaves the pointer', async () => {
  const { fx, api, vaultId } = await ready();
  try {
    await api.seedDataset({
      datasetId: 'product-small',
      policyId: 'product-demand',
      policyVersion: 2,
      minSamples: 10,
      thresholdThousandths: 800,
      budgetMicros: 1000,
      cases: [
        { case_id: 'small-01', role: 'training', situation: '小样本', visible_evidence: ['new_feature'], options: ['interview'], expected_choice: 'interview' },
        { case_id: 'small-02', role: 'training', situation: '小样本', visible_evidence: ['ordinary_feature'], options: ['interview'], expected_choice: 'interview' },
        { case_id: 'small-03', role: 'training', situation: '小样本', visible_evidence: ['repeated_fault', 'measured_loss'], options: ['use_frequency'], expected_choice: 'use_frequency' },
        { case_id: 'small-04', role: 'holdout', situation: '小样本留出', visible_evidence: ['new_feature'], options: ['interview'], expected_choice: 'interview' },
      ],
    });
    const candidate = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-small',
      draftKey: 'small',
      rules: passingRules(),
      thresholdClaim: 0,
    }));
    const report = await api.evaluate(candidate, { version: 2 });
    expect(report.decision).toBe('insufficient');
    expect(report.threshold_thousandths).toBe(800);
    expect(report.training_total).toBe(3);
    expect(await api.adoptStandard(candidate.id, report.id, candidate.revision)).toBe('not_adopted');
    expect(await api.activeStandardVersion(candidate.standard_id)).toBeNull();
    expect(fx.db.prepare('SELECT threshold_thousandths FROM evaluation_policies WHERE policy_version = 2').get()).toEqual({
      threshold_thousandths: 800,
    });
  } finally {
    fx.close();
  }
});

test('judgment basis stays on v1 for in-flight work, and withdrawing v1 blocks its next action', async () => {
  const { fx, api, vaultId } = await ready();
  try {
    const external = await api.freezeJudgmentBasis('work-before-standard', 1);
    expect(external.standards).toEqual([]);
    expect(external.external_method_id).toBe('method-demand-interview');
    expect(external.external_method_revision).toBe('2026.1');
    expect(await api.freezeJudgmentBasis('work-before-standard', 1)).toEqual(external);

    const first = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-basis',
      draftKey: 'basis',
      rules: passingRules(),
    }));
    const v1 = await api.evaluate(first, { version: 1 });
    expect(await api.adoptStandard(first.id, v1.id, first.revision)).toBe('adopted');
    const inflight = await api.freezeJudgmentBasis('work-inflight', 3);
    expect(inflight.standards).toEqual([{ standard_id: first.standard_id, standard_version: 1 }]);
    expect(await api.freezeJudgmentBasis('work-inflight', 3)).toEqual(inflight);

    const revision = await api.openCandidate({
      ...await api.ingestStandardDraft({
        vaultId,
        standardId: first.standard_id,
        draftKey: 'basis-v2',
        rules: passingRules(),
      }),
      baseVersion: 1,
    });
    const v2 = await api.evaluate(revision, { version: 1 });
    expect(await api.adoptStandard(revision.id, v2.id, revision.revision)).toBe('adopted');
    expect(await api.activeStandardVersion(first.standard_id)).toBe(2);
    expect((await api.freezeJudgmentBasis('work-inflight', 3)).standards).toEqual([
      { standard_id: first.standard_id, standard_version: 1 },
    ]);
    const newer = await api.freezeJudgmentBasis('work-new', 1);
    expect(newer.standards).toEqual([{ standard_id: first.standard_id, standard_version: 2 }]);
    expect(newer.hash).not.toBe(inflight.hash);

    await api.withdrawStandardVersion(first.standard_id, 1, '依赖撤回');
    expect(await api.admitJudgmentAction('work-inflight', 3)).toBe('blocked');
    expect(await api.admitJudgmentAction('work-new', 1)).toBe('allowed');
    expect((await api.freezeJudgmentBasis('work-inflight', 3)).hash).toBe(inflight.hash);
  } finally {
    fx.close();
  }
});

test('a caller outside the domain records a trusted proposal and does not activate', async () => {
  const { fx, api, vaultId } = await ready();
  try {
    fx.db.prepare(`INSERT INTO accounts (account_id, auth_epoch, policy_revision, created_at) VALUES ('owner', 1, 0, ?)`).run(NOW);
    const candidate = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-proposal',
      draftKey: 'proposal',
      rules: passingRules(),
    }));
    const report = await api.evaluate(candidate, { version: 1 });
    const outside = apiFor(fx.db, { ...owner, caller_id: 'other', domains: ['personal'] });
    expect(await outside.adoptStandard(candidate.id, report.id, candidate.revision)).toBe('not_adopted');
    expect(await api.activeStandardVersion(candidate.standard_id)).toBeNull();
    expect(await api.activeStandardCount()).toBe(0);
    expect(fx.db.prepare(`SELECT action, target, scope, confirmed_at FROM control_proposals`).all()).toEqual([
      { action: 'adopt_standard', target: candidate.standard_id, scope: DOMAIN, confirmed_at: null },
    ]);
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM domain_events WHERE event_id LIKE 'standard.activated:%'`).get()).toEqual({ n: 0 });
    expect(await api.adoptStandard(candidate.id, report.id, candidate.revision)).toBe('adopted');
    expect(await api.activeStandardVersion(candidate.standard_id)).toBe(1);
  } finally {
    fx.close();
  }
});

test('adoption checks the file head, permission, watermark, and report in one transaction', async () => {
  const { fx, api, vaultId } = await ready();
  try {
    expect(ADOPT_STANDARD_SQL).toBe(`UPDATE standards SET active_version = @next_version, revision = revision + 1
WHERE standard_id = @standard_id AND data_domain = @data_domain
  AND revision = @expected_revision AND active_version IS @base_version
RETURNING standard_id, active_version, revision;`);
    fx.db.prepare(`INSERT INTO accounts (account_id, auth_epoch, policy_revision, created_at) VALUES ('owner', 1, 0, ?)`).run(NOW);
    fx.db.prepare(`INSERT INTO caller_scopes (account_id, caller_id, data_domain, permission, revoked_at)
      VALUES ('owner', 'web', ?, 'owner', NULL)`).run(DOMAIN);

    const candidate = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-cas',
      draftKey: 'cas',
      rules: passingRules(),
    }));
    const report = await api.evaluate(candidate, { version: 1 });
    fx.db.prepare(`UPDATE caller_scopes SET revoked_at = ? WHERE account_id = 'owner' AND data_domain = ?`).run(NOW, DOMAIN);
    expect(await api.adoptStandard(candidate.id, report.id, candidate.revision)).toBe('stale');
    expect(await api.activeStandardVersion(candidate.standard_id)).toBeNull();

    fx.db.prepare(`UPDATE caller_scopes SET revoked_at = NULL WHERE account_id = 'owner' AND data_domain = ?`).run(DOMAIN);
    const restored = await api.evaluate(candidate, { version: 1 });
    fx.db.prepare(`INSERT INTO withdrawal_events (
      event_id, data_domain, target_kind, target_id, target_version, epoch, reason, created_at
    ) VALUES ('withdraw:evidence:1', ?, 'evidence', 'ev-1', 1, 1, '水位变化', ?)`).run(DOMAIN, NOW);
    expect(await api.adoptStandard(candidate.id, restored.id, candidate.revision)).toBe('stale');
    expect(await api.activeStandardVersion(candidate.standard_id)).toBeNull();

    const again = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-atomic',
      draftKey: 'atomic',
      rules: passingRules(),
    }));
    const passing = await api.evaluate(again, { version: 1 });
    fx.db.exec(`CREATE TRIGGER abort_projection BEFORE INSERT ON projection_batches BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    await expect(api.adoptStandard(again.id, passing.id, again.revision)).rejects.toThrow(/boom/);
    expect(await api.activeStandardVersion(again.standard_id)).toBeNull();
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM domain_events WHERE event_id LIKE 'standard.activated:%'`).get()).toEqual({ n: 0 });
    fx.db.exec('DROP TRIGGER abort_projection');
    expect(await api.adoptStandard(again.id, passing.id, again.revision)).toBe('adopted');
    const fact = fx.db.prepare(`SELECT projection_intent_id, active_version FROM adoption_facts WHERE candidate_id = ?`).get(again.id) as {
      projection_intent_id: string;
      active_version: number;
    };
    expect(fact.active_version).toBe(1);
    expect(fx.db.prepare(`SELECT applied, intent_id, view_kind FROM projection_batches WHERE intent_id = ?`).get(fact.projection_intent_id)).toEqual({
      applied: 0,
      intent_id: fact.projection_intent_id,
      view_kind: 'standards',
    });
    expect(fx.db.prepare(`SELECT event_id FROM domain_events WHERE event_id = ?`).get(`standard.activated:${again.standard_id}:1`)).toEqual({
      event_id: `standard.activated:${again.standard_id}:1`,
    });
  } finally {
    fx.close();
  }
});

test('revise_standard follows the adopted version and routes use command and snapshot envelopes', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(join(root, '标准修订'), { recursive: true });
  const databasePath = join(fx.dir, 'patrick.sqlite');
  const credentialDirectory = join(fx.dir, 'credentials');
  try {
    const vault = createVaultApi(fx.db, {
      blobs: createBlobStore(join(fx.dir, 'blobs')),
      now: () => new Date(NOW),
      captureHost: 'mac-mini',
    });
    const vaultId = 'vault-product';
    await vault.connectVault({ accountId: 'owner', deviceId: 'mac-mini', vaultId, root, domain: DOMAIN });
    await vault.confirmVault('mac-mini', vaultId);
    const api = apiFor(fx.db);
    await api.seedProductDataset();
    const editor = {
      account_id: 'owner',
      caller_id: 'web',
      auth_epoch: 1,
      authenticated_at: NOW,
      domains: [DOMAIN],
      operations: ['owner', 'edits.write'],
    };
    await vault.createEdit(editor, { operation: 'create_standard', draft_key: 'http', expected_active_version: null });
    writeFileSync(join(root, '标准修订', 'http.md'), standardDocument('http-file', passingRules()), 'utf8');
    await vault.readVault(vaultId);
    const app = createApp({ databasePath, credentialDirectory, now: () => new Date(NOW) });
    issueBootstrapTicket(fx.db, { accountId: 'owner' }, () => new Date(NOW));
    const store = createCredentialStore(credentialDirectory, () => new Date(NOW));
    const session = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'web',
      domain: DOMAIN,
      permissions: ['owner', 'standards.write', 'standards.read', 'edits.write', 'edits.read'],
    }, () => new Date(NOW), store);
    const headers = { authorization: session.authorization, origin: ORIGIN, 'content-type': 'application/json' };
    const createPayload = { standard_id: null, draft_key: 'http' };
    const createEnvelope = envelope('createStandardCandidate', vaultId, null, createPayload);
    const created = await app.request('/api/v1/standard-candidates', { method: 'POST', headers, body: JSON.stringify(createEnvelope) });
    expect(created.status).toBe(202);
    const accepted = await created.json() as { command_id: string; state: string; receipt_url: string };
    expect(accepted.state).toBe('received');
    const replay = await app.request('/api/v1/standard-candidates', { method: 'POST', headers, body: JSON.stringify(createEnvelope) });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(accepted);
    const candidate = fx.db.prepare(`SELECT candidate_id, standard_id, pointer_revision FROM standard_candidates`).get() as {
      candidate_id: string;
      standard_id: string;
      pointer_revision: number;
    };
    const evaluatePayload = { dataset_id: 'product-demand-v1' };
    const evaluateEnvelope = envelope('evaluateStandardCandidate', candidate.candidate_id, candidate.pointer_revision, evaluatePayload);
    const evaluated = await app.request(`/api/v1/standard-candidates/${candidate.candidate_id}/evaluations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(evaluateEnvelope),
    });
    expect(evaluated.status).toBe(202);
    const evaluationCommand = await evaluated.json() as { receipt_url: string; state: string };
    expect(evaluationCommand.state).toBe('received');
    const report = await app.request(evaluationCommand.receipt_url, { headers });
    expect(report.status).toBe(200);
    const reportBody = await report.json() as { schema_version: string; data: { decision: string; id: string }; watermark: { domain_seq: number } };
    expect(reportBody.schema_version).toBe('1.0');
    expect(reportBody.watermark.domain_seq).toBeGreaterThanOrEqual(0);
    expect(reportBody.data.decision).toBe('pass');
    const adoptPayload = { report_id: reportBody.data.id };
    const adoptEnvelope = envelope('adoptStandardCandidate', candidate.candidate_id, candidate.pointer_revision, adoptPayload);
    const adopted = await app.request(`/api/v1/standard-candidates/${candidate.candidate_id}/adoptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(adoptEnvelope),
    });
    expect(adopted.status).toBe(202);
    const listed = await app.request('/api/v1/standards', { headers });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { data: { items: { standard_id: string; active_version: number | null }[] } };
    expect(listedBody.data.items).toEqual([{ standard_id: candidate.standard_id, active_version: 1 }]);
    const versions = await app.request(accepted.receipt_url, { headers });
    expect(versions.status).toBe(200);
    const versionBody = await versions.json() as { data: { items: { version: number; status: string }[] } };
    expect(versionBody.data.items.map((item) => item.version)).toEqual([1]);

    const revise = await vault.createEdit(editor, {
      operation: 'revise_standard',
      standard_id: candidate.standard_id,
      base_version: 1,
      draft_key: 'revise-http',
    });
    expect(revise.business.state).toBe('pending');
    const staleRevise = await vault.createEdit(editor, {
      operation: 'revise_standard',
      standard_id: candidate.standard_id,
      base_version: 2,
      draft_key: 'revise-stale',
    });
    expect(staleRevise.business.state).toBe('stale');
  } finally {
    fx.close();
  }
});

test('a T06 revise draft posts the standard id and revise base', async () => {
  const fx = temporaryDatabase();
  const root = join(fx.dir, 'vault');
  mkdirSync(root, { recursive: true });
  const databasePath = join(fx.dir, 'patrick.sqlite');
  const credentialDirectory = join(fx.dir, 'credentials');
  try {
    const vault = createVaultApi(fx.db, {
      blobs: createBlobStore(join(fx.dir, 'blobs')),
      now: () => new Date(NOW),
      captureHost: 'mac-mini',
    });
    const vaultId = 'vault-product';
    await vault.connectVault({ accountId: 'owner', deviceId: 'mac-mini', vaultId, root, domain: DOMAIN });
    await vault.confirmVault('mac-mini', vaultId);
    const api = apiFor(fx.db);
    await api.seedProductDataset();
    const first = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-revise-source',
      draftKey: 'revise-source',
      rules: passingRules(),
    }));
    const report = await api.evaluate(first, { version: 1 });
    expect(await api.adoptStandard(first.id, report.id, first.revision)).toBe('adopted');
    const draftKey = 'revise-linked';
    const revise = await vault.createEdit(editor, {
      operation: 'revise_standard',
      standard_id: first.standard_id,
      base_version: 1,
      draft_key: draftKey,
    });
    const intent = fx.db.prepare(`SELECT edit_id, target_id, base_version, document_id, relative_path
      FROM edit_intents WHERE edit_id = ?`).get(revise.edit_id) as {
      edit_id: string;
      target_id: string;
      base_version: number;
      document_id: string;
      relative_path: string;
    };
    expect(intent.relative_path).not.toBe(`标准修订/${draftKey}.md`);
    writeFileSync(
      join(root, ...intent.relative_path.split('/')),
      ruledDraft(intent.document_id, 'not-the-standard', intent.base_version, passingRules()),
      'utf8',
    );
    await vault.readVault(vaultId);
    const app = createApp({ databasePath, credentialDirectory, now: () => new Date(NOW) });
    issueBootstrapTicket(fx.db, { accountId: 'owner' }, () => new Date(NOW));
    const store = createCredentialStore(credentialDirectory, () => new Date(NOW));
    const session = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'web',
      domain: DOMAIN,
      permissions: ['owner', 'standards.write', 'standards.read'],
    }, () => new Date(NOW), store);
    const headers = { authorization: session.authorization, origin: ORIGIN, 'content-type': 'application/json' };
    const wrong = envelope('createStandardCandidate', vaultId, null, { standard_id: 'other-standard', draft_key: draftKey });
    const rejected = await app.request('/api/v1/standard-candidates', { method: 'POST', headers, body: JSON.stringify(wrong) });
    expect(rejected.status).toBe(409);
    const created = await app.request('/api/v1/standard-candidates', {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope('createStandardCandidate', vaultId, null, { standard_id: null, draft_key: draftKey })),
    });
    expect(created.status).toBe(202);
    const candidate = fx.db.prepare(`SELECT standard_id, base_version, edit_id, document_id
      FROM standard_candidates WHERE draft_key = ?`).get(draftKey) as {
      standard_id: string;
      base_version: number | null;
      edit_id: string | null;
      document_id: string;
    };
    expect(candidate).toEqual({
      standard_id: first.standard_id,
      base_version: intent.base_version,
      edit_id: intent.edit_id,
      document_id: intent.document_id,
    });
    const stored = fx.db.prepare(`SELECT relative_path, patrick_id FROM vault_documents WHERE document_id = ?`).get(candidate.document_id) as {
      relative_path: string;
      patrick_id: string | null;
    };
    expect(stored.relative_path).toBe(intent.relative_path);
    expect(stored.relative_path).not.toBe(`标准修订/${draftKey}.md`);
    expect(stored.patrick_id).toBe(intent.document_id);
    expect(stored.patrick_id).not.toBe(candidate.standard_id);
  } finally {
    fx.close();
  }
});

test('a second adopt on an already adopted candidate keeps adopted state', async () => {
  const { fx, api, vaultId } = await ready();
  try {
    const vault = createVaultApi(fx.db, {
      blobs: createBlobStore(join(fx.dir, 'blobs')),
      now: () => new Date(NOW),
      captureHost: 'mac-mini',
    });
    const create = await vault.createEdit(editor, {
      operation: 'create_standard',
      draft_key: 'adopt-guard',
      expected_active_version: null,
    });
    const target = fx.db.prepare(`SELECT target_id FROM edit_intents WHERE edit_id = ?`).get(create.edit_id) as { target_id: string };
    const candidate = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: target.target_id,
      draftKey: 'adopt-guard',
      rules: passingRules(),
    }));
    const firstReport = await api.evaluate(candidate, { version: 1 });
    expect(await api.adoptStandard(candidate.id, firstReport.id, candidate.revision)).toBe('adopted');
    expect(fx.db.prepare(`SELECT status FROM standard_candidates WHERE candidate_id = ?`).get(candidate.id)).toEqual({ status: 'adopted' });
    const adoptedReceipt = latestReceipt(fx.db, create.edit_id);
    expect(adoptedReceipt.business_state).toBe('adopted');
    const standardBefore = fx.db.prepare(`SELECT revision, active_version FROM standards WHERE standard_id = ?`).get(candidate.standard_id) as {
      revision: number;
      active_version: number;
    };
    fx.db.prepare(`INSERT INTO withdrawal_events (
      event_id, data_domain, target_kind, target_id, target_version, epoch, reason, created_at
    ) VALUES ('withdraw:evidence:adopt-guard', ?, 'evidence', 'ev-1', 1, 1, '水位变化', ?)`).run(DOMAIN, NOW);
    const secondReport = await api.evaluate(candidate, { version: 1 });
    expect(secondReport.id).not.toBe(firstReport.id);
    expect(await api.adoptStandard(candidate.id, secondReport.id, candidate.revision)).toBe('adopted');
    expect(fx.db.prepare(`SELECT status FROM standard_candidates WHERE candidate_id = ?`).get(candidate.id)).toEqual({ status: 'adopted' });
    const afterReceipt = latestReceipt(fx.db, create.edit_id);
    expect(afterReceipt.business_state).toBe('adopted');
    expect(afterReceipt.receipt_revision).toBe(adoptedReceipt.receipt_revision);
    expect(fx.db.prepare(`SELECT revision, active_version FROM standards WHERE standard_id = ?`).get(candidate.standard_id)).toEqual(standardBefore);
  } finally {
    fx.close();
  }
});

test('a stale adopt after r9 and a rejected adopt record that business state', async () => {
  const { fx, api, vaultId, seeded } = await ready();
  try {
    const vault = createVaultApi(fx.db, {
      blobs: createBlobStore(join(fx.dir, 'blobs')),
      now: () => new Date(NOW),
      captureHost: 'mac-mini',
    });
    const first = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: 'std-linked',
      draftKey: 'linked-v1',
      rules: passingRules(),
    }));
    const firstReport = await api.evaluate(first, { version: 1 });
    expect(await api.adoptStandard(first.id, firstReport.id, first.revision)).toBe('adopted');
    const revise = await vault.createEdit(editor, {
      operation: 'revise_standard',
      standard_id: first.standard_id,
      base_version: 1,
      draft_key: 'linked-r8',
    });
    const before = latestReceipt(fx.db, revise.edit_id);
    let candidateR8: Candidate | undefined;
    for (let revision = 1; revision <= 8; revision += 1) {
      const ingested = await api.ingestStandardDraft({
        vaultId,
        standardId: first.standard_id,
        draftKey: 'linked-r8',
        rules: passingRules(),
        note: `修订 ${revision}`,
      });
      if (revision === 8) candidateR8 = await api.openCandidate({ ...ingested, baseVersion: 1 });
    }
    if (!candidateR8) throw new Error('missing r8 candidate');
    const report = await api.evaluate(candidateR8, { version: 1 });
    const revisionR9 = await api.ingestStandardDraft({
      vaultId,
      standardId: first.standard_id,
      draftKey: 'linked-r8',
      rules: passingRules(),
      note: '修订 9',
    });
    expect(revisionR9.source_revision).toBe(9);
    expect(await api.adoptStandard(candidateR8.id, report.id, candidateR8.revision)).toBe('stale');
    expect(fx.db.prepare(`SELECT status, edit_id FROM standard_candidates WHERE candidate_id = ?`).get(candidateR8.id)).toEqual({
      status: 'stale',
      edit_id: revise.edit_id,
    });
    const staleReceipt = latestReceipt(fx.db, revise.edit_id);
    expect(staleReceipt.business_state).toBe('stale');
    expect(staleReceipt.file_state).toBe(before.file_state);
    expect(staleReceipt.file_proof_ref).toBe(before.file_proof_ref);
    expect(staleReceipt.receipt_revision).toBe(before.receipt_revision + 1);

    const current = await api.openCandidate({ ...revisionR9, baseVersion: 1 });
    const currentReport = await api.evaluate(current, { version: 1 });
    expect(await api.adoptStandard(current.id, currentReport.id, current.revision)).toBe('adopted');
    expect(fx.db.prepare(`SELECT status FROM standard_candidates WHERE candidate_id = ?`).get(candidateR8.id)).toEqual({ status: 'stale' });
    expect(fx.db.prepare(`SELECT status FROM standard_candidates WHERE candidate_id = ?`).get(current.id)).toEqual({ status: 'adopted' });
    expect(await api.adoptStandard(current.id, currentReport.id, current.revision)).toBe('adopted');

    const rejectedEdit = await vault.createEdit(editor, {
      operation: 'create_standard',
      draft_key: 'rejected-standard',
      expected_active_version: null,
    });
    const target = fx.db.prepare(`SELECT target_id FROM edit_intents WHERE edit_id = ?`).get(rejectedEdit.edit_id) as { target_id: string };
    const rejectedBefore = latestReceipt(fx.db, rejectedEdit.edit_id);
    const rejected = await api.openCandidate(await api.ingestStandardDraft({
      vaultId,
      standardId: target.target_id,
      draftKey: 'rejected-standard',
      rules: passingRules(),
    }));
    const holdoutId = seeded.holdout_ids[0];
    if (!holdoutId) throw new Error('missing holdout');
    fx.db.prepare(`UPDATE cases SET role = 'training' WHERE case_id = ? AND dataset_id = ?`).run(holdoutId, seeded.dataset_id);
    const leaked = await api.evaluate(rejected, { version: 1 });
    expect(leaked.decision).toBe('leak');
    expect(await api.adoptStandard(rejected.id, leaked.id, rejected.revision)).toBe('not_adopted');
    expect(fx.db.prepare(`SELECT status, edit_id FROM standard_candidates WHERE candidate_id = ?`).get(rejected.id)).toEqual({
      status: 'not_adopted',
      edit_id: rejectedEdit.edit_id,
    });
    const rejectedReceipt = latestReceipt(fx.db, rejectedEdit.edit_id);
    expect(rejectedReceipt.business_state).toBe('not_adopted');
    expect(rejectedReceipt.file_state).toBe(rejectedBefore.file_state);
    expect(rejectedReceipt.file_proof_ref).toBe(rejectedBefore.file_proof_ref);
  } finally {
    fx.close();
  }
});

test('the standards migration appends without changing earlier files', () => {
  const manifest = JSON.parse(readFileSync(join(MIGRATIONS, 'manifest.json'), 'utf8')) as { file: string; sha256: string }[];
  expect(manifest.map((entry) => entry.file)).toEqual([
    '0002_core.sql',
    '0003_auth_control.sql',
    '0004_hub_work.sql',
    '0005_sources.sql',
    '0006_vault_evidence.sql',
    '0007_standards.sql',
    '0008_admission_budget.sql',
    '0010_answers_channels.sql',
    '0011_conversations.sql',
    '0012_effects_outcomes.sql',
  ]);
  for (const [file, hash] of Object.entries(PREVIOUS)) {
    expect(manifest.find((entry) => entry.file === file)?.sha256).toBe(hash);
    expect(sha256(readFileSync(join(MIGRATIONS, file)))).toBe(hash);
  }
  const standardsHash = sha256(readFileSync(join(MIGRATIONS, '0007_standards.sql')));
  expect(manifest[5]?.sha256).toBe(standardsHash);
  const fx = temporaryDatabase();
  try {
    expect(fx.db.prepare('SELECT file, sha256 FROM schema_migrations ORDER BY position').all()).toEqual(manifest);
    const template = readFileSync(fileURLToPath(new URL('../../assets/vault-kit/标准修订.md', import.meta.url)), 'utf8');
    expect(template).toContain('# 适用范围');
    expect(template).toContain('# 判断规则');
    const caseTemplate = readFileSync(fileURLToPath(new URL('../../assets/vault-kit/判断案例.md', import.meta.url)), 'utf8');
    expect(caseTemplate).toContain('# 情境');
    expect(caseTemplate).toContain('# 选择及理由');
  } finally {
    fx.close();
  }
});

function envelope(operation: string, resourceId: string, expectedRevision: number | null, payload: Json) {
  const payloadHash = sha256(canonicalPayload(payload));
  return {
    client_request_id: `${operation}-${resourceId}-${randomUUID()}`,
    expected_revision: expectedRevision,
    payload_hash: payloadHash,
    payload,
  };
}

function latestReceipt(db: SqliteDatabase, editId: string) {
  const row = db.prepare(`SELECT receipt_revision, file_state, file_proof_ref, business_state
    FROM edit_receipts WHERE edit_id = ? ORDER BY receipt_revision DESC LIMIT 1`).get(editId) as {
    receipt_revision: number;
    file_state: string;
    file_proof_ref: string | null;
    business_state: string;
  } | undefined;
  if (!row) throw new Error('missing receipt');
  return row;
}

function ruledDraft(patrickId: string, standardId: string, baseVersion: number, rules: StandardRule[]): string {
  return `---
patrick_id: ${patrickId}
kind: standard
standard_id: ${standardId}
base_version: ${baseVersion}
---

# 适用范围

产品需求判断

# 判断规则

\`\`\`json
{
  "rules": ${JSON.stringify(rules)}
}
\`\`\`

# 例外

普通功能冒充故障时仍先访谈

# 正反案例

# 依据
`;
}

function standardDocument(standardId: string, rules: StandardRule[], thresholdClaim?: number): string {
  const claim = thresholdClaim === undefined ? '' : `,\n  "threshold_thousandths": ${thresholdClaim}`;
  return `---
patrick_id: ${standardId}
kind: standard
standard_id: ${standardId}
base_version:
---

# 适用范围

产品需求判断

# 判断规则

\`\`\`json
{
  "rules": ${JSON.stringify(rules)}${claim}
}
\`\`\`

# 例外

普通功能冒充故障时仍先访谈

# 正反案例

# 依据
`;
}
