import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  diagnosticsExportRequest, diagnosticsPreviewRequest, diagnosticsPreviewSchema, type DiagnosticsReport,
} from '../../packages/contracts/src/diagnostics.js';
import { verifiedDiagnosticsBytes } from '../../apps/web/src/features/system/diagnostics-download.js';

const report = {
  schema_version: '1.0',
  projection: { freshness: 'fresh', as_of: '2040-03-20T17:00:00.000Z', work: { open: 1, awaiting_answer: 0, blocked: 1 },
    connections: { vault: 'connected', feishu: 'unknown' }, edits: { pending: 0, failed: 0 } },
} as const satisfies DiagnosticsReport;
const scope = { account_id: 'fixture-owner', caller_id: 'fixture-web', data_domain: 'fixture-domain', permission_epoch: 1 };
const watermark = { hub_seq: 12, domain_seq: 23 };
const manifestHash = (body: string) => createHash('sha256').update(body).digest('hex');
const previewId = 'diagnostic_444d2fca-9cae-465b-a259-51e6df9258d5';
const expires_at = '2040-03-20T17:05:00.000Z';

function attachment(body: BodyInit, options?: HeadersInit) {
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8',
    'content-disposition': 'attachment; filename="patrick-diagnostics.json"', ...options } });
}
function preview(body: string, content: DiagnosticsReport = report) {
  return { preview_id: previewId, revision: 1, watermark, manifest_hash: manifestHash(body), expires_at, report: content };
}

test('diagnostic requests use explicit scope and revision and public preview rejects raw fields and statuses', () => {
  const base = { client_request_id: 'request', payload_hash: 'a'.repeat(64) };
  expect(diagnosticsPreviewRequest.safeParse({ ...base, expected_revision: null, payload: { request_scope: scope } }).success).toBe(true);
  expect(diagnosticsPreviewRequest.safeParse({ ...base, expected_revision: 1, payload: { request_scope: scope } }).success).toBe(false);
  const payload = { request_scope: scope, preview_id: previewId, manifest_hash: 'b'.repeat(64), watermark };
  expect(diagnosticsExportRequest.safeParse({ ...base, expected_revision: 1, payload }).success).toBe(true);
  expect(diagnosticsExportRequest.safeParse({ ...base, expected_revision: null, payload }).success).toBe(false);
  expect(diagnosticsExportRequest.safeParse({ ...base, expected_revision: 1, payload: { ...payload, destination: 'file-server' } }).success)
    .toBe(false);
  const valid = preview(JSON.stringify(report));
  expect(diagnosticsPreviewSchema.safeParse(valid).success).toBe(true);
  expect(diagnosticsPreviewSchema.safeParse({ ...valid, caller_id: scope.caller_id }).success).toBe(false);
  const projection = { ...report.projection, connections: { ...report.projection.connections, feishu: 'fixture-raw-data' } };
  expect(diagnosticsPreviewSchema.safeParse({ ...valid, report: { ...report, projection } }).success).toBe(false);
  expect(diagnosticsPreviewSchema.safeParse({ ...valid, report: { ...report, projection: { ...report.projection, logs: ['fixture'] } } }).success)
    .toBe(false);
});

test('verification preserves exact attachment bytes and rejects byte changes even when JSON is equivalent', async () => {
  const original = JSON.stringify(report, null, 2) + '\n';
  const agreed = preview(original);
  const signal = new AbortController().signal;
  const verified = await verifiedDiagnosticsBytes(attachment(original), agreed, signal);
  expect(Buffer.from(verified).toString()).toBe(original);
  await expect(verifiedDiagnosticsBytes(attachment(JSON.stringify(report)), agreed, signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

test('the digest does not authorize a different report or additional raw fields', async () => {
  const changed = { ...report, projection: { ...report.projection, work: { open: 2, awaiting_answer: 0, blocked: 2 } } };
  const body = JSON.stringify(changed);
  const signal = new AbortController().signal;
  await expect(verifiedDiagnosticsBytes(attachment(body), preview(body), signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  const raw = JSON.stringify({ ...report, credential: 'fixture-private-marker' });
  await expect(verifiedDiagnosticsBytes(attachment(raw), preview(raw), signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  const duplicate = '{"schema_version":"fixture-overwritten-value",' + JSON.stringify(report).slice(1);
  await expect(verifiedDiagnosticsBytes(attachment(duplicate), preview(duplicate), signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

test('nonattachments, oversized bodies and revoked access cannot produce bytes', async () => {
  const original = JSON.stringify(report);
  const agreed = preview(original);
  const signal = new AbortController().signal;
  await expect(verifiedDiagnosticsBytes(attachment(original, { 'content-disposition': 'inline' }), agreed, signal))
    .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  await expect(verifiedDiagnosticsBytes(attachment(' '.repeat(4097) + original), agreed, signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  const gate = new AbortController();
  let sourceCancelled = false;
  const source = new ReadableStream<Uint8Array>({ cancel() { sourceCancelled = true; } });
  const pending = verifiedDiagnosticsBytes(attachment(source), agreed, gate.signal);
  gate.abort(new Error('scope revoked'));
  await expect(pending).rejects.toThrow('scope revoked');
  expect(sourceCancelled).toBe(true);
});
