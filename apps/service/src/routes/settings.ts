import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { commandEnvelope, settingsChangePayload, settingsControlPayload, settingsDraftSchema } from '@patrick/contracts';
import { domainsWithPermission, readPresentedToken, requireSession, snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import type { SqliteDatabase } from '@patrick/storage';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, routeId } from './http.js';
import { oneValue } from './work.js';
import type { createSettingsChanges } from '../settings/changes.js';

export const settingsGroups = [
  { id: 'collection', operations: ['configure_source'] },
  { id: 'materials', operations: ['connect_vault', 'change_vault'] },
  { id: 'execution', operations: ['inspect_executor'] },
  { id: 'operation', operations: ['inspect_host', 'start_backup', 'start_restore'] },
  { id: 'interaction', operations: ['enable_feishu', 'disable_feishu'] },
  { id: 'preferences', operations: [] },
] as const;
const draftRequest = commandEnvelope(settingsDraftSchema);
const changeRequest = commandEnvelope(settingsChangePayload);
const controlRequest = commandEnvelope(settingsControlPayload);
type Ready = () => { db: SqliteDatabase; now: () => Date; engine: ReturnType<typeof createSettingsChanges> };

export function mountSettingsRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/settings', (c) => handle(c, async () => {
    const principal = await requireSession(c.req.raw);
    const { db, now, engine } = ready();
    const domain = getDomain(db, principal, 'settings.read', oneValue(new URL(c.req.url).searchParams, 'domain'));
    const groups = settingsGroups.map(({ id, operations }) => ({ id, operations: operations.map((operation) => ({
      operation, registered: engine.isRegistered(operation), targets: registeredTargets(db, principal, domain, operation),
    })) }));
    return c.json(snapshot({ ...principal, domains: [domain] }, { groups }, now(), db));
  }));

  app.post('/api/v1/settings/validations', (c) => handle(c, async () => {
    assertWriteOrigin(c.req.raw);
    const result = draftRequest.safeParse(await readJson(c.req.raw));
    if (!result.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_draft' });
    const { payload, payload_hash, expected_revision, client_request_id } = result.data;
    assertPayloadHash(payload, payload_hash);
    const principal = await requireSession(c.req.raw);
    const { engine } = ready();
    return c.json(await engine.validateSettingsCommand(principal, payload, expected_revision, client_request_id));
  }));

  app.post('/api/v1/settings/control-proposals', (c) => handle(c, async () => {
    assertWriteOrigin(c.req.raw);
    const parsed = controlRequest.safeParse(await readJson(c.req.raw));
    if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_control' });
    const { payload, payload_hash, expected_revision, client_request_id } = parsed.data;
    assertPayloadHash(payload, payload_hash);
    const principal = await requireSession(c.req.raw);
    const { engine } = ready();
    return c.json(engine.prepareControl(principal, payload.draft, payload.validation_id, payload.challenge_id,
      expected_revision, client_request_id));
  }));

  app.post('/api/v1/settings/changes', (c) => handle(c, async () => {
    assertWriteOrigin(c.req.raw);
    const result = changeRequest.safeParse(await readJson(c.req.raw));
    if (!result.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_change' });
    const { payload, payload_hash, client_request_id, expected_revision } = result.data;
    assertPayloadHash(payload, payload_hash);
    const principal = await requireSession(c.req.raw);
    const { db, now, engine } = ready();
    const token = readPresentedToken(c.req.raw);
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const receipt = await engine.submitSettings(principal, { validationId: payload.validation_id, draft: payload.draft,
      controlReceiptId: payload.control_receipt_id, requestId: client_request_id, expectedRevision: expected_revision,
      assertSession() {
        const live = db.prepare(`SELECT 1 FROM sessions s JOIN accounts a USING(account_id)
          WHERE s.token_hash=? AND s.account_id=? AND s.caller_id=? AND s.auth_epoch=? AND a.auth_epoch=s.auth_epoch AND s.expires_at>?`)
          .get(tokenHash, principal.account_id, principal.caller_id, principal.auth_epoch, now().toISOString());
        if (!live) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
      },
    });
    return c.json({ command_id: receipt.change_id, state: 'received', receipt_url: '/api/v1/settings/changes/' + receipt.change_id }, 202);
  }));

  for (const prefix of ['/api/v1/settings/changes', '/api/v1/system/incidents']) {
    app.get(prefix + '/:id', (c) => handle(c, async () => {
      const principal = await requireSession(c.req.raw);
      const { db, now, engine } = ready();
      const result = engine.readScopedChange(principal, routeId(c.req.param('id')));
      return c.json(snapshot({ ...principal, domains: [result.domain] }, result.receipt, now(), db));
    }));
  }
}

function getDomain(db: SqliteDatabase, principal: Principal, permission: string, requested?: string): string {
  const domains = domainsWithPermission(db, principal, permission);
  const chosen = requested ?? domains[0];
  if (!chosen || !domains.includes(chosen)) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return chosen;
}

function registeredTargets(db: SqliteDatabase, principal: Principal, domain: string, operation: string) {
  if (!domainsWithPermission(db, principal, 'owner', false).includes(domain)) return [];
  if (operation === 'connect_vault') return db.prepare(`SELECT v.vault_id AS target,c.device_id AS device,
    v.status,v.config_revision AS revision FROM vaults v JOIN vault_clients c ON c.vault_id=v.vault_id
    WHERE v.account_id=? AND v.data_domain=? AND v.status='awaiting_confirmation'
    ORDER BY v.vault_id,c.device_id LIMIT 100`).all(principal.account_id, domain);
  if (operation === 'enable_feishu' || operation === 'disable_feishu') {
    return db.prepare(`SELECT connection_id AS target,NULL AS device,status,config_revision AS revision FROM channel_connections
      WHERE account_id=? AND data_domain=? AND status=? ORDER BY connection_id LIMIT 100`)
      .all(principal.account_id, domain, operation === 'enable_feishu' ? 'needs_enable' : 'ready');
  }
  return [];
}
