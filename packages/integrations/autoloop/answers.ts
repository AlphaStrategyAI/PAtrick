import { openDatabase, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';

export type HubAnswerBody = { choice: number } | { text: string };

export type LocalHubPort = {
  accept(
    questionId: string,
    cardId: number,
    body: HubAnswerBody,
  ): Promise<{ changed: boolean; state: string; answer_event_id: string }>;
  read(questionId: string): Promise<null | { cardId: number; state: string; answer_event_id: string; body: HubAnswerBody }>;
  list(questionId: string): Promise<Array<{ answer_event_id: string }>>;
  close(): void;
};

type HubRow = { card_id: number; body_json: string; answer_event_id: string };

/** The optional callback is a trusted in-process ownership handoff, before Hub initialization. */
export function createLocalHubPort(filePath: string, onDatabase?: (database: SqliteDatabase) => void): LocalHubPort {
  const db = openDatabase(filePath, { manifest: [] });
  try {
    onDatabase?.(db);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_answers (
      question_id TEXT PRIMARY KEY,
      card_id INTEGER NOT NULL,
      body_json TEXT NOT NULL,
      answer_event_id TEXT NOT NULL
    ) STRICT`);
    const insert = db.prepare(`INSERT INTO hub_answers (question_id, card_id, body_json, answer_event_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(question_id) DO NOTHING`);
    const select = db.prepare('SELECT card_id, body_json, answer_event_id FROM hub_answers WHERE question_id = ?');

    return {
      async accept(questionId, cardId, body) {
        const answerEventId = `hub:${questionId}:${cardId}`;
        const stored = withImmediateTransaction(db, () => {
          const info = insert.run(questionId, cardId, JSON.stringify(body), answerEventId);
          const row = select.get(questionId) as HubRow;
          return { changed: info.changes === 1, answer_event_id: row.answer_event_id };
        });
        return { changed: stored.changed, state: 'answered', answer_event_id: stored.answer_event_id };
      },
      async read(questionId) {
        const row = select.get(questionId) as HubRow | undefined;
        if (!row) return null;
        return { cardId: row.card_id, state: 'answered', answer_event_id: row.answer_event_id, body: parseBody(row.body_json) };
      },
      async list(questionId) {
        const row = select.get(questionId) as HubRow | undefined;
        return row ? [{ answer_event_id: row.answer_event_id }] : [];
      },
      close() {
        if (!db.open) return;
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
      },
    };
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
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

function parseBody(value: string): HubAnswerBody {
  const parsed = JSON.parse(value) as HubAnswerBody;
  if (parsed && typeof parsed === 'object' && 'choice' in parsed && typeof parsed.choice === 'number') return { choice: parsed.choice };
  if (parsed && typeof parsed === 'object' && 'text' in parsed && typeof parsed.text === 'string') return { text: parsed.text };
  throw new Error('HUB_ANSWER_INVALID');
}
