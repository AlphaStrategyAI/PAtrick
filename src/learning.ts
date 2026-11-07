import { DomainError, now, stableId, type SourceRevision } from './domain.js';
import type { Store } from './store.js';

export interface LearningRecord {
  sourceId: string;
  bookmarkId: string;
  state: 'pending' | 'checked';
  explanation: string | null;
  association: string | null;
  counterexample: string | null;
  reviewAt: string | null;
}

function learningPayload(record: LearningRecord): Record<string, unknown> {
  return { sourceId: record.sourceId, bookmarkId: record.bookmarkId, state: record.state, explanation: record.explanation, association: record.association, counterexample: record.counterexample, reviewAt: record.reviewAt };
}

function quotesBookmark(explanation: string, content: string): boolean {
  const text = content.replace(/\s+/g, ' ').trim();
  for (let index = 0; index + 12 <= text.length; index += 1) if (explanation.includes(text.slice(index, index + 12))) return true;
  return false;
}

export function learningId(sourceId: string): string {
  return stableId('learning', sourceId);
}

/** A saved bookmark still needs a grounded explanation, a link or an explicit none, a counterexample, and a review date. */
export function openLearning(store: Store, source: SourceRevision, bookmarkId: string): LearningRecord {
  const id = learningId(source.id);
  const existing = store.get('actions', id);
  if (existing?.kind === 'learning.bookmark' && existing.projectId === source.projectId && existing.domain === source.domain) {
    const saved = existing.payload as Partial<LearningRecord>;
    if (saved.sourceId === source.id && saved.bookmarkId === bookmarkId) return { sourceId: source.id, bookmarkId, state: existing.status === 'completed' ? 'checked' : 'pending', explanation: saved.explanation ?? null, association: saved.association ?? null, counterexample: saved.counterexample ?? null, reviewAt: saved.reviewAt ?? null };
  }
  const record: LearningRecord = { sourceId: source.id, bookmarkId, state: 'pending', explanation: null, association: null, counterexample: null, reviewAt: null };
  store.save('actions', { id, projectId: source.projectId, domain: source.domain, kind: 'learning.bookmark', status: 'pending', payload: learningPayload(record), updatedAt: now() });
  return record;
}

export function learningView(store: Store, source: SourceRevision): LearningRecord | undefined {
  if (!source.externalId.startsWith('x-bookmark:')) return;
  const action = store.get('actions', learningId(source.id));
  if (action?.kind !== 'learning.bookmark' || action.projectId !== source.projectId || action.domain !== source.domain) return;
  const saved = action.payload as Partial<LearningRecord>;
  if (saved.sourceId !== source.id) return;
  return { sourceId: source.id, bookmarkId: String(saved.bookmarkId ?? ''), state: action.status === 'completed' ? 'checked' : 'pending', explanation: saved.explanation ?? null, association: saved.association ?? null, counterexample: saved.counterexample ?? null, reviewAt: saved.reviewAt ?? null };
}

/** Accept a learning note only when its explanation repeats the bookmark and the review date is still ahead. */
export function completeLearning(store: Store, sourceId: string, input: { explanation: string; association: string; counterexample: string; reviewAt: string }, at = new Date()): LearningRecord {
  const source = store.get('sources', sourceId);
  const action = source && store.get('actions', learningId(source.id));
  if (!source || source.status !== 'active' || source.kind !== 'reading' || !source.externalId.startsWith('x-bookmark:') || !action || action.kind !== 'learning.bookmark' || action.projectId !== source.projectId) throw new DomainError('This bookmark has no open learning note.', 'learning_unready', 409);
  const saved = action.payload as Partial<LearningRecord>;
  const explanation = input.explanation.trim();
  const association = input.association.trim();
  const counterexample = input.counterexample.trim();
  const reviewAt = input.reviewAt.trim();
  const reviewTime = Date.parse(reviewAt);
  if (!quotesBookmark(explanation, source.content)) throw new DomainError('The explanation must repeat a passage from the bookmark.', 'learning_ungrounded', 409);
  if (association !== 'none') {
    const linked = store.get('sources', association);
    if (!linked || linked.status !== 'active' || linked.projectId !== source.projectId || linked.domain !== source.domain || linked.id === source.id) throw new DomainError('Link the bookmark to one active source in this project, or use none.', 'learning_ungrounded', 409);
  }
  if (counterexample.length < 8 || counterexample === explanation) throw new DomainError('A counterexample has to be its own statement.', 'learning_ungrounded', 409);
  if (!Number.isFinite(reviewTime) || reviewTime <= at.getTime() || reviewTime > at.getTime() + 366 * 86400000) throw new DomainError('The review date has to be within the next year.', 'learning_ungrounded', 409);
  const record: LearningRecord = { sourceId: source.id, bookmarkId: String(saved.bookmarkId ?? source.externalId.slice('x-bookmark:'.length)), state: 'checked', explanation, association, counterexample, reviewAt: new Date(reviewTime).toISOString() };
  store.save('actions', { ...action, status: 'completed', payload: learningPayload(record), updatedAt: at.toISOString() });
  return record;
}
