import { randomUUID } from 'node:crypto';
import { assertRecoveryWriteAllowed, recoveryWriteAllowed, appendDomainEvent, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import type { Principal } from './answer-gate.js';
import { issueWorkGrant, type ExecutionGrant } from './delegation.js';
import type { JudgmentBasis } from './standards.js';

export type ResumePhase = 'answer' | 'evidence_ready';

export type ResumeKey = {
  work_id: string;
  generation: number;
  question_id: string;
  answer_event_id: string;
  phase: ResumePhase;
};

export type ClaimContinuationResult =
  | { status: 'claimed'; grant: ExecutionGrant }
  | { status: 'waiting' }
  | { status: 'duplicate' };

export const INSERT_RESUME_SQL = `INSERT INTO resume_intents (work_id, generation, question_id, answer_event_id, phase, state, next_action, evidence_ref)
VALUES (@work_id, @generation, @question_id, @answer_event_id, @phase, 'ready', @next_action, @evidence_ref)
ON CONFLICT(work_id, generation, question_id, answer_event_id, phase) DO NOTHING
RETURNING phase;`;

export const CLAIM_RESUME_SQL = `UPDATE resume_intents SET state = 'claimed', attempt_id = @attempt_id
WHERE work_id = @work_id AND generation = @generation AND question_id = @question_id
  AND answer_event_id = @answer_event_id AND phase = @phase AND state = 'ready'
RETURNING next_action, evidence_ref;`;

type ResumeRow = {
  state: 'ready' | 'claimed';
  next_action: string;
  evidence_ref: string | null;
  attempt_id: string | null;
};

type WorkRow = {
  account_id: string;
  data_domain: string;
  mandate_id: string;
  phase: 'judgment' | 'collect_evidence' | 'delivery';
  awaiting_answer: number;
  evidence_ready: number;
  collection_id: string | null;
  control_state: string;
};

export function claimContinuation(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  key: ResumeKey,
  attemptId: string,
  now: Date = new Date(),
): ClaimContinuationResult {
  const stamped = now.toISOString();
  return withImmediateTransaction(db, () => {
    const existing = resumeRow(db, key);
    if (!existing || existing.state !== 'ready') {
      return existing?.state === 'claimed' ? { status: 'duplicate' } : { status: 'waiting' };
    }
    if (!continuationReady(db, principal, domain, key, existing, stamped)) return { status: 'waiting' };
    if (attemptStillOpen(db, key.work_id, key.generation)) return { status: 'waiting' };
    const claimed = db.prepare(CLAIM_RESUME_SQL).get({
      attempt_id: attemptId,
      work_id: key.work_id,
      generation: key.generation,
      question_id: key.question_id,
      answer_event_id: key.answer_event_id,
      phase: key.phase,
    }) as { next_action: string; evidence_ref: string | null } | undefined;
    if (!claimed) {
      const again = resumeRow(db, key);
      return again?.state === 'claimed' ? { status: 'duplicate' } : { status: 'waiting' };
    }
    const grant = signGrant(db, principal, domain, stamped, now, key, claimed.next_action, attemptId);
    return { status: 'claimed', grant };
  });
}

export function confirmCollectedEvidence(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  answerStage: ResumeKey,
  evidenceRef: string,
  now: Date = new Date(),
): void {
  if (answerStage.phase !== 'answer') throw new Error('UNPROCESSABLE');
  const stamped = now.toISOString();
  withImmediateTransaction(db, () => {
    const proof = db.prepare(`SELECT evidence_ref FROM evidence_proofs
      WHERE work_id = ? AND generation = ? AND question_id = ? AND answer_event_id = ?`).get(
      answerStage.work_id,
      answerStage.generation,
      answerStage.question_id,
      answerStage.answer_event_id,
    ) as { evidence_ref: string } | undefined;
    const ready = resumeRow(db, { ...answerStage, phase: 'evidence_ready' });
    if (proof && ready) {
      if (proof.evidence_ref !== evidenceRef) throw new Error('CONFLICT');
      return;
    }
    assertWorkRecovery(db, answerStage.work_id, answerStage.generation);
    const answer = resumeRow(db, answerStage);
    if (!answer || answer.state !== 'claimed' || !answer.next_action.startsWith('collect:')) throw new Error('WAITING');
    const question = db.prepare(`SELECT account_id, data_domain, expected_material, withdrawal_watermark, work_id, generation
      FROM question_bindings WHERE question_id = ? ORDER BY question_version DESC LIMIT 1`).get(answerStage.question_id) as {
      account_id: string;
      data_domain: string;
      expected_material: string | null;
      withdrawal_watermark: number;
      work_id: string;
      generation: number;
    } | undefined;
    if (!question || question.account_id !== principal.account_id || question.data_domain !== domain) throw new Error('FORBIDDEN');
    if (!principal.domains.includes(domain)) throw new Error('FORBIDDEN');
    if (question.work_id !== answerStage.work_id || question.generation !== answerStage.generation) throw new Error('UNPROCESSABLE');
    if (question.expected_material !== evidenceRef) throw new Error('UNPROCESSABLE');
    const round = db.prepare(`SELECT closed, evidence_ref, material FROM collection_rounds
      WHERE question_id = ? AND material = ?`).get(answerStage.question_id, evidenceRef) as {
      closed: number;
      evidence_ref: string;
      material: string;
    } | undefined;
    if (!round || round.closed !== 1 || round.evidence_ref !== evidenceRef) throw new Error('UNPROCESSABLE');
    const watermark = currentWatermark(db, domain);
    if (watermark !== question.withdrawal_watermark) throw new Error('UNPROCESSABLE');
    db.prepare(`UPDATE execution_grants SET revoked_at = ?
      WHERE subject_kind = 'work' AND work_id = ? AND generation = ? AND revoked_at IS NULL`).run(
      stamped,
      answerStage.work_id,
      answerStage.generation,
    );
    db.prepare(`INSERT INTO evidence_proofs (
      proof_id, work_id, generation, question_id, answer_event_id, evidence_ref, expected_material,
      withdrawal_watermark, account_id, data_domain, schema_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1.0', ?)`).run(
      `proof_${randomUUID()}`,
      answerStage.work_id,
      answerStage.generation,
      answerStage.question_id,
      answerStage.answer_event_id,
      evidenceRef,
      question.expected_material,
      watermark,
      principal.account_id,
      domain,
      stamped,
    );
    db.prepare(INSERT_RESUME_SQL).run({
      work_id: answerStage.work_id,
      generation: answerStage.generation,
      question_id: answerStage.question_id,
      answer_event_id: answerStage.answer_event_id,
      phase: 'evidence_ready',
      next_action: 'publish_pr',
      evidence_ref: evidenceRef,
    });
    db.prepare(`UPDATE work_generations SET
      phase = 'delivery', next_action = 'publish_pr', evidence_ready = 1, awaiting_answer = 0,
      collection_id = NULL, updated_at = ?
      WHERE work_id = ? AND generation = ?`).run(stamped, answerStage.work_id, answerStage.generation);
    db.prepare(`INSERT INTO work_stages (work_id, generation, stage, updated_at) VALUES (?, ?, 'evidence_ready', ?)
      ON CONFLICT(work_id, generation) DO UPDATE SET stage = 'evidence_ready', updated_at = excluded.updated_at`).run(
      answerStage.work_id,
      answerStage.generation,
      stamped,
    );
    appendDomainEvent(db, {
      eventId: `evidence.ready:${answerStage.answer_event_id}`,
      aggregateId: answerStage.question_id,
      aggregateVersion: answerStage.generation,
      accountId: principal.account_id,
      dataDomain: domain,
      payload: {
        type: 'evidence.ready',
        work_id: answerStage.work_id,
        generation: answerStage.generation,
        question_id: answerStage.question_id,
        answer_event_id: answerStage.answer_event_id,
        evidence_ref: evidenceRef,
      },
      destination: 'hub',
      causationId: answerStage.answer_event_id,
    });
  });
}

export function recordCollectionRound(
  db: SqliteDatabase,
  principal: Principal,
  input: { question_id: string; material: string; evidence_ref: string },
  now: Date = new Date(),
): void {
  const stamped = now.toISOString();
  withImmediateTransaction(db, () => {
    const question = db.prepare(`SELECT account_id, data_domain, expected_material FROM question_bindings
      WHERE question_id = ? ORDER BY question_version DESC LIMIT 1`).get(input.question_id) as {
      account_id: string;
      data_domain: string;
      expected_material: string | null;
    } | undefined;
    if (!question || question.account_id !== principal.account_id || !principal.domains.includes(question.data_domain)) {
      throw new Error('FORBIDDEN');
    }
    assertRecoveryWriteAllowed(db, question.data_domain);
    if (question.expected_material !== input.material || input.evidence_ref !== input.material) throw new Error('UNPROCESSABLE');
    db.prepare(`INSERT INTO collection_rounds (
      round_id, question_id, material, evidence_ref, closed, account_id, data_domain, created_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(question_id, material) DO UPDATE SET closed = 1, evidence_ref = excluded.evidence_ref`).run(
      `round_${randomUUID()}`,
      input.question_id,
      input.material,
      input.evidence_ref,
      principal.account_id,
      question.data_domain,
      stamped,
    );
  });
}

export function assertDeliveryOpen(db: SqliteDatabase, workId: string, generation: number): void {
  const stage = db.prepare('SELECT stage FROM work_stages WHERE work_id = ? AND generation = ?').get(workId, generation) as {
    stage: string;
  } | undefined;
  if (stage?.stage === 'waiting_evidence') throw new Error('WAITING_EVIDENCE');
}

// A direct delivery has no continuation proof. A collection route must still have
// its own claimed delivery attempt and a proof at the current withdrawal watermark.
export function deliveryEvidenceCurrent(
  db: SqliteDatabase, principal: Principal, domain: string, workId: string, generation: number, attemptId: string, nowIso: string,
): boolean {
  const stage = db.prepare('SELECT stage FROM work_stages WHERE work_id = ? AND generation = ?').get(workId, generation) as
    { stage: string } | undefined;
  if (stage?.stage === 'waiting_evidence') return false;
  const work = db.prepare('SELECT data_domain FROM work_generations WHERE work_id = ? AND generation = ?').get(workId, generation) as { data_domain: string } | undefined;
  if (!work || work.data_domain !== domain || !recoveryWriteAllowed(db, work.data_domain)) return false;
  const resumes = db.prepare(`SELECT question_id, answer_event_id, state, next_action, evidence_ref, attempt_id
    FROM resume_intents WHERE work_id = ? AND generation = ? AND phase = 'evidence_ready'`)
    .all(workId, generation) as Array<ResumeRow & { question_id: string; answer_event_id: string }>;
  if (resumes.length === 0) return stage?.stage !== 'evidence_ready';
  return resumes.some((row) => row.state === 'claimed' && row.attempt_id === attemptId && continuationReady(
    db, principal, domain, { work_id: workId, generation, question_id: row.question_id, answer_event_id: row.answer_event_id,
      phase: 'evidence_ready' }, row, nowIso,
  ));
}

export function emitStage(
  db: SqliteDatabase,
  workId: string,
  generation: number,
  kind: string,
  now: Date = new Date(),
): void {
  withImmediateTransaction(db, () => {
    const stamped = now.toISOString();
    assertWorkRecovery(db, workId, generation);
    assertDeliveryOpen(db, workId, generation);
    db.prepare('INSERT INTO stage_events (event_id, work_id, generation, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(
      `stage_${randomUUID()}`,
      workId,
      generation,
      kind,
      stamped,
    );
  });
}

export function writePullRequest(db: SqliteDatabase, workId: string, generation: number, now: Date = new Date()): void {
  emitStage(db, workId, generation, 'pr.sent', now);
}

export function dispatchDelivery(db: SqliteDatabase, workId: string, generation: number): void {
  assertWorkRecovery(db, workId, generation);
  assertDeliveryOpen(db, workId, generation);
}

function assertWorkRecovery(db: SqliteDatabase, workId: string, generation: number): void {
  const work = db.prepare('SELECT data_domain FROM work_generations WHERE work_id = ? AND generation = ?').get(workId, generation) as { data_domain: string } | undefined;
  if (!work) throw new Error('NOT_FOUND');
  assertRecoveryWriteAllowed(db, work.data_domain);
}

function signGrant(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  stamped: string,
  now: Date,
  key: ResumeKey,
  nextAction: string,
  attemptId: string,
): ExecutionGrant {
  const basis = requireBasis(db, key.work_id, key.generation);
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  if (key.phase === 'evidence_ready') {
    prepareWork(db, key, stamped, {
      phase: 'delivery',
      nextAction: 'publish_pr',
      collectionId: null,
      evidenceReady: 1,
    });
    return issueWorkGrant(db, principal, domain, stamped, {
      work_id: key.work_id,
      generation: key.generation,
      attempt_id: attemptId,
      phase: 'delivery',
      next_action: 'publish_pr',
      allowed_effects: ['publish_pr'],
      expires_at: expiresAt,
    }, basis);
  }
  if (nextAction.startsWith('collect:')) {
    const collectionId = nextAction.slice('collect:'.length);
    prepareWork(db, key, stamped, {
      phase: 'collect_evidence',
      nextAction,
      collectionId,
      evidenceReady: 0,
    });
    return issueWorkGrant(db, principal, domain, stamped, {
      work_id: key.work_id,
      generation: key.generation,
      attempt_id: attemptId,
      phase: 'collect_evidence',
      next_action: nextAction,
      allowed_effects: [nextAction],
      collection_id: collectionId,
      expires_at: expiresAt,
    }, basis);
  }
  prepareWork(db, key, stamped, {
    phase: 'judgment',
    nextAction,
    collectionId: null,
    evidenceReady: 0,
  });
  return issueWorkGrant(db, principal, domain, stamped, {
    work_id: key.work_id,
    generation: key.generation,
    attempt_id: attemptId,
    phase: 'judgment',
    next_action: nextAction,
    allowed_effects: [],
    expires_at: expiresAt,
  }, basis);
}

function prepareWork(
  db: SqliteDatabase,
  key: ResumeKey,
  stamped: string,
  next: { phase: WorkRow['phase']; nextAction: string; collectionId: string | null; evidenceReady: number },
): void {
  db.prepare(`UPDATE work_generations SET
    phase = ?, next_action = ?, collection_id = ?, evidence_ready = ?, awaiting_answer = 0, updated_at = ?
    WHERE work_id = ? AND generation = ?`).run(
    next.phase,
    next.nextAction,
    next.collectionId,
    next.evidenceReady,
    stamped,
    key.work_id,
    key.generation,
  );
}

function attemptStillOpen(db: SqliteDatabase, workId: string, generation: number): boolean {
  const grant = db.prepare(`SELECT grant_id FROM execution_grants
    WHERE subject_kind = 'work' AND work_id = ? AND generation = ? AND revoked_at IS NULL`).get(workId, generation);
  if (!grant) return false;
  const work = db.prepare(`SELECT attempt_closed, process_tree_stopped, effects_reconciled
    FROM work_generations WHERE work_id = ? AND generation = ?`).get(workId, generation) as {
    attempt_closed: number;
    process_tree_stopped: number;
    effects_reconciled: number;
  } | undefined;
  if (!work) return true;
  return !(work.attempt_closed === 1 && work.process_tree_stopped === 1 && work.effects_reconciled === 1);
}

function continuationReady(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  key: ResumeKey,
  row: ResumeRow,
  stamped: string,
): boolean {
  const work = db.prepare('SELECT account_id, data_domain, mandate_id FROM work_generations WHERE work_id = ? AND generation = ?').get(
    key.work_id,
    key.generation,
  ) as { account_id: string; data_domain: string; mandate_id: string } | undefined;
  if (!work || work.account_id !== principal.account_id || work.data_domain !== domain) return false;
  if (!principal.domains.includes(domain) || !recoveryWriteAllowed(db, work.data_domain)) return false;
  const mandate = db.prepare('SELECT status, expires_at FROM mandates WHERE mandate_id = ?').get(work.mandate_id) as {
    status: string;
    expires_at: string;
  } | undefined;
  if (!mandate || mandate.status !== 'active' || mandate.expires_at <= stamped) return false;
  const basis = loadBasis(db, key.work_id, key.generation);
  const binding = db.prepare(`SELECT work_id, generation, judgment_basis_hash FROM question_bindings
    WHERE question_id = ? ORDER BY question_version DESC LIMIT 1`).get(key.question_id) as {
    work_id: string;
    generation: number;
    judgment_basis_hash: string;
  } | undefined;
  if (!basis || !binding) return false;
  if (binding.work_id !== key.work_id || binding.generation !== key.generation) return false;
  if (binding.judgment_basis_hash !== basis.hash) return false;
  if (key.phase !== 'evidence_ready') return true;
  const proof = db.prepare(`SELECT evidence_ref, expected_material, withdrawal_watermark FROM evidence_proofs
    WHERE work_id = ? AND generation = ? AND question_id = ? AND answer_event_id = ?`).get(
    key.work_id,
    key.generation,
    key.question_id,
    key.answer_event_id,
  ) as { evidence_ref: string; expected_material: string; withdrawal_watermark: number } | undefined;
  if (!proof || proof.evidence_ref !== row.evidence_ref || proof.expected_material !== row.evidence_ref) return false;
  return proof.withdrawal_watermark === currentWatermark(db, domain);
}

function resumeRow(db: SqliteDatabase, key: ResumeKey): ResumeRow | undefined {
  return db.prepare(`SELECT state, next_action, evidence_ref, attempt_id FROM resume_intents
    WHERE work_id = ? AND generation = ? AND question_id = ? AND answer_event_id = ? AND phase = ?`).get(
    key.work_id,
    key.generation,
    key.question_id,
    key.answer_event_id,
    key.phase,
  ) as ResumeRow | undefined;
}

function requireBasis(db: SqliteDatabase, workId: string, generation: number): JudgmentBasis {
  const basis = loadBasis(db, workId, generation);
  if (!basis) throw new Error('UNPROCESSABLE');
  return basis;
}

function loadBasis(db: SqliteDatabase, workId: string, generation: number): JudgmentBasis | null {
  const row = db.prepare(`SELECT work_id, generation, basis_hash, standards_json, external_method_id,
    external_method_revision, evidence_watermark
    FROM judgment_bases WHERE work_id = ? AND generation = ?`).get(workId, generation) as {
    work_id: string;
    generation: number;
    basis_hash: string;
    standards_json: string;
    external_method_id: string | null;
    external_method_revision: string | null;
    evidence_watermark: number;
  } | undefined;
  if (!row) return null;
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

function currentWatermark(db: SqliteDatabase, domain: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(epoch), 0) AS epoch FROM withdrawal_events WHERE data_domain = ?').get(domain) as {
    epoch: number;
  };
  return row.epoch;
}
