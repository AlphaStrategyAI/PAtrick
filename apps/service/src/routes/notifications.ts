import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { commandEnvelope, type Snapshot } from '@patrick/contracts/envelope';
import { browserCreationScopeSchema, type BrowserCreationScope } from '@patrick/contracts/resources';
import { withDeferredTransaction, type SqliteDatabase } from '@patrick/storage';
import { assertDomainPermission, domainsWithPermission, readPresentedToken, requireSession, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson } from './http.js';
import { oneValue } from './work.js';

type Ready = () => { db: SqliteDatabase; now: () => Date };
type NotificationSummary = { pending: number; quiet: number; digest: number; checking: number; retrying: number; blocked: number };
type DigestPreview = { decision: number; blocker: number; delivered: number; progress: number };

const previewRequest = commandEnvelope(z.strictObject({ request_scope: browserCreationScopeSchema }));
const privateHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;

export function mountNotificationRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/notifications/summary', (c) => handle(c, async () => {
    const request = c.req.raw;
    const principal = await requireSession(request);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => key !== 'domain')) invalid();
    const domain = oneValue(query, 'domain');
    return c.json(readSnapshot(ready, request, principal, domain, summarize), 200, privateHeaders);
  }));
  app.post('/api/v1/notifications/preview', (c) => handle(c, async () => {
    const request = c.req.raw;
    assertWriteOrigin(request);
    const principal = await requireSession(request);
    const checked = previewRequest.safeParse(await readJson(request));
    if (!checked.success || checked.data.expected_revision !== null) invalid();
    const { payload, payload_hash } = checked.data;
    assertPayloadHash(payload, payload_hash);
    assertScope(principal, payload.request_scope);
    return c.json(readSnapshot(ready, request, principal, payload.request_scope.data_domain, preview), 200, privateHeaders);
  }));
}

type Observation<T> = (db: SqliteDatabase, accountId: string, domain: string, epoch: number, at: string) => T;

function readSnapshot<T>(
  ready: Ready, request: Request, principal: Principal, selected: string | undefined, observation: Observation<T>,
): Snapshot<T> {
  const { db, now } = ready();
  const token = readPresentedToken(request);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return withDeferredTransaction(db, () => {
    const { account_id, caller_id, auth_epoch } = principal;
    const at = now().toISOString();
    if (!db.prepare(`SELECT 1 FROM sessions s JOIN accounts a USING(account_id)
      WHERE s.token_hash=? AND s.account_id=? AND s.caller_id=? AND s.auth_epoch=?
        AND a.auth_epoch=s.auth_epoch AND s.expires_at>?`).get(tokenHash, account_id, caller_id, auth_epoch, at)) {
      throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
    }
    const domain = selected ?? domainsWithPermission(db, principal, 'owner', false)[0];
    if (!domain) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
    assertDomainPermission(db, principal, domain, 'owner', false);
    const watermark = db.prepare('SELECT hub_seq,domain_seq FROM product_view_checkpoints WHERE account_id=? AND data_domain=?')
      .get(account_id, domain) as Snapshot<T>['watermark'] | undefined;
    return {
      schema_version: '1.0',
      scope: { account_id, data_domain: domain, permission_epoch: auth_epoch },
      as_of: at, watermark: watermark ?? { hub_seq: 0, domain_seq: 0 }, freshness: 'fresh',
      data: observation(db, account_id, domain, auth_epoch, at),
    };
  });
}

// Aggregate only this session's unexpired, latest intent version. A later terminal
// intent still supersedes older work; recipient, evidence, and object IDs never leave SQLite.
const latest = `WITH live AS (
  SELECT n.kind,n.status FROM notification_intents n
  WHERE n.account_id=? AND n.data_domain=? AND n.auth_epoch=? AND n.expires_at>?
    AND n.status NOT IN ('sent','superseded')
    AND NOT EXISTS (SELECT 1 FROM notification_intents newer
      WHERE newer.account_id=n.account_id AND newer.data_domain=n.data_domain AND newer.object_id=n.object_id
        AND newer.channel=n.channel AND newer.auth_epoch=n.auth_epoch AND newer.event_version>n.event_version)
)`;

const summarize: Observation<NotificationSummary> = (db, ...scope) => db.prepare(`${latest}
  SELECT COUNT(*) FILTER (WHERE status='pending') AS pending, COUNT(*) FILTER (WHERE status='quiet') AS quiet,
    COUNT(*) FILTER (WHERE status='digest') AS digest, COUNT(*) FILTER (WHERE status IN ('sending','uncertain')) AS checking,
    COUNT(*) FILTER (WHERE status='retry_wait') AS retrying, COUNT(*) FILTER (WHERE status='blocked') AS blocked
  FROM live`).get(...scope) as NotificationSummary;

const preview: Observation<DigestPreview> = (db, ...scope) => db.prepare(`${latest}
  SELECT COUNT(*) FILTER (WHERE kind='decision') AS decision, COUNT(*) FILTER (WHERE kind='blocker') AS blocker,
    COUNT(*) FILTER (WHERE kind='delivered') AS delivered, COUNT(*) FILTER (WHERE kind='progress') AS progress
  FROM live WHERE status='digest'`).get(...scope) as DigestPreview;

function assertScope(principal: Principal, scope: BrowserCreationScope): void {
  if (scope.account_id !== principal.account_id || scope.caller_id !== principal.caller_id || scope.permission_epoch !== principal.auth_epoch) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
}

function invalid(): never {
  throw new ApiError(422, 'UNPROCESSABLE', { reason: 'notification_request' });
}
