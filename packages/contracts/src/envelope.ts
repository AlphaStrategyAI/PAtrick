import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalPayload(value: Json): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalPayload).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return '{' + entries.map(([key, field]) => JSON.stringify(key) + ':' + canonicalPayload(field)).join(',') + '}';
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('PAYLOAD_NUMBER_INVALID');
  return JSON.stringify(value);
}

export type CommandBinding = {
  operation: string;
  resource_id: string | null;
  data_domain: string | null;
  expected_revision: number | null;
  payload_hash: string;
};

export function canonicalCommand(binding: CommandBinding): string {
  return canonicalPayload(binding);
}

export function commandEnvelope<T>(payload: z.ZodType<T>) {
  return z.strictObject({
    client_request_id: z.string().min(1),
    expected_revision: z.number().int().nonnegative().nullable(),
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
    payload,
  });
}

export const ALLOWED_SCHEMA_MAJORS = [1] as const;

export function schemaMajor(schemaVersion: string): number {
  const major = Number.parseInt(schemaVersion.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major)) throw new Error('SCHEMA_MAJOR_INVALID');
  return major;
}

export function assertAllowedSchemaMajor(schemaVersion: string): void {
  if (!(ALLOWED_SCHEMA_MAJORS as readonly number[]).includes(schemaMajor(schemaVersion))) {
    throw new Error('SCHEMA_MAJOR_UNSUPPORTED');
  }
}

export const allowedSchemaVersionSchema = z
  .string()
  .regex(/^[0-9]+\.[0-9]+$/)
  .superRefine((schemaVersion, ctx) => {
    try {
      assertAllowedSchemaMajor(schemaVersion);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'SCHEMA_MAJOR_UNSUPPORTED' });
    }
  });

export const errorBodySchema = z.strictObject({
  code: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  retryable: z.boolean(),
  correlation_id: z.string().min(1),
  current_revision: z.number().int().nonnegative().optional(),
});

export const watermarkSchema = z.strictObject({
  hub_seq: z.number().int().nonnegative(),
  domain_seq: z.number().int().nonnegative(),
});

export const scopeSchema = z.strictObject({
  account_id: z.string().min(1),
  data_domain: z.string().min(1),
  permission_epoch: z.number().int().nonnegative(),
});

export type Snapshot<T> = {
  schema_version: string;
  scope: z.infer<typeof scopeSchema>;
  as_of: string;
  watermark: z.infer<typeof watermarkSchema>;
  freshness: 'fresh' | 'stale' | 'syncing' | 'unknown';
  data: T;
  stream_cursor?: string;
};

export function snapshotEnvelope<T>(data: z.ZodType<T>) {
  return z.strictObject({
    schema_version: allowedSchemaVersionSchema,
    scope: scopeSchema,
    as_of: z.string().min(1),
    watermark: watermarkSchema,
    freshness: z.enum(['fresh', 'stale', 'syncing', 'unknown']),
    data,
    stream_cursor: z.string().min(1).optional(),
  });
}

export const sseEventSchema = z.strictObject({
  event_id: z.string().min(1),
  type: z.string().min(1),
  resource_id: z.string().nullable(),
  resource_revision: z.number().int().nonnegative().nullable(),
  scope: scopeSchema,
  as_of: z.string().min(1),
  watermark: watermarkSchema,
});

export const commandAcceptedSchema = z.strictObject({
  command_id: z.string().min(1),
  state: z.literal('received'),
  receipt_url: z.string().min(1),
});

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;
