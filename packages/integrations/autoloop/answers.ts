import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';

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
