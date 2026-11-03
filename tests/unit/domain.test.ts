import { describe, expect, it } from 'vitest';
import { stableId, digest, tokenize, safeRelativePath, questionAnswerSchema } from '../../src/domain.js';

describe('domain boundaries', () => {
  it('deduplicates only within the same authorization and source revision', () => {
    expect(stableId('a', 'message', 'v1')).toBe(stableId('a', 'message', 'v1'));
    expect(stableId('a', 'bc')).not.toBe(stableId('ab', 'c'));
    expect(stableId('personal', 'message')).not.toBe(stableId('work', 'message'));
    expect(digest('草稿')).not.toBe(digest('草稿 '));
  });
  it('indexes Chinese bigrams and English terms without FTS query syntax', () => {
    expect(tokenize('草稿恢复 Draft Recovery')).toContain('草稿');
    expect(tokenize('草稿恢复 Draft Recovery')).toContain('恢复');
    expect(tokenize('" OR *')).toBe('or');
  });
  it('rejects traversal, hidden git metadata and absolute paths', () => {
    for (const path of ['../PRD.md', '/etc/passwd', '.git/config', 'docs/../../key', 'C:\\x', 'docs\\..\\x']) {
      expect(() => safeRelativePath(path)).toThrow();
    }
    expect(safeRelativePath('docs/PRD.md')).toBe('docs/PRD.md');
  });
  it('requires custom text only for C and binds every answer to a version', () => {
    expect(questionAnswerSchema.safeParse({ questionId: 'q', taskVersion: 1, questionVersion: 1, choice: 'C', actorId: 'owner', eventId: 'e' }).success).toBe(false);
    expect(questionAnswerSchema.safeParse({ questionId: 'q', taskVersion: 1, questionVersion: 1, choice: 'A', actorId: 'owner', eventId: 'e' }).success).toBe(true);
  });
});
