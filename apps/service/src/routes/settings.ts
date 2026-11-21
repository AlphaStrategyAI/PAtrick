import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { Hono } from 'hono';
import { connectivityProbeHosts } from '../../../../packages/host/src/network/probes.js';
import { commandEnvelope, emptySchema, settingsChangePayload, settingsControlPayload, settingsDraftSchema } from '@patrick/contracts';
import { domainsWithPermission, readPresentedToken, requireSession, snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import type { SqliteDatabase } from '@patrick/storage';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, routeId } from './http.js';
import { oneValue } from './work.js';
import type { createSettingsChanges } from '../settings/changes.js';
import { runSettingsInspections } from '../settings/inspections.js';
import type { probeExecutorReadiness } from '@patrick/executor/readiness';

/** Operations that only report what the service observed; they never change a setting. */
const INSPECT_ONLY_OPERATIONS = new Set(['inspect_executor', 'inspect_host']);

export const settingsGroups = [
  { id: 'collection', operations: ['configure_source', 'enable_github_source'] },
  { id: 'materials', operations: ['connect_vault', 'change_vault', 'enable_work_directory', 'change_work_directory'] },
  { id: 'execution', operations: ['inspect_executor'] },
  { id: 'operation', operations: ['inspect_host', 'set_connectivity_targets', 'repair_network', 'start_backup', 'start_restore'] },
  { id: 'interaction', operations: ['set_feishu_connection', 'enable_feishu', 'disable_feishu', 'rebind_feishu',
    'rotate_feishu_credential'] },
  { id: 'preferences', operations: [] },
] as const;
const draftRequest = commandEnvelope(settingsDraftSchema);
const inspectionRequest = commandEnvelope(emptySchema);
const changeRequest = commandEnvelope(settingsChangePayload);
const controlRequest = commandEnvelope(settingsControlPayload);
type Ready = () => { db: SqliteDatabase; now: () => Date; engine: ReturnType<typeof createSettingsChanges>;
  recoveryTargets?: (principal: Principal, domain: string, operation: string) => readonly unknown[];
  networkTargets?: (principal: Principal, domain: string) => readonly unknown[];
  executorProbes?: typeof probeExecutorReadiness };

export function mountSettingsRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/settings', (c) => handle(c, async () => {
    const principal = await requireSession(c.req.raw);
    const { db, now, engine, networkTargets, recoveryTargets } = ready();
    const domain = getDomain(db, principal, 'settings.read', oneValue(new URL(c.req.url).searchParams, 'domain'));
    const groups = settingsGroups.map(({ id, operations }) => ({ id, operations: operations.map((operation) => ({
      operation, registered: INSPECT_ONLY_OPERATIONS.has(operation) ? true : engine.isRegistered(operation),
      kind: INSPECT_ONLY_OPERATIONS.has(operation) ? 'inspect' : 'change',
      origin: originOf(db, principal, domain, operation),
      targets: registeredTargets(db, principal, domain, operation, networkTargets, recoveryTargets),
    })) }));
    return c.json(snapshot({ ...principal, domains: [domain] }, { groups }, now(), db));
  }));

  app.post('/api/v1/settings/inspections', (c) => handle(c, async () => {
    assertWriteOrigin(c.req.raw);
    const parsed = inspectionRequest.safeParse(await readJson(c.req.raw));
    if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_inspection' });
    const { payload, payload_hash } = parsed.data;
    assertPayloadHash(payload, payload_hash);
    const principal = await requireSession(c.req.raw);
    const { db, now, networkTargets, recoveryTargets, executorProbes } = ready();
    const domain = getDomain(db, principal, 'settings.inspect', oneValue(new URL(c.req.url).searchParams, 'domain'));
    const result = await runSettingsInspections({ db, principal, domain, networkTargets, recoveryTargets, executorProbes });
    return c.json(snapshot({ ...principal, domains: [domain] }, result, now(), db));
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

  app.get('/api/v1/settings/changes/:id/recovery', (c) => handle(c, async () => {
    const principal = await requireSession(c.req.raw);
    const { db, now, engine } = ready();
    const changeId = routeId(c.req.param('id'));
    const original = engine.readScopedChange(principal, changeId);
    return c.json(snapshot({ ...principal, domains: [original.domain] }, engine.recoveryOffer(principal, changeId), now(), db));
  }));

  app.post('/api/v1/settings/changes/:id/recovery', (c) => handle(c, async () => {
    assertWriteOrigin(c.req.raw);
    const parsed = changeRequest.safeParse(await readJson(c.req.raw));
    if (!parsed.success || parsed.data.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'settings_recovery' });
    const { payload, payload_hash, expected_revision, client_request_id } = parsed.data;
    assertPayloadHash(payload, payload_hash);
    const principal = await requireSession(c.req.raw);
    const { db, now, engine } = ready();
    const changeId = routeId(c.req.param('id'));
    const original = engine.readScopedChange(principal, changeId);
    if (!payload.draft.input || typeof payload.draft.input !== 'object' || Array.isArray(payload.draft.input) ||
        payload.draft.input.change_id !== changeId) throw new ApiError(409, 'VALIDATION_STALE', { reason: 'change_binding' });
    const token = readPresentedToken(c.req.raw);
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const result = await engine.recoverSettings(principal, { changeId, draft: payload.draft, validationId: payload.validation_id,
      controlReceiptId: payload.control_receipt_id, requestId: client_request_id, expectedRevision: expected_revision,
      assertSession() {
        const live = db.prepare(`SELECT 1 FROM sessions s JOIN accounts a USING(account_id)
          WHERE s.token_hash=? AND s.account_id=? AND s.caller_id=? AND s.auth_epoch=?
            AND a.auth_epoch=s.auth_epoch AND s.expires_at>?`)
          .get(tokenHash, principal.account_id, principal.caller_id, principal.auth_epoch, now().toISOString());
        if (!live) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
      },
    });
    return c.json(snapshot({ ...principal, domains: [original.domain] }, result, now(), db));
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

function connectivityTarget(db: SqliteDatabase, principal: Principal, domain: string) {
  const row = db.prepare(`SELECT verified_intranet AS intranet, verified_public AS public, verified_revision AS revision
    FROM connectivity_probe_targets WHERE account_id=? AND data_domain=?`).get(principal.account_id, domain) as
    { intranet: string; public: string; revision: number } | undefined;
  const hosts = connectivityProbeHosts(row ? { intranet: row.intranet, public: row.public } : null);
  return [{ target: 'connectivity', device: hostname(), status: row && row.revision > 0 ? 'verified' : 'default',
    revision: row?.revision ?? 0, label: `${hosts.intranet} / ${hosts.public}`,
    input: { intranet_host: hosts.intranet, public_host: hosts.public } }];
}

function getDomain(db: SqliteDatabase, principal: Principal, permission: string, requested?: string): string {
  const domains = domainsWithPermission(db, principal, permission);
  const chosen = requested ?? domains[0];
  if (!chosen || !domains.includes(chosen)) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return chosen;
}

function registeredTargets(db: SqliteDatabase, principal: Principal, domain: string, operation: string,
  networkTargets?: (principal: Principal, domain: string) => readonly unknown[],
  recoveryTargets?: (principal: Principal, domain: string, operation: string) => readonly unknown[]) {
  if (!domainsWithPermission(db, principal, 'owner', false).includes(domain)) return [];
  if (operation === 'start_backup' || operation === 'start_restore') return recoveryTargets?.(principal, domain, operation) ?? [];
  if (operation === 'set_connectivity_targets') return connectivityTarget(db, principal, domain);
  if (operation === 'repair_network') return networkTargets?.(principal, domain) ?? [];
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

/** Where an entry comes from, so the owner can see why it is on the page.
 *
 * `detected` means PAtrick found it on this machine, `suggested` means it is
 * missing and PAtrick proposes it, `user` means the owner chose it, and
 * `inherited` means it comes from the host or the platform.
 */
function originOf(db: SqliteDatabase, principal: Principal, domain: string, operation: string):
'detected' | 'suggested' | 'user' | 'inherited' {
  if (operation === 'set_connectivity_targets') {
    const saved = db.prepare('SELECT 1 FROM connectivity_probe_targets WHERE account_id=? AND data_domain=? AND verified_revision>0')
      .get(principal.account_id, domain);
    return saved ? 'user' : 'suggested';
  }
  if (['inspect_executor', 'inspect_host', 'repair_network', 'start_backup', 'start_restore'].includes(operation)) return 'inherited';
  if (operation === 'enable_github_source') return 'detected';
  if (operation === 'configure_source') {
    const sources = db.prepare('SELECT COUNT(*) AS n FROM source_configs WHERE account_id=? AND data_domain=?')
      .get(principal.account_id, domain) as { n: number };
    return sources.n > 0 ? 'detected' : 'suggested';
  }
  if (operation === 'enable_work_directory' || operation === 'change_work_directory') {
    const directories = db.prepare(`SELECT COUNT(*) AS n FROM source_configs
      WHERE account_id=? AND data_domain=? AND connector_type='directory'`).get(principal.account_id, domain) as { n: number };
    return directories.n > 0 ? 'detected' : 'suggested';
  }
  if (operation === 'connect_vault' || operation === 'change_vault') {
    const vaults = db.prepare('SELECT COUNT(*) AS n FROM vaults WHERE account_id=? AND data_domain=?')
      .get(principal.account_id, domain) as { n: number };
    return vaults.n > 0 ? 'detected' : 'suggested';
  }
  if (['set_feishu_connection', 'enable_feishu', 'disable_feishu', 'rebind_feishu', 'rotate_feishu_credential'].includes(operation)) {
    const channels = db.prepare('SELECT COUNT(*) AS n FROM channel_connections WHERE account_id=? AND data_domain=?')
      .get(principal.account_id, domain) as { n: number };
    return channels.n > 0 ? 'detected' : 'suggested';
  }
  return 'user';
}
