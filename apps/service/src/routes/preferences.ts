import { randomUUID } from 'node:crypto';
import { type Hono } from 'hono';
import { type SqliteDatabase, commandFingerprint, recordCommand, withDeferredTransaction, withImmediateTransaction } from '@patrick/storage';
import { preferencePayload, preferencePatchRequest } from '@patrick/contracts';
import { requireSession, snapshot } from '../auth.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson } from './http.js';

type Ready = () => { db: SqliteDatabase; now: () => Date };
const operation = 'patchPreferences';
const defaults = { revision: 0, mode: 'system' as const, reduced_motion: false, notifications: 'necessary' as const, quiet_hours: null };

export function mountPreferenceRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/preferences', (c) => handle(c, async () => {
    const principal = await requireSession(c.req.raw);
    const { db, now } = ready();
    return c.json(withDeferredTransaction(db, () => snapshot(principal, read(db, principal.account_id), now(), db)));
  }));
  app.patch('/api/v1/preferences', (c) => handle(c, async () => {
    assertWriteOrigin(c.req.raw);
    const request = preferencePatchRequest.safeParse(await readJson(c.req.raw));
    const principal = await requireSession(c.req.raw);
    if (!request.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'preferences' });
    const { payload, payload_hash, client_request_id, expected_revision } = request.data;
    assertPayloadHash(payload, payload_hash);
    if (payload.account_id !== principal.account_id || payload.auth_epoch !== principal.auth_epoch) {
      throw new ApiError(403, 'FORBIDDEN', { reason: 'preference_identity' });
    }
    const { db, now } = ready();
    const domain = principal.domains[0];
    if (!domain) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
    const fingerprint = commandFingerprint({ operation, resource_id: principal.account_id,
      data_domain: domain, expected_revision, payload_hash });
    const encoded = withImmediateTransaction(db, () => {
      const account = db.prepare('SELECT auth_epoch FROM accounts WHERE account_id=?').get(principal.account_id) as { auth_epoch: number } | undefined;
      if (!account || account.auth_epoch !== principal.auth_epoch) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'auth_epoch' });
      const previous = db.prepare(`SELECT i.command_fingerprint,r.body FROM command_inbox i
        LEFT JOIN preference_receipts r ON r.command_id=i.command_id
        WHERE i.account_id=? AND i.caller_id=? AND i.client_request_id=?`)
        .get(principal.account_id, principal.caller_id, client_request_id) as { command_fingerprint: string; body: string | null } | undefined;
      if (previous) {
        if (previous.command_fingerprint !== fingerprint || !previous.body) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
        return previous.body;
      }
      const prior = read(db, principal.account_id);
      if (expected_revision !== prior.revision) throw new ApiError(409, 'CONFLICT', { reason: 'revision' }, false, prior.revision);
      const { revision: priorRevision, ...current } = prior;
      const next = { ...current, ...payload.changes };
      const at = now();
      const revision = priorRevision + 1;
      db.prepare(`INSERT INTO account_preferences(account_id,revision,preferences,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,preferences=excluded.preferences,updated_at=excluded.updated_at`)
        .run(principal.account_id, revision, JSON.stringify(next), at.toISOString());
      const commandId = `prefs_${randomUUID()}`;
      recordCommand(db, { account_id: principal.account_id, caller_id: principal.caller_id, client_request_id,
        command_fingerprint: fingerprint, command_id: commandId });
      db.prepare(`INSERT INTO command_records(command_id,account_id,caller_id,operation,resource_id,data_domain,permission,created_at)
        VALUES (?,?,?,?,?,?,'session',?)`).run(commandId, principal.account_id, principal.caller_id,
        operation, principal.account_id, domain, at.toISOString());
      const body = JSON.stringify(snapshot(principal, { ...next, revision }, at, db));
      db.prepare('INSERT INTO preference_receipts(command_id,body) VALUES (?,?)').run(commandId, body);
      return body;
    });
    return c.body(encoded, 200, { 'content-type': 'application/json' });
  }));
}

function read(db: SqliteDatabase, accountId: string) {
  const stored = db.prepare('SELECT revision,preferences FROM account_preferences WHERE account_id=?').get(accountId) as
    { revision: number; preferences: string } | undefined;
  return stored ? { ...defaults, ...preferencePayload.parse(JSON.parse(stored.preferences)), revision: stored.revision } : defaults;
}
