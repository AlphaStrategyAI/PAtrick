import { allowedSchemaVersionSchema, scopeSchema, sseEventSchema, watermarkSchema } from './envelope.js';
import { z } from 'zod';

export const DOMAIN_EVENTS = [
  { type: 'source.revision.committed', major: 1 },
  { type: 'work.requested', major: 1 },
  { type: 'work.stop.requested', major: 1 },
  { type: 'draft.requested', major: 1 },
  { type: 'draft.ready', major: 1 },
  { type: 'question.bound', major: 1 },
  { type: 'answer.verified', major: 1 },
  { type: 'evidence.ready', major: 1 },
  { type: 'consultation.requested', major: 1 },
  { type: 'decision.committed', major: 1 },
  { type: 'stats.fact.invalidated', major: 1 },
  { type: 'work.delivered', major: 1 },
  { type: 'evidence.invalidated', major: 1 },
  { type: 'capability.changed', major: 1 },
  { type: 'standard.candidate', major: 1 },
  { type: 'standard.activated', major: 1 },
  { type: 'vault.connection.changed', major: 1 },
  { type: 'edit.receipt.changed', major: 1 },
  { type: 'channel.test.updated', major: 1 },
  { type: 'channel.mode.changed', major: 1 },
  { type: 'settings.applied', major: 1 },
  { type: 'settings.verified', major: 1 },
  { type: 'effect.uncertain', major: 1 },
  { type: 'outcome.observed', major: 1 },
] as const;

export type DomainEventType = (typeof DOMAIN_EVENTS)[number]['type'];

export const domainEventSchema = sseEventSchema.extend({
  schema_version: allowedSchemaVersionSchema,
  payload: z.unknown(),
});

export function acceptEventVersion(
  type: string,
  schemaVersion: string,
): 'accept' | 'reject_unknown_major' {
  const catalog = DOMAIN_EVENTS.find((event) => event.type === type);
  if (!catalog) return 'reject_unknown_major';
  const major = Number.parseInt(schemaVersion.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major !== catalog.major) return 'reject_unknown_major';
  return 'accept';
}

export { scopeSchema, watermarkSchema };
