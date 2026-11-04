import { DomainError, knowledgeOutputSchema, now, stableId, type KnowledgeCard, type SourceRevision } from './domain.js';
import { Store } from './store.js';

export function publishKnowledge(store: Store, source: SourceRevision, output: unknown): KnowledgeCard[] {
  const parsed = knowledgeOutputSchema.parse(output);
  const current = store.get('sources', source.id);
  if (current?.status !== 'active' || current.revision !== source.revision) throw new DomainError('Knowledge extraction refers to an obsolete source.', 'stale_source', 409);
  const cards = parsed.cards.map(candidate => {
    if (!source.content.includes(candidate.quote)) throw new DomainError('An extracted quote is absent from the authorized source.', 'invalid_quote');
    if (candidate.kind === 'experience' && candidate.experience?.productId !== source.projectId) throw new DomainError('Experience product must match its authorized project.', 'scope', 403);
    const aliases = [...new Set([...candidate.aliases, ...(candidate.experience?.symptomAliases ?? [])].map(value => value.trim()).filter(Boolean))];
    return { ...candidate, aliases, id: stableId('card', source.id, source.revision, candidate.kind, candidate.title, candidate.quote), projectId: source.projectId, domain: source.domain, sourceId: source.id, sourceRevision: source.revision, locator: source.locator, status: 'active' as const, createdAt: now() };
  });
  for (const card of cards) if (!store.get('cards', card.id)) store.save('cards', card);
  return cards;
}
