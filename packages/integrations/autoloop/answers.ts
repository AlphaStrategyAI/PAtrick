import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';

export type HubAnswerBody = { choice: number } | { text: string };

export type LocalHubPort = {
  accept(
    questionId: string,
    cardId: number,
    body: HubAnswerBody,
  ): Promise<{ changed: boolean; state: string; answer_event_id: string }>;
  read(questionId: string): Promise<null | { cardId: number; state: string; answer_event_id: string; body: HubAnswerBody }>;
  list(questionId: string): Promise<Array<{ answer_event_id: string }>>;
};

export function createLocalHubPort(): LocalHubPort {
  const accepted = new Map<string, { cardId: number; body: HubAnswerBody; answer_event_id: string }>();
  return {
    async accept(questionId, cardId, body) {
      const existing = accepted.get(questionId);
      if (existing) return { changed: false, state: 'answered', answer_event_id: existing.answer_event_id };
      const answer_event_id = `hub:${questionId}:${cardId}`;
      accepted.set(questionId, { cardId, body, answer_event_id });
      return { changed: true, state: 'answered', answer_event_id };
    },
    async read(questionId) {
      const row = accepted.get(questionId);
      if (!row) return null;
      return { cardId: row.cardId, state: 'answered', answer_event_id: row.answer_event_id, body: row.body };
    },
    async list(questionId) {
      const row = accepted.get(questionId);
      return row ? [{ answer_event_id: row.answer_event_id }] : [];
    },
  };
}

export function encodeHubAnswer(
  answer: { kind: 'choice'; index: number } | { kind: 'custom'; raw_text: string },
): { choice: number } | { text: string } {
  return answer.kind === 'choice' ? { choice: answer.index } : { text: answer.raw_text };
}

export function saveRawCustom(db: SqliteDatabase, submissionId: string, rawCustom: string, now = new Date().toISOString()): void {
  withImmediateTransaction(db, () => {
    db.prepare(`INSERT INTO raw_custom_answers (submission_id, raw_custom, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(submission_id) DO UPDATE SET raw_custom = excluded.raw_custom`).run(submissionId, rawCustom, now);
  });
}

export function readRawCustom(db: SqliteDatabase, submissionId: string): string {
  const row = db.prepare('SELECT raw_custom FROM raw_custom_answers WHERE submission_id = ?').get(submissionId) as
    | { raw_custom: string }
    | undefined;
  if (!row) throw new Error('RAW_CUSTOM_NOT_FOUND');
  return row.raw_custom;
}
