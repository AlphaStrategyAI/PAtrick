import { z } from 'zod';
import { commandEnvelope, scopeSchema, watermarkSchema } from './envelope.js';

const count = z.number().int().nonnegative();
const timestamp = z.iso.datetime({ precision: 3 });
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const previewId = z.string().min(1).max(128);
const requestScope = scopeSchema.extend({ caller_id: z.string().min(1) });

export const diagnosticsPreviewPayload = z.strictObject({ request_scope: requestScope });
export const diagnosticsExportPayload = diagnosticsPreviewPayload.extend({
  preview_id: previewId, manifest_hash: digest, watermark: watermarkSchema,
});
export const diagnosticsPreviewRequest = commandEnvelope(diagnosticsPreviewPayload).extend({ expected_revision: z.null() });
export const diagnosticsExportRequest = commandEnvelope(diagnosticsExportPayload).extend({ expected_revision: count });
export type DiagnosticsExportRequest = z.infer<typeof diagnosticsExportRequest>;

const projection = z.strictObject({
  freshness: z.enum(['fresh', 'stale', 'syncing', 'unknown']),
  as_of: timestamp.nullable(),
  work: z.strictObject({ open: count, awaiting_answer: count, blocked: count }).nullable(),
  connections: z.strictObject({
    vault: z.enum(['unknown', 'not_connected', 'checking', 'needs_install', 'needs_permission',
      'awaiting_confirmation', 'connected', 'degraded']),
    feishu: z.enum(['unknown', 'not_configured', 'checking', 'needs_binding', 'needs_test', 'needs_enable',
      'ready', 'degraded', 'draining', 'disabled', 'requires_reauthorization']),
  }),
  edits: z.strictObject({ pending: count, failed: count }).nullable(),
}).refine((value) => value.freshness === 'fresh' || (value.work === null && value.edits === null &&
  value.connections.vault === 'unknown' && value.connections.feishu === 'unknown'),
{ message: 'Unobserved facts must remain unknown' });

export const diagnosticsReportSchema = z.strictObject({ schema_version: z.literal('1.0'), projection });
export const diagnosticsPreviewSchema = z.strictObject({
  preview_id: previewId, revision: count, watermark: watermarkSchema,
  manifest_hash: digest, expires_at: timestamp, report: diagnosticsReportSchema,
});
export type DiagnosticsReport = z.infer<typeof diagnosticsReportSchema>;
export type DiagnosticsPreview = z.infer<typeof diagnosticsPreviewSchema>;
