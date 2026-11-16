import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { COSEALG } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { routes } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { ApiError, errorBody } from './errors.js';

export const ORIGIN = 'http://localhost';
export const RP_ID = 'localhost';
export const CHALLENGE_TTL_MS = 120_000;
export const BOOTSTRAP_TTL_MS = 120_000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const WEB_CALLER = 'web';
export const OWNER_DOMAIN = 'personal';

const SESSION_COOKIE = 'patrick_session';

export type Principal = {
  account_id: string;
  caller_id: string;
  auth_epoch: number;
  authenticated_at: string;
  domains: string[];
  operations: string[];
};

export type AuthContext = {
  db: SqliteDatabase;
  credentials: CredentialStore;
  now: () => Date;
};

type ChallengePurpose = 'registration' | 'authentication' | 'control';

type ChallengeRow = {
  challenge_id: string;
  account_id: string | null;
  purpose: ChallengePurpose;
  challenge: string;
  origin: string;
  rp_id: string;
  expires_at: string;
  consumed_at: string | null;
};

type SessionRow = {
  account_id: string;
  caller_id: string;
  auth_epoch: number;
  expires_at: string;
  authenticated_at: string;
  current_epoch: number;
};

const authStorage = new AsyncLocalStorage<AuthContext>();

const challengeRequest = routeRequest('createAuthChallenge');
const verifyRequest = routeRequest('verifyAuth');

export function authContext(): AuthContext {
  const current = authStorage.getStore();
  if (!current) throw new Error('AUTH_CONTEXT_MISSING');
  return current;
}

export async function runWithAuth<T>(context: AuthContext, fn: () => Promise<T>): Promise<T> {
  return authStorage.run(context, fn);
}

export function issueBootstrapTicket(
  db: SqliteDatabase,
  input: { accountId: string },
  now: () => Date = () => new Date(),
): { ticket: string; expires_at: string } {
  const createdAt = now().toISOString();
  const ticket = randomToken();
  const expiresAt = new Date(now().getTime() + BOOTSTRAP_TTL_MS).toISOString();
  withImmediateTransaction(db, () => {
    db.prepare(`INSERT INTO accounts (account_id, auth_epoch, policy_revision, created_at)
      VALUES (?, 1, 0, ?)
      ON CONFLICT(account_id) DO NOTHING`).run(input.accountId, createdAt);
    db.prepare(`INSERT INTO bootstrap_tickets (ticket_hash, account_id, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, NULL, ?)`).run(sha256(ticket), input.accountId, expiresAt, createdAt);
  });
  return { ticket, expires_at: expiresAt };
}

export function issueCallerSession(
  db: SqliteDatabase,
  input: { accountId: string; callerId: string; domain: string; permissions: readonly string[] },
  now: () => Date,
  credentials: CredentialStore,
): { token: string; authorization: string } {
  const account = db.prepare('SELECT auth_epoch FROM accounts WHERE account_id = ?').get(input.accountId) as { auth_epoch: number } | undefined;
  if (!account) throw new Error('ACCOUNT_NOT_FOUND');
  const token = randomToken();
  const authenticatedAt = now().toISOString();
  const expiresAt = new Date(now().getTime() + SESSION_TTL_MS).toISOString();
  const credentialRef = credentials.put(crypto.getRandomValues(new Uint8Array(32)), SESSION_TTL_MS);
  withImmediateTransaction(db, () => {
    db.prepare(`INSERT INTO sessions (
      token_hash, account_id, caller_id, auth_epoch, expires_at, authenticated_at, credential_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      sha256(token),
      input.accountId,
      input.callerId,
      account.auth_epoch,
      expiresAt,
      authenticatedAt,
      credentialRef,
    );
    const insertScope = db.prepare(`INSERT INTO caller_scopes (account_id, caller_id, data_domain, permission, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(account_id, caller_id, data_domain, permission) DO UPDATE SET revoked_at = NULL`);
    for (const permission of input.permissions) {
      insertScope.run(input.accountId, input.callerId, input.domain, permission);
    }
  });
  return { token, authorization: `Bearer ${token}` };
}

export function canConfirm(principal: Principal): boolean {
  if (principal.caller_id === 'mcp') return false;
  if (principal.operations.some((operation) => operation.startsWith('mcp:'))) return false;
  return principal.operations.includes('owner');
}

export async function requireSession(request: Request): Promise<Principal> {
  const token = readPresentedToken(request);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
  const { db, now } = authContext();
  const session = db.prepare(`SELECT s.account_id, s.caller_id, s.auth_epoch, s.expires_at, s.authenticated_at,
      a.auth_epoch AS current_epoch
    FROM sessions s
    JOIN accounts a ON a.account_id = s.account_id
    WHERE s.token_hash = ?`).get(sha256(token)) as SessionRow | undefined;
  if (!session || session.expires_at <= now().toISOString() || session.auth_epoch !== session.current_epoch) {
    throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
  }
  const scopes = db.prepare(`SELECT data_domain, permission FROM caller_scopes
    WHERE account_id = ? AND caller_id = ? AND revoked_at IS NULL
    ORDER BY data_domain, permission`).all(session.account_id, session.caller_id) as { data_domain: string; permission: string }[];
  return {
    account_id: session.account_id,
    caller_id: session.caller_id,
    auth_epoch: session.auth_epoch,
    authenticated_at: session.authenticated_at,
    domains: [...new Set(scopes.map((scope) => scope.data_domain))],
    operations: [...new Set(scopes.map((scope) => scope.permission))],
  };
}

export function snapshot(principal: Principal, data: unknown, now: Date, db: SqliteDatabase) {
  const cursor = db.prepare(`SELECT hub_seq, domain_seq FROM projection_cursors WHERE name = 'local'`).get() as {
    hub_seq: number;
    domain_seq: number;
  } | undefined;
  return {
    schema_version: '1.0',
    scope: {
      account_id: principal.account_id,
      data_domain: principal.domains[0] ?? OWNER_DOMAIN,
      permission_epoch: principal.auth_epoch,
    },
    as_of: now.toISOString(),
    watermark: {
      hub_seq: cursor?.hub_seq ?? 0,
      domain_seq: cursor?.domain_seq ?? 0,
    },
    freshness: 'fresh' as const,
    data,
  };
}

export function mountAuthRoutes(app: Hono): void {
  app.post('/api/v1/auth/challenge', (c) => handle(c, () => createChallenge(c)));
  app.post('/api/v1/auth/verify', (c) => handle(c, () => verifyChallenge(c)));
  app.get('/api/v1/session', (c) => handle(c, () => readSession(c)));
  app.delete('/api/v1/session', (c) => handle(c, () => deleteSession(c)));
  app.get('/api/v1/session/stream', (c) => openSessionStream(c));
}

export function assertBrowserOrigin(request: Request): void {
  if (request.headers.get('origin') !== ORIGIN) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'origin' });
  }
}

export function readPresentedToken(request: Request): string | null {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie) return cookie;
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token || null;
}

async function createChallenge(c: Context): Promise<Response> {
  assertBrowserOrigin(c.req.raw);
  const parsed = challengeRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as { rp_id: string };
  if (body.rp_id !== RP_ID) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'rp_id' });
  const bootstrap = c.req.header('x-patrick-bootstrap');
  if (bootstrap) return c.json(await beginRegistration(bootstrap));
  if (readPresentedToken(c.req.raw)) {
    const principal = await requireSession(c.req.raw);
    if (!canConfirm(principal)) throw new ApiError(403, 'FORBIDDEN', { reason: 'caller' });
    return c.json(await beginControlChallenge(principal));
  }
  return c.json(await beginAuthentication());
}

async function verifyChallenge(c: Context): Promise<Response> {
  assertBrowserOrigin(c.req.raw);
  const parsed = verifyRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as { challenge_id: string; credential: unknown };
  const credential = body.credential;
  if (!credential || typeof credential !== 'object' || !('id' in credential) || typeof credential.id !== 'string') {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'credential' });
  }
  const { db, credentials, now } = authContext();
  const row = loadChallenge(db, body.challenge_id, now());
  if (row.purpose === 'registration') {
    const verified = await verifyRegistration(credential, row.challenge);
    const session = storeRegistration(db, credentials, now, row, verified);
    return c.json({ session: publicSession(session.principal) }, 200, { 'set-cookie': session.cookie });
  }
  if (row.purpose === 'authentication') {
    const verified = await verifyAssertion(db, credential, row.challenge);
    const session = storeAuthentication(db, credentials, now, row, verified);
    return c.json({ session: publicSession(session.principal) }, 200, { 'set-cookie': session.cookie });
  }
  throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'challenge' });
}

async function readSession(c: Context): Promise<Response> {
  const { db, now } = authContext();
  const principal = await requireSession(c.req.raw);
  return c.json(snapshot(principal, {
    account_id: principal.account_id,
    caller_id: principal.caller_id,
    auth_epoch: principal.auth_epoch,
    domains: principal.domains,
    operations: principal.operations,
  }, now(), db));
}

async function deleteSession(c: Context): Promise<Response> {
  assertBrowserOrigin(c.req.raw);
  const token = readPresentedToken(c.req.raw);
  await requireSession(c.req.raw);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
  authContext().db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  return c.json({ ok: true as const }, 200, { 'set-cookie': clearSessionCookie() });
}

function openSessionStream(c: Context): Promise<Response> {
  return handle(c, async () => {
    const principal = await requireSession(c.req.raw);
    const { db } = authContext();
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        const finish = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          try {
            controller.close();
          } catch {
            // The client already stopped reading.
          }
        };
        controller.enqueue(encoder.encode(`event: open\ndata: ${principal.auth_epoch}\n\n`));
        timer = setInterval(() => {
          try {
            const row = db.prepare('SELECT auth_epoch FROM accounts WHERE account_id = ?').get(principal.account_id) as {
              auth_epoch: number;
            } | undefined;
            if (!row || row.auth_epoch !== principal.auth_epoch) {
              finish();
              return;
            }
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            finish();
          }
        }, 25);
        timer.unref();
      },
      cancel() {
        closed = true;
        if (timer) clearInterval(timer);
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    });
  });
}

async function beginRegistration(ticket: string): Promise<{ challenge_id: string; challenge: unknown }> {
  const { db, now } = authContext();
  const nowIso = now().toISOString();
  const ticketHash = sha256(ticket);
  const pending = db.prepare(`SELECT account_id FROM bootstrap_tickets
    WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?`).get(ticketHash, nowIso) as { account_id: string } | undefined;
  if (!pending) throw new ApiError(403, 'FORBIDDEN', { reason: 'bootstrap' });
  const options = await generateRegistrationOptions({
    rpName: 'PAtrick',
    rpID: RP_ID,
    userName: pending.account_id,
    userID: crypto.getRandomValues(new Uint8Array(16)),
    attestationType: 'none',
    supportedAlgorithmIDs: [COSEALG.ES256],
    timeout: CHALLENGE_TTL_MS,
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  const challengeId = `ch_${randomUUID()}`;
  const createdAt = nowIso;
  const expiresAt = new Date(now().getTime() + CHALLENGE_TTL_MS).toISOString();
  withImmediateTransaction(db, () => {
    const consumed = db.prepare(`UPDATE bootstrap_tickets
      SET consumed_at = ?
      WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?
      RETURNING account_id`).get(nowIso, ticketHash, nowIso) as { account_id: string } | undefined;
    if (!consumed) throw new ApiError(403, 'FORBIDDEN', { reason: 'bootstrap' });
    db.prepare(`INSERT INTO auth_challenges (
      challenge_id, account_id, purpose, challenge, challenge_hash, origin, rp_id, expires_at, consumed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
      challengeId,
      consumed.account_id,
      'registration',
      options.challenge,
      sha256(options.challenge),
      ORIGIN,
      RP_ID,
      expiresAt,
      createdAt,
    );
  });
  return { challenge_id: challengeId, challenge: options };
}

async function beginAuthentication(): Promise<{ challenge_id: string; challenge: unknown }> {
  const { db, now } = authContext();
  const credentials = db.prepare('SELECT credential_id AS id FROM passkey_credentials').all() as { id: string }[];
  if (credentials.length === 0) throw new ApiError(403, 'FORBIDDEN', { reason: 'registration_required' });
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
    allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: ['internal'] })),
  });
  const challengeId = insertChallenge(db, now, {
    accountId: null,
    purpose: 'authentication',
    challenge: options.challenge,
  });
  return { challenge_id: challengeId, challenge: options };
}

async function beginControlChallenge(principal: Principal): Promise<{ challenge_id: string; challenge: unknown }> {
  const { db, now } = authContext();
  const credentials = db.prepare('SELECT credential_id AS id FROM passkey_credentials WHERE account_id = ?').all(principal.account_id) as { id: string }[];
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
    allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: ['internal'] })),
  });
  const challengeId = insertChallenge(db, now, {
    accountId: principal.account_id,
    purpose: 'control',
    challenge: options.challenge,
  });
  return { challenge_id: challengeId, challenge: options };
}

async function verifyRegistration(credential: object, expectedChallenge: string) {
  try {
    const verified = await verifyRegistrationResponse({
      response: credential as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [COSEALG.ES256],
    });
    if (!verified.verified) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'assertion' });
    return verified.registrationInfo;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'assertion' });
  }
}

async function verifyAssertion(db: SqliteDatabase, credential: object, expectedChallenge: string) {
  const credentialId = 'id' in credential && typeof credential.id === 'string' ? credential.id : '';
  const stored = db.prepare('SELECT account_id, public_key, counter FROM passkey_credentials WHERE credential_id = ?').get(credentialId) as {
    account_id: string;
    public_key: Buffer;
    counter: number;
  } | undefined;
  if (!stored) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'credential' });
  try {
    const verified = await verifyAuthenticationResponse({
      response: credential as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: credentialId,
        publicKey: new Uint8Array(stored.public_key),
        counter: stored.counter,
      },
    });
    if (!verified.verified) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'assertion' });
    return { accountId: stored.account_id, credentialId, counter: verified.authenticationInfo.newCounter };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'assertion' });
  }
}

function storeRegistration(
  db: SqliteDatabase,
  credentials: CredentialStore,
  now: () => Date,
  row: ChallengeRow,
  registration: Awaited<ReturnType<typeof verifyRegistration>>,
): { principal: Principal; cookie: string } {
  if (!row.account_id) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'challenge' });
  const accountId = row.account_id;
  const nowIso = now().toISOString();
  return withImmediateTransaction(db, () => {
    consumeAuthChallenge(db, row, nowIso);
    db.prepare(`INSERT INTO passkey_credentials (credential_id, account_id, public_key, counter, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      registration.credential.id,
      accountId,
      Buffer.from(registration.credential.publicKey),
      registration.credential.counter,
      nowIso,
    );
    grantWebOwner(db, accountId);
    return insertWebSession(db, credentials, now, accountId, nowIso);
  });
}

function storeAuthentication(
  db: SqliteDatabase,
  credentials: CredentialStore,
  now: () => Date,
  row: ChallengeRow,
  authentication: { accountId: string; credentialId: string; counter: number },
): { principal: Principal; cookie: string } {
  const nowIso = now().toISOString();
  return withImmediateTransaction(db, () => {
    consumeAuthChallenge(db, row, nowIso);
    db.prepare('UPDATE passkey_credentials SET counter = ? WHERE credential_id = ?').run(authentication.counter, authentication.credentialId);
    return insertWebSession(db, credentials, now, authentication.accountId, nowIso);
  });
}

function consumeAuthChallenge(db: SqliteDatabase, row: ChallengeRow, nowIso: string): void {
  const consumed = db.prepare(`UPDATE auth_challenges
    SET consumed_at = ?
    WHERE challenge_id = ? AND purpose = ? AND origin = ? AND rp_id = ? AND consumed_at IS NULL AND expires_at > ?
    RETURNING challenge_id`).get(nowIso, row.challenge_id, row.purpose, ORIGIN, RP_ID, nowIso);
  if (!consumed) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'challenge' });
}

function insertWebSession(
  db: SqliteDatabase,
  credentials: CredentialStore,
  now: () => Date,
  accountId: string,
  nowIso: string,
): { principal: Principal; cookie: string } {
  const account = db.prepare('SELECT auth_epoch FROM accounts WHERE account_id = ?').get(accountId) as { auth_epoch: number };
  const token = randomToken();
  const expiresAt = new Date(now().getTime() + SESSION_TTL_MS).toISOString();
  const credentialRef = credentials.put(crypto.getRandomValues(new Uint8Array(32)), SESSION_TTL_MS);
  db.prepare(`INSERT INTO sessions (
    token_hash, account_id, caller_id, auth_epoch, expires_at, authenticated_at, credential_ref
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sha256(token), accountId, WEB_CALLER, account.auth_epoch, expiresAt, nowIso, credentialRef);
  const principal: Principal = {
    account_id: accountId,
    caller_id: WEB_CALLER,
    auth_epoch: account.auth_epoch,
    authenticated_at: nowIso,
    domains: [OWNER_DOMAIN],
    operations: ['commands.read', 'owner'],
  };
  return { principal, cookie: sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)) };
}

function grantWebOwner(db: SqliteDatabase, accountId: string): void {
  const insert = db.prepare(`INSERT INTO caller_scopes (account_id, caller_id, data_domain, permission, revoked_at)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(account_id, caller_id, data_domain, permission) DO NOTHING`);
  insert.run(accountId, WEB_CALLER, OWNER_DOMAIN, 'owner');
  insert.run(accountId, WEB_CALLER, OWNER_DOMAIN, 'commands.read');
}

function insertChallenge(
  db: SqliteDatabase,
  now: () => Date,
  input: { accountId: string | null; purpose: ChallengePurpose; challenge: string },
): string {
  const challengeId = `ch_${randomUUID()}`;
  const createdAt = now().toISOString();
  db.prepare(`INSERT INTO auth_challenges (
    challenge_id, account_id, purpose, challenge, challenge_hash, origin, rp_id, expires_at, consumed_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
    challengeId,
    input.accountId,
    input.purpose,
    input.challenge,
    sha256(input.challenge),
    ORIGIN,
    RP_ID,
    new Date(now().getTime() + CHALLENGE_TTL_MS).toISOString(),
    createdAt,
  );
  return challengeId;
}

function loadChallenge(db: SqliteDatabase, challengeId: string, now: Date): ChallengeRow {
  const row = db.prepare(`SELECT challenge_id, account_id, purpose, challenge, origin, rp_id, expires_at, consumed_at
    FROM auth_challenges WHERE challenge_id = ?`).get(challengeId) as ChallengeRow | undefined;
  if (!row || row.consumed_at || row.expires_at <= now.toISOString() || row.origin !== ORIGIN || row.rp_id !== RP_ID) {
    throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'challenge' });
  }
  return row;
}

function publicSession(principal: Principal) {
  return {
    account_id: principal.account_id,
    caller_id: principal.caller_id,
    auth_epoch: principal.auth_epoch,
  };
}

function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'json' });
  }
}

async function handle(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    const rendered = errorBody(error);
    return c.json(rendered.body, rendered.status as 401);
  }
}

function routeRequest(operationId: string) {
  const route = routes.find((item) => item.operationId === operationId);
  if (!route) throw new Error(`ROUTE_MISSING:${operationId}`);
  return route.request;
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
