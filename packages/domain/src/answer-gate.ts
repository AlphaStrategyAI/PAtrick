import { createHash, randomUUID } from 'node:crypto';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { appendDomainEvent, commandFingerprint, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import type { AdmissionPrincipal } from './delegation.js';
import { INSERT_RESUME_SQL } from './work-continuation.js';

export type Principal = AdmissionPrincipal;

export type CardAnswer =
  | { kind: 'option'; option_id: string }
  | { kind: 'custom'; raw_text: string };

export type AnswerPayload = {
  work_id: string;
  generation: number;
  question_id: string;
  question_version: number;
  proposal_revision: number;
  options_hash: string;
  answer: CardAnswer;
};

export type AnswerCommand = {
  client_request_id: string;
  expected_revision: number | null;
  payload_hash: string;
  entry: 'web' | 'feishu';
  connection_id?: string;
  inbound_id?: string;
  payload: AnswerPayload;
};

export type AnswerValidity =
  | 'verified'
  | 'stale'
  | 'rejected'
  | 'conflict'
  | 'deferred'
  | 'clarification_required'
  | 'uncertain'
  | 'audit_only';

export type AnswerReceipt = {
  receipt_id: string;
  intent_id: string;
  question_id: string;
  validity: AnswerValidity;
  disposition: 'proceed' | 'deferred' | 'clarification_required';
  reason_code: string | null;
  hub_answer_event_id: string | null;
  successor_question_id: string | null;
  difference: string | null;
  missing: string[];
};

export type QuestionOption = {
  option_id: string;
  index: number;
  label: string;
  disposition: 'proceed' | 'deferred' | 'clarification_required';
  reason_code: 'OUT_OF_SCOPE' | 'MISSING_INPUT' | null;
  next_action: string;
  difference: string | null;
  missing: string[];
  collection_id: string | null;
  expected_material: string | null;
};

export type CustomRule = {
  includes: string;
  disposition: 'proceed' | 'deferred' | 'clarification_required';
  reason_code: 'OUT_OF_SCOPE' | 'MISSING_INPUT' | null;
  next_action: string | null;
  difference: string | null;
  missing: string[];
  collection_id: string | null;
  expected_material: string | null;
};

export type BindQuestionInput = {
  question_id: string;
  question_version: number;
  work_id: string;
  generation: number;
  proposal_revision: number;
  hub_card_id: number;
  custom_allowed: boolean;
  options: QuestionOption[];
  custom_rules: CustomRule[];
};

export type QuestionBinding = BindQuestionInput & {
  options_hash: string;
  judgment_basis_hash: string;
  status: 'open' | 'closed' | 'superseded';
};

type HubAnswerBody = { choice: number } | { text: string };

export type HubPort = {
  accept(
    questionId: string,
    cardId: number,
    body: HubAnswerBody,
  ): Promise<{ changed: boolean; state: string; answer_event_id: string }>;
  read(questionId: string): Promise<null | { cardId: number; state: string; answer_event_id: string; body: HubAnswerBody }>;
};

export type AnswerGateOptions = {
  domain: string;
  now: () => Date;
  hub: HubPort;
  encode: (answer: { kind: 'choice'; index: number } | { kind: 'custom'; raw_text: string }) => HubAnswerBody;
  afterHubAccept?: () => void | Promise<void>;
};

export type AnswerGate = {
  bindQuestion(principal: Principal, input: BindQuestionInput): Promise<QuestionBinding>;
  submitAnswer(principal: Principal, command: AnswerCommand): Promise<AnswerReceipt>;
  recoverAnswer(intentId: string): Promise<AnswerReceipt>;
};

type Decision = {
  disposition: 'proceed' | 'deferred' | 'clarification_required';
  reason_code: 'OUT_OF_SCOPE' | 'MISSING_INPUT' | null;
  next_action: string | null;
  difference: string | null;
  missing: string[];
  collection_id: string | null;
  expected_material: string | null;
  option_id: string | null;
  option_index: number | null;
  raw_custom: string | null;
};

type BindingRow = {
  question_id: string;
  question_version: number;
  work_id: string;
  generation: number;
  account_id: string;
  data_domain: string;
  proposal_revision: number;
  options_hash: string;
  hub_card_id: number;
  judgment_basis_hash: string;
  options_json: string;
  custom_rules_json: string;
  custom_allowed: number;
  status: 'open' | 'closed' | 'superseded';
  successor_question_id: string | null;
  expected_material: string | null;
  collection_id: string | null;
  withdrawal_watermark: number;
};

type IntentRow = {
  intent_id: string;
  account_id: string;
  caller_id: string;
  data_domain: string;
  question_id: string;
  question_version: number;
  work_id: string;
  generation: number;
  proposal_revision: number;
  options_hash: string;
  entry: 'web' | 'feishu';
  answer_kind: 'option' | 'custom';
  option_id: string | null;
  option_index: number | null;
  raw_custom: string | null;
  disposition: Decision['disposition'];
  reason_code: string | null;
  next_action: string | null;
  difference: string | null;
  missing_json: string;
  collection_id: string | null;
  expected_material: string | null;
  connection_id: string | null;
  inbound_event_id: string | null;
  send_status: string;
  hub_card_id: number | null;
  hub_answer_event_id: string | null;
};

type Prepared =
  | { done: true; receipt: AnswerReceipt }
  | { done: false; intent: IntentRow; decision: Decision; binding: BindingRow };

export function createAnswerGate(db: SqliteDatabase, options: AnswerGateOptions): AnswerGate {
  const stamp = () => options.now().toISOString();
  return {
    async bindQuestion(principal, input) {
      return withImmediateTransaction(db, () => bindQuestion(db, principal, options.domain, input, stamp()));
    },
    async submitAnswer(principal, command) {
      await Promise.resolve();
      assertPayloadHash(command);
      const prepared = withImmediateTransaction(db, () => beginSubmit(db, principal, options.domain, command, stamp()));
      if (prepared.done) return prepared.receipt;
      if (prepared.decision.disposition !== 'proceed') {
        return withImmediateTransaction(db, () => finishLocal(db, principal, options.domain, prepared, stamp()));
      }
      const won = withImmediateTransaction(db, () => takeSendLock(db, prepared.intent.intent_id, prepared.binding.question_id, stamp()));
      if (!won) return withImmediateTransaction(db, () => writeReceipt(db, prepared.intent, 'conflict', prepared.decision, null, stamp()));
      const body = options.encode(
        prepared.intent.answer_kind === 'option'
          ? { kind: 'choice', index: prepared.intent.option_index ?? 0 }
          : { kind: 'custom', raw_text: prepared.intent.raw_custom ?? '' },
      );
      const accepted = await options.hub.accept(prepared.binding.question_id, prepared.binding.hub_card_id, body);
      if (!accepted.changed) {
        const current = await options.hub.read(prepared.binding.question_id);
        if (!current || !sameBody(current.body, body)) {
          return withImmediateTransaction(db, () => writeReceipt(db, prepared.intent, 'conflict', prepared.decision, null, stamp()));
        }
      }
      withImmediateTransaction(db, () => {
        db.prepare(`UPDATE answer_intents SET send_status = 'accepted', hub_answer_event_id = ?, updated_at = ?
          WHERE intent_id = ?`).run(accepted.answer_event_id, stamp(), prepared.intent.intent_id);
        if (prepared.intent.connection_id && prepared.intent.inbound_event_id) {
          const next = db.prepare(`SELECT COALESCE(MAX(dispatch_seq), 0) + 1 AS n FROM channel_permits
            WHERE connection_id = ?`).get(prepared.intent.connection_id) as { n: number };
          db.prepare(`UPDATE channel_permits SET dispatch_seq = ? WHERE connection_id = ? AND inbound_id = ? AND dispatch_seq IS NULL`).run(
            next.n,
            prepared.intent.connection_id,
            prepared.intent.inbound_event_id,
          );
        }
      });
      if (options.afterHubAccept) await options.afterHubAccept();
      const intent = requireIntent(db, prepared.intent.intent_id);
      return withImmediateTransaction(db, () => commitVerified(db, principal, options.domain, intent, accepted.answer_event_id, stamp()));
    },
    async recoverAnswer(intentId) {
      const intent = requireIntent(db, intentId);
      const existing = receiptForIntent(db, intentId);
      if (existing) return existing;
      const read = await options.hub.read(intent.question_id);
      const expected = expectedBody(intent);
      if (!read || intent.hub_card_id !== read.cardId || !sameBody(read.body, expected)) {
        if (intent.send_status === 'accepted') {
          return withImmediateTransaction(db, () => writeReceipt(db, intent, 'audit_only', decisionOf(intent), null, stamp()));
        }
        return uncertain(intent);
      }
      if (!recoveryAllowed(db, intent, stamp())) {
        return withImmediateTransaction(db, () => writeReceipt(db, intent, 'audit_only', decisionOf(intent), null, stamp()));
      }
      return withImmediateTransaction(db, () => commitVerified(db, principalOf(intent), intent.data_domain, intent, read.answer_event_id, stamp()));
    },
  };
}

function bindQuestion(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  input: BindQuestionInput,
  stamped: string,
): QuestionBinding {
  const work = db.prepare('SELECT account_id, data_domain, mandate_id FROM work_generations WHERE work_id = ? AND generation = ?').get(
    input.work_id,
    input.generation,
  ) as { account_id: string; data_domain: string; mandate_id: string } | undefined;
  if (!work || work.account_id !== principal.account_id || work.data_domain !== domain || !principal.domains.includes(domain)) {
    throw new Error('FORBIDDEN');
  }
  const basis = db.prepare('SELECT basis_hash FROM judgment_bases WHERE work_id = ? AND generation = ?').get(input.work_id, input.generation) as {
    basis_hash: string;
  } | undefined;
  if (!basis) throw new Error('UNPROCESSABLE');
  const optionsHash = freezeOptionsHash(input);
  const existing = loadBinding(db, input.question_id, input.question_version);
  if (existing) {
    if (existing.options_hash !== optionsHash || existing.work_id !== input.work_id) throw new Error('CONFLICT');
    return viewBinding(existing, input);
  }
  const watermark = currentWatermark(db, domain);
  const material = input.options.find((option) => option.expected_material)?.expected_material ?? null;
  const collectionId = input.options.find((option) => option.collection_id)?.collection_id ?? null;
  db.prepare(`INSERT INTO question_bindings (
    question_id, question_version, work_id, generation, account_id, data_domain, proposal_revision, options_hash,
    hub_card_id, judgment_basis_hash, options_json, custom_rules_json, custom_allowed, status, successor_question_id,
    expected_material, collection_id, withdrawal_watermark, schema_version, revision, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, '1.0', 0, ?, ?)`).run(
    input.question_id,
    input.question_version,
    input.work_id,
    input.generation,
    principal.account_id,
    domain,
    input.proposal_revision,
    optionsHash,
    input.hub_card_id,
    basis.basis_hash,
    JSON.stringify(input.options),
    JSON.stringify(input.custom_rules),
    input.custom_allowed ? 1 : 0,
    material,
    collectionId,
    watermark,
    stamped,
    stamped,
  );
  db.prepare('INSERT INTO question_locks (question_id, state, holder_intent_id, updated_at) VALUES (?, \'open\', NULL, ?)').run(
    input.question_id,
    stamped,
  );
  db.prepare('UPDATE work_generations SET awaiting_answer = 1, updated_at = ? WHERE work_id = ? AND generation = ?').run(
    stamped,
    input.work_id,
    input.generation,
  );
  db.prepare(`INSERT INTO work_stages (work_id, generation, stage, updated_at) VALUES (?, ?, 'open', ?)
    ON CONFLICT(work_id, generation) DO NOTHING`).run(input.work_id, input.generation, stamped);
  return {
    ...input,
    options_hash: optionsHash,
    judgment_basis_hash: basis.basis_hash,
    status: 'open',
  };
}

function beginSubmit(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  command: AnswerCommand,
  stamped: string,
): Prepared {
  const binding = loadBinding(db, command.payload.question_id, command.payload.question_version);
  if (!binding || binding.account_id !== principal.account_id || binding.data_domain !== domain || !principal.domains.includes(domain)) {
    throw new Error('FORBIDDEN');
  }
  const fingerprint = commandFingerprint({
    operation: 'submitAnswer',
    resource_id: command.payload.question_id,
    data_domain: domain,
    expected_revision: command.expected_revision,
    payload_hash: command.payload_hash,
  });
  const prior = db.prepare(`SELECT intent_id, command_fingerprint FROM answer_intents
    WHERE account_id = ? AND caller_id = ? AND client_request_id = ?`).get(
    principal.account_id,
    principal.caller_id,
    command.client_request_id,
  ) as { intent_id: string; command_fingerprint: string } | undefined;
  if (prior) {
    if (prior.command_fingerprint !== fingerprint) throw new Error('CONFLICT');
    const receipt = receiptForIntent(db, prior.intent_id);
    if (!receipt) throw new Error('CONFLICT');
    return { done: true, receipt };
  }
  const decision = classify(binding, command.payload.answer);
  if (
    command.expected_revision !== binding.proposal_revision
    || command.payload.options_hash !== binding.options_hash
    || command.payload.work_id !== binding.work_id
    || command.payload.generation !== binding.generation
  ) {
    const intent = insertIntent(db, principal, domain, command, binding, decision, fingerprint, null, stamped);
    return { done: true, receipt: writeReceipt(db, intent, 'stale', decision, null, stamped) };
  }
  if (binding.status !== 'open') {
    const intent = insertIntent(db, principal, domain, command, binding, decision, fingerprint, null, stamped);
    if (decision.reason_code === 'OUT_OF_SCOPE') {
      const replacement = db.prepare(`SELECT successor_question_id, difference FROM question_replacements
        WHERE work_id = ? AND generation = ? AND question_id = ? AND question_version = ?`).get(
        binding.work_id,
        binding.generation,
        binding.question_id,
        binding.question_version,
      ) as { successor_question_id: string; difference: string } | undefined;
      if (replacement) {
        return {
          done: true,
          receipt: writeReceipt(db, intent, 'clarification_required', {
            ...decision,
            difference: replacement.difference,
          }, replacement.successor_question_id, stamped),
        };
      }
    }
    return { done: true, receipt: writeReceipt(db, intent, 'rejected', { ...decision, reason_code: decision.reason_code }, null, stamped, 'SUPERSEDED') };
  }
  const channelPermit = command.entry === 'feishu' ? permitFeishu(db, principal, domain, command, binding, stamped) : null;
  const intent = insertIntent(db, principal, domain, command, binding, decision, fingerprint, channelPermit, stamped);
  return { done: false, intent, decision, binding };
}

function finishLocal(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  prepared: Extract<Prepared, { done: false }>,
  stamped: string,
): AnswerReceipt {
  const held = takeSendLock(db, prepared.intent.intent_id, prepared.binding.question_id, stamped);
  if (!held) return writeReceipt(db, prepared.intent, 'conflict', prepared.decision, null, stamped);
  if (prepared.decision.reason_code === 'OUT_OF_SCOPE') {
    const successorId = `${prepared.binding.question_id}:next`;
    const existing = db.prepare(`SELECT successor_question_id, difference FROM question_replacements
      WHERE question_id = ? AND question_version = ?`).get(prepared.binding.question_id, prepared.binding.question_version) as {
      successor_question_id: string;
      difference: string;
    } | undefined;
    const successor = existing?.successor_question_id ?? createSuccessor(db, principal, domain, prepared, successorId, stamped);
    const difference = existing?.difference ?? prepared.decision.difference ?? '';
    db.prepare(`UPDATE question_bindings SET status = 'superseded', successor_question_id = ?, updated_at = ?
      WHERE question_id = ? AND question_version = ?`).run(successor, stamped, prepared.binding.question_id, prepared.binding.question_version);
    db.prepare(`UPDATE question_locks SET state = 'closed', updated_at = ? WHERE question_id = ?`).run(stamped, prepared.binding.question_id);
    return writeReceipt(db, prepared.intent, 'clarification_required', { ...prepared.decision, difference }, successor, stamped);
  }
  db.prepare(`UPDATE question_locks SET state = 'open', holder_intent_id = NULL, updated_at = ? WHERE question_id = ?`).run(
    stamped,
    prepared.binding.question_id,
  );
  const validity = prepared.decision.disposition === 'deferred' ? 'deferred' : 'clarification_required';
  return writeReceipt(db, prepared.intent, validity, prepared.decision, null, stamped);
}

function createSuccessor(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  prepared: Extract<Prepared, { done: false }>,
  successorId: string,
  stamped: string,
): string {
  const input: BindQuestionInput = {
    question_id: successorId,
    question_version: 1,
    work_id: prepared.binding.work_id,
    generation: prepared.binding.generation,
    proposal_revision: prepared.binding.proposal_revision,
    hub_card_id: prepared.binding.hub_card_id + 1000,
    custom_allowed: prepared.binding.custom_allowed === 1,
    options: JSON.parse(prepared.binding.options_json) as QuestionOption[],
    custom_rules: JSON.parse(prepared.binding.custom_rules_json) as CustomRule[],
  };
  const optionsHash = freezeOptionsHash(input);
  db.prepare(`INSERT INTO question_bindings (
    question_id, question_version, work_id, generation, account_id, data_domain, proposal_revision, options_hash,
    hub_card_id, judgment_basis_hash, options_json, custom_rules_json, custom_allowed, status, successor_question_id,
    expected_material, collection_id, withdrawal_watermark, schema_version, revision, created_at, updated_at
  ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, '1.0', 0, ?, ?)`).run(
    successorId,
    prepared.binding.work_id,
    prepared.binding.generation,
    principal.account_id,
    domain,
    input.proposal_revision,
    optionsHash,
    input.hub_card_id,
    prepared.binding.judgment_basis_hash,
    prepared.binding.options_json,
    prepared.binding.custom_rules_json,
    prepared.binding.custom_allowed,
    prepared.binding.expected_material,
    prepared.binding.collection_id,
    prepared.binding.withdrawal_watermark,
    stamped,
    stamped,
  );
  db.prepare('INSERT INTO question_locks (question_id, state, holder_intent_id, updated_at) VALUES (?, \'open\', NULL, ?)').run(
    successorId,
    stamped,
  );
  db.prepare(`INSERT INTO question_replacements (
    work_id, generation, question_id, question_version, successor_question_id, reason_code, difference, close_receipt,
    account_id, data_domain, schema_version, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, '1.0', ?)`).run(
    prepared.binding.work_id,
    prepared.binding.generation,
    prepared.binding.question_id,
    prepared.binding.question_version,
    successorId,
    'OUT_OF_SCOPE',
    prepared.decision.difference ?? '',
    principal.account_id,
    domain,
    stamped,
  );
  return successorId;
}

function commitVerified(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  intent: IntentRow,
  answerEventId: string,
  stamped: string,
): AnswerReceipt {
  const existing = receiptForIntent(db, intent.intent_id);
  if (existing?.validity === 'verified') return existing;
  const other = db.prepare(`SELECT receipt_id FROM answer_receipts WHERE question_id = ? AND validity = 'verified'`).get(intent.question_id);
  if (other) return writeReceipt(db, intent, 'conflict', decisionOf(intent), null, stamped);
  const decision = decisionOf(intent);
  const receipt = writeReceipt(db, intent, 'verified', decision, null, stamped, null, answerEventId);
  db.prepare(INSERT_RESUME_SQL).run({
    work_id: intent.work_id,
    generation: intent.generation,
    question_id: intent.question_id,
    answer_event_id: answerEventId,
    phase: 'answer',
    next_action: intent.next_action,
    evidence_ref: null,
  });
  appendDomainEvent(db, {
    eventId: `answer.verified:${intent.question_id}:${answerEventId}`,
    aggregateId: intent.question_id,
    aggregateVersion: intent.question_version,
    accountId: principal.account_id,
    dataDomain: domain,
    payload: {
      type: 'answer.verified',
      work_id: intent.work_id,
      generation: intent.generation,
      question_id: intent.question_id,
      answer_event_id: answerEventId,
    },
    destination: 'hub',
    causationId: intent.intent_id,
  });
  db.prepare(`UPDATE question_bindings SET status = 'closed', updated_at = ? WHERE question_id = ? AND question_version = ?`).run(
    stamped,
    intent.question_id,
    intent.question_version,
  );
  db.prepare(`UPDATE question_locks SET state = 'verified', updated_at = ? WHERE question_id = ?`).run(stamped, intent.question_id);
  if (intent.connection_id && intent.inbound_event_id) {
    db.prepare(`UPDATE channel_permits SET terminal = 1 WHERE connection_id = ? AND inbound_id = ?`).run(
      intent.connection_id,
      intent.inbound_event_id,
    );
  }
  if (intent.next_action?.startsWith('collect:')) {
    db.prepare(`INSERT INTO work_stages (work_id, generation, stage, updated_at) VALUES (?, ?, 'waiting_evidence', ?)
      ON CONFLICT(work_id, generation) DO UPDATE SET stage = 'waiting_evidence', updated_at = excluded.updated_at`).run(
      intent.work_id,
      intent.generation,
      stamped,
    );
  }
  return receipt;
}

function insertIntent(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  command: AnswerCommand,
  binding: BindingRow,
  decision: Decision,
  fingerprint: string,
  channelPermit: string | null,
  stamped: string,
): IntentRow {
  const intentId = `intent_${randomUUID()}`;
  const connection = command.entry === 'feishu'
    ? db.prepare('SELECT channel_incarnation, connection_epoch, config_revision, binding_revision FROM channel_connections WHERE connection_id = ?').get(
      command.connection_id ?? '',
    ) as { channel_incarnation: number; connection_epoch: number; config_revision: number; binding_revision: number } | undefined
    : undefined;
  db.prepare(`INSERT INTO answer_intents (
    intent_id, account_id, caller_id, data_domain, client_request_id, command_fingerprint, question_id, question_version,
    work_id, generation, proposal_revision, options_hash, entry, answer_kind, option_id, option_index, raw_custom,
    disposition, reason_code, next_action, difference, missing_json, collection_id, expected_material, connection_id,
    incarnation, epoch, config_revision, binding_revision, inbound_event_id, channel_permit, cutoff, send_status,
    hub_card_id, hub_answer_event_id, schema_version, created_at, updated_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'stored', ?, NULL, '1.0', ?, ?
  )`).run(
    intentId,
    principal.account_id,
    principal.caller_id,
    domain,
    command.client_request_id,
    fingerprint,
    binding.question_id,
    binding.question_version,
    binding.work_id,
    binding.generation,
    binding.proposal_revision,
    binding.options_hash,
    command.entry,
    command.payload.answer.kind,
    decision.option_id,
    decision.option_index,
    decision.raw_custom,
    decision.disposition,
    decision.reason_code,
    decision.next_action,
    decision.difference,
    JSON.stringify(decision.missing),
    decision.collection_id,
    decision.expected_material,
    command.entry === 'feishu' ? command.connection_id ?? null : null,
    connection?.channel_incarnation ?? null,
    connection?.connection_epoch ?? null,
    connection?.config_revision ?? null,
    connection?.binding_revision ?? null,
    command.entry === 'feishu' ? command.inbound_id ?? null : null,
    channelPermit,
    binding.hub_card_id,
    stamped,
    stamped,
  );
  if (decision.raw_custom !== null) {
    db.prepare(`INSERT INTO raw_custom_answers (submission_id, raw_custom, created_at) VALUES (?, ?, ?)
      ON CONFLICT(submission_id) DO UPDATE SET raw_custom = excluded.raw_custom`).run(intentId, decision.raw_custom, stamped);
  }
  db.prepare(`INSERT INTO decision_submissions (
    submission_id, account_id, data_domain, question_id, question_version, raw_custom, disposition, reason_code,
    answer_intent_id, replacement_ref, option_id, schema_version, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '1.0', ?)`).run(
    `sub_${randomUUID()}`,
    principal.account_id,
    domain,
    binding.question_id,
    binding.question_version,
    decision.raw_custom,
    decision.disposition,
    decision.reason_code,
    intentId,
    decision.option_id,
    stamped,
  );
  return requireIntent(db, intentId);
}

function writeReceipt(
  db: SqliteDatabase,
  intent: IntentRow,
  validity: AnswerValidity,
  decision: Decision,
  successorId: string | null,
  stamped: string,
  reasonOverride?: string | null,
  hubAnswerEventId?: string | null,
): AnswerReceipt {
  const existing = receiptForIntent(db, intent.intent_id);
  if (existing && (existing.validity === validity || existing.validity === 'verified')) return existing;
  const receiptId = `receipt_${randomUUID()}`;
  const reason = reasonOverride === undefined ? decision.reason_code : reasonOverride;
  db.prepare(`INSERT INTO answer_receipts (
    receipt_id, intent_id, account_id, data_domain, question_id, question_version, work_id, generation, validity,
    disposition, reason_code, hub_answer_event_id, result_revision, successor_question_id, difference, missing_json,
    schema_version, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '1.0', ?)`).run(
    receiptId,
    intent.intent_id,
    intent.account_id,
    intent.data_domain,
    intent.question_id,
    intent.question_version,
    intent.work_id,
    intent.generation,
    validity,
    decision.disposition,
    reason,
    hubAnswerEventId ?? null,
    successorId,
    decision.difference,
    JSON.stringify(decision.missing),
    stamped,
  );
  if (successorId) {
    db.prepare('UPDATE decision_submissions SET replacement_ref = ? WHERE answer_intent_id = ?').run(successorId, intent.intent_id);
  }
  db.prepare(`UPDATE answer_intents SET send_status = ?, updated_at = ? WHERE intent_id = ?`).run(
    validity === 'verified' ? 'accepted' : validity === 'uncertain' ? 'uncertain' : 'rejected',
    stamped,
    intent.intent_id,
  );
  return {
    receipt_id: receiptId,
    intent_id: intent.intent_id,
    question_id: intent.question_id,
    validity,
    disposition: decision.disposition,
    reason_code: reason,
    hub_answer_event_id: hubAnswerEventId ?? null,
    successor_question_id: successorId,
    difference: decision.difference,
    missing: decision.missing,
  };
}

function permitFeishu(
  db: SqliteDatabase,
  principal: Principal,
  domain: string,
  command: AnswerCommand,
  binding: BindingRow,
  stamped: string,
): string {
  if (!command.connection_id || !command.inbound_id) throw new Error('UNPROCESSABLE');
  const connection = db.prepare(`SELECT account_id, data_domain, status, transport_mode, channel_incarnation, connection_epoch,
    config_revision, binding_revision FROM channel_connections WHERE connection_id = ?`).get(command.connection_id) as {
    account_id: string;
    data_domain: string;
    status: string;
    transport_mode: string;
    channel_incarnation: number;
    connection_epoch: number;
    config_revision: number;
    binding_revision: number;
  } | undefined;
  if (!connection || connection.account_id !== principal.account_id || connection.data_domain !== domain) throw new Error('FORBIDDEN');
  if (connection.status !== 'ready' || connection.transport_mode !== 'active') throw new Error('CHANNEL_DENIED');
  const permitId = `permit_${sha256(`${command.connection_id}\0${command.inbound_id}`).slice(0, 24)}`;
  db.prepare(`INSERT INTO channel_permits (
    permit_id, connection_id, inbound_id, question_id, account_id, permit_recorded, dispatch_seq, terminal,
    incarnation, epoch, config_revision, binding_revision, cutoff, disposition, intent_id, schema_version, created_at
  ) VALUES (?, ?, ?, ?, ?, 1, NULL, 0, ?, ?, ?, ?, NULL, NULL, NULL, '1.0', ?)
  ON CONFLICT(connection_id, inbound_id) DO NOTHING`).run(
    permitId,
    command.connection_id,
    command.inbound_id,
    binding.question_id,
    principal.account_id,
    connection.channel_incarnation,
    connection.connection_epoch,
    connection.config_revision,
    connection.binding_revision,
    stamped,
  );
  return permitId;
}

function takeSendLock(db: SqliteDatabase, intentId: string, questionId: string, stamped: string): boolean {
  const info = db.prepare(`UPDATE question_locks SET state = 'sending', holder_intent_id = ?, updated_at = ?
    WHERE question_id = ? AND state = 'open'`).run(intentId, stamped, questionId);
  return info.changes === 1;
}

function recoveryAllowed(db: SqliteDatabase, intent: IntentRow, stamped: string): boolean {
  const work = db.prepare('SELECT mandate_id, account_id, data_domain FROM work_generations WHERE work_id = ? AND generation = ?').get(
    intent.work_id,
    intent.generation,
  ) as { mandate_id: string; account_id: string; data_domain: string } | undefined;
  if (!work || work.account_id !== intent.account_id || work.data_domain !== intent.data_domain) return false;
  const mandate = db.prepare('SELECT status, expires_at, scope_hash FROM mandates WHERE mandate_id = ?').get(work.mandate_id) as {
    status: string;
    expires_at: string;
    scope_hash: string;
  } | undefined;
  if (!mandate || mandate.status !== 'active' || mandate.expires_at <= stamped) return false;
  const basis = db.prepare('SELECT basis_hash FROM judgment_bases WHERE work_id = ? AND generation = ?').get(intent.work_id, intent.generation) as {
    basis_hash: string;
  } | undefined;
  const binding = loadBinding(db, intent.question_id, intent.question_version);
  if (!basis || !binding) return false;
  return binding.judgment_basis_hash === basis.basis_hash && binding.options_hash === intent.options_hash;
}

function classify(binding: BindingRow, answer: CardAnswer): Decision {
  const options = JSON.parse(binding.options_json) as QuestionOption[];
  const rules = JSON.parse(binding.custom_rules_json) as CustomRule[];
  if (answer.kind === 'option') {
    const option = options.find((item) => item.option_id === answer.option_id);
    if (!option) throw new Error('UNPROCESSABLE');
    return decisionFrom(option.disposition, option.reason_code, option.next_action, option.difference, option.missing, option.collection_id, option.expected_material, option.option_id, option.index, null);
  }
  if (binding.custom_allowed !== 1) throw new Error('UNPROCESSABLE');
  const rule = rules.find((item) => answer.raw_text.includes(item.includes));
  if (!rule) {
    return decisionFrom('proceed', null, 'judge', null, [], null, null, null, null, answer.raw_text);
  }
  return decisionFrom(rule.disposition, rule.reason_code, rule.next_action, rule.difference, rule.missing, rule.collection_id, rule.expected_material, null, null, answer.raw_text);
}

function decisionFrom(
  disposition: Decision['disposition'],
  reason: Decision['reason_code'],
  nextAction: string | null,
  difference: string | null,
  missing: string[],
  collectionId: string | null,
  material: string | null,
  optionId: string | null,
  optionIndex: number | null,
  raw: string | null,
): Decision {
  let action = nextAction;
  if (disposition === 'proceed' && nextAction === 'collect_evidence') {
    if (!collectionId) throw new Error('UNPROCESSABLE');
    action = `collect:${collectionId}`;
  }
  return {
    disposition,
    reason_code: reason,
    next_action: action,
    difference,
    missing,
    collection_id: collectionId,
    expected_material: material,
    option_id: optionId,
    option_index: optionIndex,
    raw_custom: raw,
  };
}

function decisionOf(intent: IntentRow): Decision {
  return {
    disposition: intent.disposition,
    reason_code: intent.reason_code === 'OUT_OF_SCOPE' || intent.reason_code === 'MISSING_INPUT' ? intent.reason_code : null,
    next_action: intent.next_action,
    difference: intent.difference,
    missing: JSON.parse(intent.missing_json) as string[],
    collection_id: intent.collection_id,
    expected_material: intent.expected_material,
    option_id: intent.option_id,
    option_index: intent.option_index,
    raw_custom: intent.raw_custom,
  };
}

function expectedBody(intent: IntentRow): HubAnswerBody {
  if (intent.answer_kind === 'custom') return { text: intent.raw_custom ?? '' };
  return { choice: intent.option_index ?? -1 };
}

function sameBody(actual: HubAnswerBody, expected: HubAnswerBody): boolean {
  if ('choice' in actual && 'choice' in expected) return actual.choice === expected.choice;
  if ('text' in actual && 'text' in expected) return actual.text === expected.text;
  return false;
}

function uncertain(intent: IntentRow): AnswerReceipt {
  return {
    receipt_id: `uncertain-${intent.intent_id}`,
    intent_id: intent.intent_id,
    question_id: intent.question_id,
    validity: 'uncertain',
    disposition: intent.disposition,
    reason_code: intent.reason_code,
    hub_answer_event_id: null,
    successor_question_id: null,
    difference: intent.difference,
    missing: JSON.parse(intent.missing_json) as string[],
  };
}

function principalOf(intent: IntentRow): Principal {
  return {
    account_id: intent.account_id,
    caller_id: intent.caller_id,
    auth_epoch: 0,
    domains: [intent.data_domain],
    operations: ['owner'],
  };
}

function receiptForIntent(db: SqliteDatabase, intentId: string): AnswerReceipt | null {
  const row = db.prepare(`SELECT receipt_id, intent_id, question_id, validity, disposition, reason_code, hub_answer_event_id,
    successor_question_id, difference, missing_json FROM answer_receipts WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1`).get(intentId) as {
    receipt_id: string;
    intent_id: string;
    question_id: string;
    validity: AnswerValidity;
    disposition: AnswerReceipt['disposition'];
    reason_code: string | null;
    hub_answer_event_id: string | null;
    successor_question_id: string | null;
    difference: string | null;
    missing_json: string;
  } | undefined;
  if (!row) return null;
  return {
    receipt_id: row.receipt_id,
    intent_id: row.intent_id,
    question_id: row.question_id,
    validity: row.validity,
    disposition: row.disposition,
    reason_code: row.reason_code,
    hub_answer_event_id: row.hub_answer_event_id,
    successor_question_id: row.successor_question_id,
    difference: row.difference,
    missing: JSON.parse(row.missing_json) as string[],
  };
}

function requireIntent(db: SqliteDatabase, intentId: string): IntentRow {
  const row = db.prepare('SELECT * FROM answer_intents WHERE intent_id = ?').get(intentId) as IntentRow | undefined;
  if (!row) throw new Error('NOT_FOUND');
  return row;
}

function loadBinding(db: SqliteDatabase, questionId: string, questionVersion: number): BindingRow | undefined {
  return db.prepare('SELECT * FROM question_bindings WHERE question_id = ? AND question_version = ?').get(questionId, questionVersion) as BindingRow | undefined;
}

function viewBinding(row: BindingRow, input: BindQuestionInput): QuestionBinding {
  return {
    ...input,
    options_hash: row.options_hash,
    judgment_basis_hash: row.judgment_basis_hash,
    status: row.status,
  };
}

function freezeOptionsHash(input: BindQuestionInput): string {
  return sha256(canonicalPayload({
    question_id: input.question_id,
    question_version: input.question_version,
    proposal_revision: input.proposal_revision,
    custom_allowed: input.custom_allowed,
    options: input.options as unknown as Json,
    custom_rules: input.custom_rules as unknown as Json,
  }));
}

function assertPayloadHash(command: AnswerCommand): void {
  const actual = sha256(canonicalPayload(command.payload as unknown as Json));
  if (actual !== command.payload_hash) throw new Error('UNPROCESSABLE');
}

function currentWatermark(db: SqliteDatabase, domain: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(epoch), 0) AS epoch FROM withdrawal_events WHERE data_domain = ?').get(domain) as {
    epoch: number;
  };
  return row.epoch;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
