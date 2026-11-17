import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { commandEnvelope, watermarkSchema } from '@patrick/contracts';
import { browserCreationScopeSchema, type BrowserCreationScope } from '@patrick/contracts/resources';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { buildDiagnostics, diagnosticDigest, type DiagnosticsReport } from '../../../../packages/host/src/diagnostics.js';
import { assertDomainPermission, readPresentedToken, requireSession, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson } from './http.js';

type Ready = () => { db: SqliteDatabase; now: () => Date };
type Watermark = z.infer<typeof watermarkSchema>;
type PreviewRow = Watermark & {
  preview_id: string; data_domain: string; permission_epoch: number; view_epoch: number; view_revision: number;
  manifest_hash: string; report_json: string; expires_at: string;
};
type Checkpoint = Watermark & {
  epoch: number; notification_seq: number; trusted_as_of: string | null; freshness: string;
  vault_status: unknown; feishu_status: unknown; edit_pending: unknown; edit_failed: unknown;
};
export type DiagnosticsPreview = {
  preview_id: string; revision: number; watermark: Watermark; manifest_hash: string; expires_at: string; report: DiagnosticsReport;
};

// Keep the endpoint schemas here until the shared resource table wires them in.
export const diagnosticsPreviewPayload = z.strictObject({ request_scope: browserCreationScopeSchema });
export const diagnosticsExportPayload = diagnosticsPreviewPayload.extend({
  preview_id: z.string().min(1).max(128), manifest_hash: z.string().regex(/^[a-f0-9]{64}$/u), watermark: watermarkSchema,
});
const previewEnvelope = commandEnvelope(diagnosticsPreviewPayload);
const exportEnvelope = commandEnvelope(diagnosticsExportPayload);
const ttlMs = 5 * 60_000;
const privateHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
const attachmentHeaders = { ...privateHeaders, 'content-type': 'application/json; charset=utf-8',
  'content-disposition': 'attachment; filename="patrick-diagnostics.json"' } as const;

export function mountDiagnosticsRoutes(app: Hono, ready: Ready): void {
  app.post('/api/v1/diagnostics/preview', (c) => handle(c, async () => {
    assertWriteOrigin(c.req.raw);
    const input = previewEnvelope.safeParse(await readJson(c.req.raw));
    if (!input.success || input.data.expected_revision !== null) invalid();
    const { payload, payload_hash, client_request_id } = input.data;
    assertPayloadHash(payload, payload_hash);
    const principal = await requireSession(c.req.raw);
    const tokenHash = presentedTokenHash(c.req.raw);
    const { db, now } = ready();
    return withImmediateTransaction(db, () => {
      const clock = now();
      const at = clock.toISOString();
      const scope = payload.request_scope;
      assertLive(db, principal, scope, tokenHash, at);
      const { command_id, created } = recordCommand(db, {
        account_id: principal.account_id, caller_id: principal.caller_id, client_request_id,
        command_id: 'diagnostic_' + randomUUID(),
        command_fingerprint: commandFingerprint({ operation: 'previewDiagnostics', data_domain: scope.data_domain,
          resource_id: null, payload_hash, expected_revision: null }),
      });
      const observation = observe(db, principal, scope.data_domain);
      if (!created) {
        const existing = loadPreview(db, principal, scope, command_id);
        assertCurrent(existing, observation, at);
        return c.json(renderPreview(existing, observation.report), 200, privateHeaders);
      }
      const preview: PreviewRow = {
        preview_id: command_id, data_domain: scope.data_domain, permission_epoch: scope.permission_epoch,
        view_epoch: observation.viewEpoch, view_revision: observation.revision, ...observation.watermark,
        manifest_hash: observation.manifestHash, report_json: observation.bytes,
        expires_at: new Date(clock.getTime() + ttlMs).toISOString(),
      };
      db.prepare(`INSERT INTO diagnostic_previews(preview_id,data_domain,permission_epoch,view_epoch,view_revision,
        hub_seq,domain_seq,manifest_hash,report_json,created_at,expires_at)
        VALUES (@preview_id,@data_domain,@permission_epoch,@view_epoch,@view_revision,
          @hub_seq,@domain_seq,@manifest_hash,@report_json,@created_at,@expires_at)`).run({ ...preview, created_at: at });
      return c.json(renderPreview(preview, observation.report), 200, privateHeaders);
    });
  }));

  app.post('/api/v1/diagnostics/export', (c) => handle(c, async () => {
    assertWriteOrigin(c.req.raw);
    const input = exportEnvelope.safeParse(await readJson(c.req.raw));
    if (!input.success || input.data.expected_revision === null) invalid();
    const { payload, payload_hash, expected_revision, client_request_id } = input.data;
    assertPayloadHash(payload, payload_hash);
    const principal = await requireSession(c.req.raw);
    const tokenHash = presentedTokenHash(c.req.raw);
    const { db, now } = ready();
    return withImmediateTransaction(db, () => {
      const at = now().toISOString();
      const scope = payload.request_scope;
      assertLive(db, principal, scope, tokenHash, at);
      const preview = loadPreview(db, principal, scope, payload.preview_id);
      if (preview.view_revision !== expected_revision || preview.manifest_hash !== payload.manifest_hash ||
          preview.hub_seq !== payload.watermark.hub_seq || preview.domain_seq !== payload.watermark.domain_seq) stale();
      assertCurrent(preview, observe(db, principal, scope.data_domain), at);
      recordCommand(db, {
        account_id: principal.account_id, caller_id: principal.caller_id, client_request_id,
        command_id: 'diagnostic_export_' + randomUUID(),
        command_fingerprint: commandFingerprint({ operation: 'exportDiagnostics', resource_id: preview.preview_id,
          data_domain: scope.data_domain, expected_revision, payload_hash }),
      });
      return c.body(preview.report_json, 200, attachmentHeaders);
    });
  }));
}

function presentedTokenHash(request: Request): string {
  const token = readPresentedToken(request);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
  return diagnosticDigest(token);
}

function assertLive(db: SqliteDatabase, principal: Principal, scope: BrowserCreationScope, tokenHash: string, at: string) {
  if (scope.account_id !== principal.account_id || scope.caller_id !== principal.caller_id ||
      scope.permission_epoch !== principal.auth_epoch) forbidden();
  if (!db.prepare(`SELECT 1 FROM sessions s JOIN accounts a USING(account_id)
    WHERE s.token_hash=? AND s.account_id=? AND s.caller_id=? AND s.auth_epoch=? AND a.auth_epoch=s.auth_epoch AND s.expires_at>?`)
    .get(tokenHash, principal.account_id, principal.caller_id, principal.auth_epoch, at)) {
    throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
  }
  assertDomainPermission(db, principal, scope.data_domain, 'owner', false);
}

function observe(db: SqliteDatabase, principal: Principal, domain: string) {
  const actor = [principal.account_id, domain];
  const checkpoint = db.prepare(`SELECT epoch,notification_seq,hub_seq,domain_seq,trusted_as_of,freshness,
    json_extract(health_payload,'$.connections.vault.status') AS vault_status,
    json_extract(health_payload,'$.connections.feishu.status') AS feishu_status,
    CASE WHEN json_type(health_payload,'$.edits.pending')='integer' THEN json_extract(health_payload,'$.edits.pending') END AS edit_pending,
    CASE WHEN json_type(health_payload,'$.edits.failed')='integer' THEN json_extract(health_payload,'$.edits.failed') END AS edit_failed
    FROM product_view_checkpoints WHERE account_id=? AND data_domain=?`).get(...actor) as Checkpoint | undefined;
  const work = checkpoint?.freshness === 'fresh' ? db.prepare(`SELECT COUNT(*) FILTER (WHERE state <> 'delivered') AS open,
    COUNT(*) FILTER (WHERE state='awaiting_answer') AS awaiting_answer, COUNT(*) FILTER (WHERE state IN ('blocked','paused')) AS blocked
    FROM product_work_views WHERE account_id=? AND data_domain=? AND visible=1`).get(...actor) as
    { open: number; awaiting_answer: number; blocked: number } : null;
  return {
    viewEpoch: checkpoint?.epoch ?? 0,
    revision: checkpoint?.notification_seq ?? 0,
    watermark: { hub_seq: checkpoint?.hub_seq ?? 0, domain_seq: checkpoint?.domain_seq ?? 0 },
    ...buildDiagnostics({ freshness: checkpoint?.freshness, asOf: checkpoint?.trusted_as_of, work,
      vaultStatus: checkpoint?.vault_status, feishuStatus: checkpoint?.feishu_status,
      edits: { pending: checkpoint?.edit_pending, failed: checkpoint?.edit_failed } }),
  };
}

function loadPreview(db: SqliteDatabase, principal: Principal, scope: BrowserCreationScope, id: string): PreviewRow {
  const preview = db.prepare(`SELECT p.* FROM diagnostic_previews p JOIN command_inbox i ON i.command_id=p.preview_id
    WHERE p.preview_id=? AND i.account_id=? AND i.caller_id=? AND p.data_domain=? AND p.permission_epoch=?`)
    .get(id, principal.account_id, principal.caller_id, scope.data_domain, principal.auth_epoch) as PreviewRow | undefined;
  if (!preview) forbidden();
  return preview;
}

function assertCurrent(preview: PreviewRow, current: ReturnType<typeof observe>, at: string) {
  if (preview.expires_at <= at || preview.view_epoch !== current.viewEpoch || preview.view_revision !== current.revision ||
      preview.hub_seq !== current.watermark.hub_seq || preview.domain_seq !== current.watermark.domain_seq ||
      preview.manifest_hash !== current.manifestHash || preview.report_json !== current.bytes) stale();
}

function renderPreview(preview: PreviewRow, report: DiagnosticsReport): DiagnosticsPreview {
  return { preview_id: preview.preview_id, revision: preview.view_revision, manifest_hash: preview.manifest_hash,
    watermark: { hub_seq: preview.hub_seq, domain_seq: preview.domain_seq }, expires_at: preview.expires_at, report };
}

function invalid(): never { throw new ApiError(422, 'UNPROCESSABLE', { reason: 'diagnostic_request' }); }
function forbidden(): never { throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' }); }
function stale(): never { throw new ApiError(409, 'CONFLICT', { reason: 'diagnostic_preview_changed' }); }
