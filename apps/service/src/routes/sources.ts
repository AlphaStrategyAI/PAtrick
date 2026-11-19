import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { commandEnvelope, detectSourcePayload, rssHistoryPreviewPayload, type Json, type BrowserCreationScope } from '@patrick/contracts';
import { commandFingerprint, recordCommand, withDeferredTransaction, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { directoryReaderCapability, type RssHistoryActor, type SourceRegistry } from '@patrick/integrations/sources/registry';
import type { CredentialStore } from '@patrick/host';
import { assertDomainPermission, domainsWithPermission, requireSession, snapshot, type Principal } from '../auth.js';
import { assertBusinessWrite } from '../recovery-runtime.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, requirePermission, routeId } from './http.js';
import { oneValue } from './work.js';

type Ready = () => { db: SqliteDatabase; now: () => Date; registry: SourceRegistry;
  sourceCredentials?: CredentialStore };
type SourceRow = { source_id: string; connector_type: string; normalized_target: string; frequency: string;
  config_revision: number; status: string; updated_at: string };
type StoredCommand = { command_fingerprint: string; snapshot: string | null };
const detectSourceSchema = commandEnvelope(detectSourcePayload);
const select = 'source_id,connector_type,normalized_target,frequency,config_revision,status,updated_at';
const operation = 'detectSources';
const historyOperation = 'previewRssHistory';
const historyPayload = commandEnvelope(rssHistoryPreviewPayload);

export function mountSourceRoutes(app: Hono, ready: Ready) {
  const inFlight = new Map<string, { fingerprint: string; reply: Promise<string> }>();
  app.post('/api/v1/sources/credentials', (c) => handle(c, async () => {
    assertWriteOrigin(c.req.raw);
    await requirePermission(c.req.raw, 'owner');
    const { sourceCredentials } = ready();
    if (!sourceCredentials) throw new ApiError(503, 'UNAVAILABLE', { reason: 'credential_provider_not_configured' });
    const body = await readJson(c.req.raw) as { token?: unknown } | null;
    if (typeof body?.token !== 'string' || !body.token.trim() || body.token.length > 4096) {
      throw new ApiError(422, 'UNPROCESSABLE', { reason: 'credential' });
    }
    // The token is staged here and only the reference travels with a change.
    const secret = new TextEncoder().encode(body.token);
    c.header('Cache-Control', 'no-store');
    try {
      return c.json({ credential_ref: sourceCredentials.put(secret, 10 * 60 * 1000), version: 1 });
    } finally { secret.fill(0); }
  }));
  app.get('/api/v1/source-reader-capabilities', (c) => handle(c, async () => {
    c.header('Cache-Control', 'no-store');
    const principal = await requireSession(c.req.raw);
    const { db, now } = ready();
    const domain = sourceDomain(db, principal, oneValue(new URL(c.req.url).searchParams, 'domain'));
    return c.json(snapshot({ ...principal, domains: [domain] }, { directory: directoryReaderCapability }, now(), db));
  }));
  app.get('/api/v1/sources', (c) => handle(c, async () => {
    const principal = await requireSession(c.req.raw);
    const { db, now } = ready();
    const query = new URL(c.req.url).searchParams;
    const domain = sourceDomain(db, principal, oneValue(query, 'domain'));
    const cursor = oneValue(query, 'cursor') ?? '';
    const limit = oneValue(query, 'limit') ?? '50';
    if (!/^\d{1,3}$/u.test(limit) || +limit < 1 || +limit > 200) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'limit' });
    return c.json(withDeferredTransaction(db, () => {
      const items = db.prepare(`SELECT ${select} FROM source_configs WHERE account_id=? AND data_domain=? AND source_id>?
        ORDER BY source_id LIMIT ?`).all(principal.account_id, domain, cursor, +limit + 1) as SourceRow[];
      return snapshot({ ...principal, domains: [domain] }, { items: items.slice(0, +limit),
        next_cursor: items.length > +limit ? items[+limit - 1].source_id : null }, now(), db);
    }));
  }));

  app.get('/api/v1/sources/:id', (c) => handle(c, async () => {
    const principal = await requireSession(c.req.raw);
    const { db, now } = ready();
    const domain = sourceDomain(db, principal, oneValue(new URL(c.req.url).searchParams, 'domain'));
    const id = routeId(c.req.param('id'));
    const found = db.prepare(`SELECT ${select} FROM source_configs WHERE account_id=? AND data_domain=? AND source_id=?`)
      .get(principal.account_id, domain, id) as SourceRow | undefined;
    if (!found) forbidden();
    return c.json(snapshot({ ...principal, domains: [domain] }, found, now(), db));
  }));

  app.get('/api/v1/sources/:id/receipts', (c) => handle(c, async () => {
    const principal = await requireSession(c.req.raw);
    const { db, now } = ready();
    const domain = sourceDomain(db, principal, oneValue(new URL(c.req.url).searchParams, 'domain'));
    const id = routeId(c.req.param('id'));
    const found = db.prepare('SELECT 1 FROM source_configs WHERE account_id=? AND data_domain=? AND source_id=?')
      .get(principal.account_id, domain, id);
    if (!found) forbidden();
    const items = db.prepare(`SELECT event_id,config_revision,kind,cursor,object_count,observed_at,accepted,reason
      FROM collection_receipts WHERE source_id=?
      UNION ALL SELECT event_id,config_revision,kind,cursor,0 AS object_count,observed_at,1 AS accepted,NULL AS reason
        FROM http_source_config_receipts WHERE source_id=?
      ORDER BY observed_at DESC,event_id DESC LIMIT 50`).all(id, id) as (Record<string, unknown> & { accepted: number })[];
    return c.json(snapshot({ ...principal, domains: [domain] }, { items: items.map((item) => ({ ...item, accepted: item.accepted === 1 })) }, now(), db));
  }));

  app.get('/api/v1/sources/:id/history/:planId', (c) => handle(c, async () => {
    c.header('Cache-Control', 'no-store');
    const principal = await requireSession(c.req.raw);
    const { db, now, registry } = ready();
    const domain = sourceDomain(db, principal, oneValue(new URL(c.req.url).searchParams, 'domain'));
    const actor = historyActor(principal, domain);
    const id = routeId(c.req.param('id'));
    const planId = routeId(c.req.param('planId'));
    return c.json(withDeferredTransaction(db, () => {
      assertDomainPermission(db, principal, domain, 'sources.read');
      try {
        return snapshot({ ...principal, domains: [domain] }, registry.readRssHistory(actor, planId, id), now(), db);
      } catch (error) {
        if (error instanceof Error && error.message === 'SOURCE_NOT_FOUND') throw new ApiError(404, 'NOT_FOUND', { reason: 'history_plan' });
        return throwHistoryError(error);
      }
    }));
  }));

  app.post('/api/v1/sources/:id/history/preview', (c) => handle(c, async () => {
    c.header('Cache-Control', 'no-store');
    assertWriteOrigin(c.req.raw);
    const parsed = historyPayload.safeParse(await readJson(c.req.raw));
    if (!parsed.success || !parsed.data.expected_revision) {
      throw new ApiError(422, 'UNPROCESSABLE', { reason: 'history_preview' });
    }
    const { payload, payload_hash, client_request_id, expected_revision } = parsed.data;
    assertPayloadHash(payload as Json, payload_hash);
    const principal = await requireSession(c.req.raw);
    const { db, now, registry } = ready();
    bindHistoryScope(db, principal, payload.request_scope);
    const domain = payload.request_scope.data_domain;
    const actor = historyActor(principal, domain);
    const id = routeId(c.req.param('id'));
    const key = JSON.stringify([principal.account_id, principal.caller_id, client_request_id]);
    const planId = 'history_' + createHash('sha256').update(key).digest('hex');
    const fingerprint = commandFingerprint({ operation: historyOperation, resource_id: id, data_domain: domain,
      expected_revision, payload_hash });
    const find = () => db.prepare(`SELECT i.command_fingerprint,p.preview_snapshot AS snapshot FROM command_inbox i
      LEFT JOIN http_source_history_plans p ON p.plan_id=i.command_id
      WHERE i.account_id=? AND i.caller_id=? AND i.client_request_id=?`)
      .get(principal.account_id, principal.caller_id, client_request_id) as StoredCommand | undefined;
    const saved = find();
    if (saved) return c.body(checkStored(saved, fingerprint), 200, { 'content-type': 'application/json' });
    const prepared = await registry.prepareRssHistory(actor, id, expected_revision, {
      from: payload.from, until: payload.until, maxObjects: payload.max_objects, maxBytes: payload.max_bytes,
    }).catch(throwHistoryError);
    const current = await requireSession(c.req.raw);
    const result = withImmediateTransaction(db, () => {
      bindHistoryScope(db, current, payload.request_scope);
      const previous = find();
      if (previous) return checkStored(previous, fingerprint);
      recordCommand(db, { account_id: actor.accountId, caller_id: actor.callerId, client_request_id,
        command_fingerprint: fingerprint, command_id: planId });
      const observedAt = now();
      const view = historyCall(() => registry.freezeRssHistory(actor, planId, prepared));
      const response = JSON.stringify(snapshot({ ...current, domains: [domain] }, view, observedAt, db));
      db.prepare(`INSERT INTO command_records (command_id,account_id,caller_id,operation,resource_id,data_domain,permission,created_at)
        VALUES (?,?,?,?,?,?,'owner',?)`).run(planId, actor.accountId, actor.callerId, historyOperation, id, domain, observedAt.toISOString());
      db.prepare('UPDATE http_source_history_plans SET preview_snapshot=? WHERE plan_id=?').run(response, planId);
      return response;
    });
    return c.body(result, 200, { 'content-type': 'application/json' });
  }));

  app.post('/api/v1/sources/detect', (c) => handle(c, async () => {
    assertWriteOrigin(c.req.raw);
    const checked = detectSourceSchema.safeParse(await readJson(c.req.raw));
    if (!checked.success || checked.data.expected_revision !== null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'source_draft' });
    const { payload, payload_hash, client_request_id } = checked.data;
    assertPayloadHash(payload as Json, payload_hash);
    const principal = await requireSession(c.req.raw);
    const { db, now, registry } = ready();
    bindScope(db, principal, payload.request_scope);
    const domain = payload.request_scope.data_domain;
    const fingerprint = commandFingerprint({ operation, resource_id: payload.target, expected_revision: null,
      data_domain: domain, payload_hash });
    const key = JSON.stringify([principal.account_id, principal.caller_id, client_request_id]);
    const get = () => db.prepare(`SELECT i.command_fingerprint,p.snapshot FROM command_inbox i
      LEFT JOIN source_preview_receipts p ON p.command_id=i.command_id
      WHERE i.account_id=? AND i.caller_id=? AND i.client_request_id=?`)
      .get(principal.account_id, principal.caller_id, client_request_id) as StoredCommand | undefined;
    const saved = get();
    if (saved) return c.body(checkStored(saved, fingerprint), 200, { 'content-type': 'application/json' });
    assertBusinessWrite(db, domain);
    const active = inFlight.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) conflict();
      const reply = await active.reply;
      bindScope(db, await requireSession(c.req.raw), payload.request_scope);
      return c.body(reply, 200, { 'content-type': 'application/json' });
    }
    if (inFlight.size >= 64) throw new ApiError(429, 'RATE_LIMITED', { reason: 'source_preview' }, true);
    const reply = (async () => {
      let preview;
      try { preview = await registry.detectSource({ accountId: principal.account_id, dataDomain: domain },
        { type: payload.type, target: payload.target, repo: payload.repo, branch: payload.branch,
          path: payload.path, credentialRef: payload.credential_ref }, { signal: c.req.raw.signal,
          async assertLive() {
            bindScope(db, await requireSession(c.req.raw), payload.request_scope);
            assertBusinessWrite(db, domain);
          } }); }
      catch (cause) {
        if (cause instanceof ApiError || !(cause instanceof Error)) throw cause;
        if (cause.message === 'SOURCE_ROOT_TAKEN') throw new ApiError(409, 'CONFLICT', { reason: 'source_exists' });
        if (cause.message === 'SOURCE_TARGET_OUTSIDE_SCOPE') throw new ApiError(422, 'UNPROCESSABLE', { reason: 'source_target' });
        if (cause.message === 'SOURCE_TARGET_INVALID') throw new ApiError(422, 'UNPROCESSABLE', { reason: 'source_target' });
        if (cause.message === 'DIRECTORY_READER_UNAVAILABLE') throw new ApiError(503, 'UNAVAILABLE', { reason: 'source_reader' }, true);
        if (['SOURCE_URL_INVALID', 'SOURCE_CREDENTIAL_IN_TARGET', 'SOURCE_REQUIRES_LOGIN', 'SOURCE_MEDIA_TYPE',
          'SOURCE_FEED_INVALID', 'SOURCE_XML_DTD_DENIED', 'SOURCE_HTML_REDIRECT'].includes(cause.message)) {
          throw new ApiError(422, 'UNPROCESSABLE', { reason: 'source_preview' });
        }
        throw new ApiError(503, 'UNAVAILABLE', { reason: 'source_preview' }, true);
      }
      const current = await requireSession(c.req.raw);
      return withImmediateTransaction(db, () => {
        bindScope(db, current, payload.request_scope);
        const same = get();
        if (same) return checkStored(same, fingerprint);
        const observedAt = now();
        assertBusinessWrite(db, domain);
        const commandId = 'preview_' + createHash('sha256').update(key).digest('hex');
        recordCommand(db, { account_id: current.account_id, caller_id: current.caller_id, client_request_id,
          command_fingerprint: fingerprint, command_id: commandId });
        const result = JSON.stringify(snapshot({ ...current, domains: [domain] }, {
          preview_id: commandId, target: preview.normalizedTarget, type: payload.type, duplicate_source_id: preview.sourceId,
          draft_hash: preview.draftHash, allowed_urls: preview.scope.httpTargets ?? [], samples: preview.samples, expires_at: preview.expiresAt,
        }, observedAt, db));
        db.prepare(`INSERT INTO command_records(command_id,account_id,caller_id,operation,resource_id,data_domain,permission,created_at)
          VALUES (?,?,?,?,?,?,'sources.detect',?)`).run(commandId, current.account_id, current.caller_id, operation, commandId, domain, observedAt.toISOString());
        db.prepare('INSERT INTO source_preview_receipts(command_id,snapshot,baseline) VALUES (?,?,?)')
          .run(commandId, result, JSON.stringify(preview.httpBaseline ?? []));
        return result;
      });
    })();
    inFlight.set(key, { fingerprint, reply });
    try { return c.body(await reply, 200, { 'content-type': 'application/json' }); }
    finally { inFlight.delete(key); }
  }));
}

function sourceDomain(db: SqliteDatabase, principal: Principal, requested?: string): string {
  const domains = domainsWithPermission(db, principal, 'sources.read');
  const selected = requested ?? domains[0];
  if (!selected || !domains.includes(selected)) forbidden();
  return selected;
}

function bindScope(db: SqliteDatabase, principal: Principal, expected: BrowserCreationScope) {
  if (expected.account_id !== principal.account_id || expected.caller_id !== principal.caller_id ||
      expected.permission_epoch !== principal.auth_epoch || !principal.domains.includes(expected.data_domain)) forbidden();
  assertDomainPermission(db, principal, expected.data_domain, 'sources.detect');
}

function bindHistoryScope(db: SqliteDatabase, principal: Principal, expected: BrowserCreationScope) {
  bindScope(db, principal, expected);
  assertDomainPermission(db, principal, expected.data_domain, 'owner', false);
}

function historyActor(principal: Principal, domain: string): RssHistoryActor {
  return { accountId: principal.account_id, callerId: principal.caller_id, authEpoch: principal.auth_epoch, dataDomain: domain };
}

function historyCall<T>(run: () => T): T {
  try { return run(); } catch (error) { return throwHistoryError(error); }
}

function throwHistoryError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  if (['SOURCE_NOT_FOUND', 'SOURCE_TARGET_OUTSIDE_SCOPE'].includes(error.message)) forbidden();
  if (error.message === 'SOURCE_HISTORY_BUDGET_EXCEEDED') throw new ApiError(422, 'UNPROCESSABLE', { reason: 'history_budget' });
  if (error.message === 'SOURCE_HISTORY_INVALID') throw new ApiError(422, 'UNPROCESSABLE', { reason: 'history_preview' });
  if (error.message === 'SOURCE_HISTORY_EVIDENCE_REQUIRED') throw new ApiError(409, 'CONFLICT', { reason: 'history_evidence_required' });
  if (error.message === 'SOURCE_HISTORY_STALE') throw new ApiError(409, 'VALIDATION_STALE', { reason: 'history_binding_changed' });
  throw error;
}

function checkStored(saved: StoredCommand, fingerprint: string): string {
  if (saved.command_fingerprint !== fingerprint || !saved.snapshot) conflict();
  return saved.snapshot;
}

function conflict(): never { throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' }); }
function forbidden(): never { throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' }); }
