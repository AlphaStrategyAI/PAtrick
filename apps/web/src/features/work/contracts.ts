import { ClientError } from '../../api/client.js';

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export type WorkState = 'researching' | 'awaiting_answer' | 'verifying' | 'paused' | 'blocked' | 'delivered';
export type WorkItem = {
  work_id: string;
  generation: number;
  updated_at: string;
  state: WorkState;
  attempt_ids: number[];
  question_id: string | null;
  delivery_id: string | null;
  revision: number;
};
export type WorkList = {
  items: WorkItem[];
  next_cursor: string | null;
  counts: { open: number; awaiting_answer: number; blocked: number };
};
export type Timeline = { items: { event_id: string; type: string; at: string }[] };
export type Question = {
  work_id: string;
  generation: number;
  question_id: string;
  question_version: number;
  proposal_revision: number;
  options_hash: string;
  status: 'open' | 'closed' | 'superseded';
  successor_question_id: string | null;
  options: { option_id: string; index: number; label: string; next_action: string | null; difference: string | null; missing: string[] }[];
  custom_allowed: boolean;
  expires_at: string | null;
};
export type AnswerReceipt = {
  receipt_id: string;
  question_id: string;
  validity: 'verified' | 'stale' | 'rejected' | 'conflict' | 'deferred' | 'clarification_required' | 'uncertain' | 'audit_only';
  disposition: 'proceed' | 'deferred' | 'clarification_required';
  reason_code: string | null;
  successor_question_id: string | null;
  difference: string | null;
  missing: string[];
};
export type Consultation = {
  request_id: string;
  conversation_id: string;
  parent_work_id: string | null;
  status: 'pending' | 'waiting_user' | 'answered' | 'cancelled' | 'failed';
  result_version: number;
  final_result: { text: string } | null;
};
export type Messages = { items: { message_id: string; raw_text: string; role: 'user' | 'assistant' }[] };

function invalid(): never { throw new ClientError('INVALID_RESPONSE'); }
function data(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:-][A-Za-z0-9_.:-]{0,255}$/u.test(value)) return invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalid();
  return value as T;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null || value === undefined ? null : parse(value);
}
function array<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) return invalid();
  return value.map(parse);
}

export function parseWork(value: unknown): WorkItem {
  const row = data(value);
  return { work_id: id(row.work_id), generation: number(row.generation), updated_at: text(row.updated_at),
    state: choice(row.state, ['researching', 'awaiting_answer', 'verifying', 'paused', 'blocked', 'delivered']),
    attempt_ids: array(row.attempt_ids, number), question_id: nullable(row.question_id, id),
    delivery_id: nullable(row.delivery_id, id), revision: number(row.revision) };
}

export function parseWorkList(value: unknown): WorkList {
  const row = data(value);
  const counts = data(row.counts);
  return { items: array(row.items, parseWork), next_cursor: nullable(row.next_cursor, text),
    counts: { open: number(counts.open), awaiting_answer: number(counts.awaiting_answer), blocked: number(counts.blocked) } };
}

export function parseTimeline(value: unknown): Timeline {
  return { items: array(data(value).items, (entry) => {
    const row = data(entry);
    return { event_id: text(row.event_id), type: text(row.type), at: text(row.at) };
  }) };
}

export function parseQuestion(value: unknown): Question {
  const row = data(value);
  const options = row.options === undefined ? [] : array(row.options, (entry) => {
    const opt = data(entry);
    return { option_id: id(opt.option_id), index: number(opt.index), label: text(opt.label),
      next_action: opt.next_action === undefined || opt.next_action === null ? null : text(opt.next_action),
      difference: opt.difference === undefined || opt.difference === null ? null : text(opt.difference),
      missing: stringList(opt.missing) };
  }).sort((a, b) => a.index - b.index);
  if (new Set(options.map((option) => option.option_id)).size !== options.length
    || new Set(options.map((option) => option.index)).size !== options.length) return invalid();
  const hash = text(row.options_hash);
  if (!/^[a-f0-9]{64}$/u.test(hash)) return invalid();
  return { work_id: id(row.work_id), generation: number(row.generation), question_id: id(row.question_id),
    question_version: number(row.question_version), proposal_revision: number(row.proposal_revision), options_hash: hash,
    status: choice(row.status, ['open', 'closed', 'superseded']), successor_question_id: nullable(row.successor_question_id, id),
    options, custom_allowed: row.custom_allowed === true, expires_at: nullable(row.expires_at, text) };
}

export function parseAnswerReceipt(value: unknown): AnswerReceipt {
  const row = data(value);
  const missing = row.missing ?? (typeof row.missing_json === 'string' ? JSON.parse(row.missing_json) as unknown : []);
  return { receipt_id: id(row.receipt_id), question_id: id(row.question_id),
    validity: choice(row.validity, ['verified', 'stale', 'rejected', 'conflict', 'deferred', 'clarification_required', 'uncertain', 'audit_only']),
    disposition: choice(row.disposition, ['proceed', 'deferred', 'clarification_required']),
    reason_code: nullable(row.reason_code, text), successor_question_id: nullable(row.successor_question_id, id),
    difference: nullable(row.difference, text), missing: array(missing, text) };
}

export function parseConsultation(value: unknown): Consultation {
  const row = data(value);
  return { request_id: id(row.request_id), conversation_id: id(row.conversation_id),
    parent_work_id: nullable(row.parent_work_id, id), status: choice(row.status, ['pending', 'waiting_user', 'answered', 'cancelled', 'failed']),
    result_version: number(row.result_version), final_result: nullable(row.final_result, (result) => ({ text: text(data(result).text) })) };
}

export function parseMessages(value: unknown): Messages {
  return { items: array(data(value).items, (entry) => {
    const row = data(entry);
    return { message_id: id(row.message_id), raw_text: text(row.raw_text), role: choice(row.role, ['user', 'assistant']) };
  }) };
}

export function safeResource(value: string | null | undefined): string | undefined {
  try { return id(value); } catch { return undefined; }
}

export function receiptResource(url: string, prefix: string, suffix = ''): string | undefined {
  if (!url.startsWith(prefix) || (suffix && !url.endsWith(suffix))) return undefined;
  return safeResource(url.slice(prefix.length, suffix ? -suffix.length : undefined));
}
