import { createHash } from 'node:crypto';
import type { KnowledgeCard } from './domain.js';

const normalizedAliases = (values: string[]): string[] => [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();

/** Bind candidate content, never its display verification, timestamps or derived authority. */
export function knowledgeCandidateHash(card: KnowledgeCard): string {
  const experience = card.experience;
  const identity = {
    id: card.id, sourceId: card.sourceId, sourceRevision: card.sourceRevision,
    projectId: card.projectId, domain: card.domain, title: card.title, body: card.body,
    quote: card.quote, locator: card.locator, aliases: normalizedAliases(card.aliases), kind: card.kind,
    experience: experience ? {
      schemaVersion: experience.schemaVersion, problem: experience.problem,
      symptomAliases: normalizedAliases(experience.symptomAliases), solution: experience.solution,
      files: experience.files, productId: experience.productId, codeVersion: experience.codeVersion,
      environment: experience.environment, invalidationConditions: experience.invalidationConditions,
    } : null,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
