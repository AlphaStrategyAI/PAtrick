import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import { expect, test } from 'vitest';
import { canonicalPayload, commandAcceptedSchema, errorBodySchema, type Json } from '../../packages/contracts/src/envelope.js';
import { routes } from '../../packages/contracts/src/resources.js';
import { createApp } from '../../apps/service/src/app.js';
import {
  BOOTSTRAP_TTL_MS,
  CHALLENGE_TTL_MS,
  ORIGIN,
  RP_ID,
  issueBootstrapTicket,
  issueCallerSession,
} from '../../apps/service/src/auth.js';
import { stageControlProposal } from '../../apps/service/src/control.js';
import {
  clearSettingsOperations,
  registerSettingsOperation,
  runSettingsOperation,
  settingsOperations,
} from '../../apps/service/src/settings/registry.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';

const CORE_SQL_HASH = '6e82bac75d455f28dc498874b61d0d778e1552b4bc5a8d1b5d7f5dfddfc06233';
const CONFIRM_SQL = `UPDATE control_proposals
SET confirmed_at = @now
WHERE proposal_id = @id AND account_id = @account
  AND proposal_hash = @hash AND challenge_hash = @challenge
  AND base_revision = @current_revision AND confirmed_at IS NULL AND expires_at > @now
RETURNING proposal_id;`;

type RegistrationOptions = { challenge: string; rp: { id: string } };
type AuthenticationOptions = { challenge: string; rpId: string };
type CallOptions = {
  origin?: string | null;
  cookie?: string;
  authorization?: string;
  headers?: Record<string, string>;
};

type Fixture = {
  app: ReturnType<typeof createApp>;
  db: SqliteDatabase;
  databasePath: string;
  credentialDirectory: string;
  now: () => Date;
  advance: (ms: number) => void;
  close: () => void;
};

class TestAuthenticator {
  private counter = 0;
  private readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  readonly id = isoBase64URL.fromBuffer(this.credentialId);

  registrationResponse(options: RegistrationOptions, origin = ORIGIN) {
    const coseBytes = cosePublicKey(this.keys.publicKey);
    const rpIdHash = createHash('sha256').update(options.rp.id).digest();
    const credential = Buffer.from(this.credentialId);
    const header = Buffer.alloc(55 + credential.length);
    rpIdHash.copy(header, 0);
    header[32] = 0x45;
    header.writeUInt32BE(0, 33);
    header.writeUInt16BE(credential.length, 53);
    credential.copy(header, 55);
    const authData = Buffer.concat([header, Buffer.from(coseBytes)]);
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin,
      crossOrigin: false,
    }));
    const attestationObject = isoCBOR.encode(new Map<string, string | Map<string, never> | Uint8Array>([
      ['fmt', 'none'],
      ['attStmt', new Map<string, never>()],
      ['authData', new Uint8Array(authData)],
    ]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ['internal'],
      },
    };
  }

  authenticationResponse(options: AuthenticationOptions, origin = ORIGIN) {
    this.counter += 1;
    const rpIdHash = createHash('sha256').update(options.rpId).digest();
    const authData = Buffer.alloc(37);
    rpIdHash.copy(authData, 0);
    authData[32] = 0x05;
    authData.writeUInt32BE(this.counter, 33);
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.get',
      challenge: options.challenge,
      origin,
      crossOrigin: false,
    }));
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
    const signature = createSign('SHA256').update(Buffer.concat([authData, clientDataHash])).sign(this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(signature),
      },
    };
  }
}

function cosePublicKey(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y) throw new Error('AUTHENTICATOR_KEY_INVALID');
  return isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, isoBase64URL.toBuffer(jwk.x)],
    [-3, isoBase64URL.toBuffer(jwk.y)],
  ]));
}

function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t03-'));
  const databasePath = join(dir, 'patrick.sqlite');
  const credentialDirectory = join(dir, 'credentials');
  let currentMs = Date.parse('2026-11-16T08:00:00.000Z');
  const now = () => new Date(currentMs);
  const app = createApp({ databasePath, credentialDirectory, now });
  const db = openDatabase(databasePath);
  return {
    app,
    db,
    databasePath,
    credentialDirectory,
    now,
    advance(ms: number) {
      currentMs += ms;
    },
    close() {
      db.close();
    },
  };
}

function http(app: Fixture['app'], session: { cookie?: string; authorization?: string } = {}) {
  return {
    get: (path: string, options?: CallOptions) => app.request(path, { method: 'GET', headers: requestHeaders(session, options) }),
    delete: (path: string, options?: CallOptions) => app.request(path, { method: 'DELETE', headers: requestHeaders(session, options) }),
    post: (path: string, body: unknown, options?: CallOptions) => app.request(path, {
      method: 'POST',
      headers: requestHeaders(session, options, true),
      body: JSON.stringify(body),
    }),
  };
}

function requestHeaders(session: { cookie?: string; authorization?: string }, options?: CallOptions, json = false): Headers {
  const headers = new Headers();
  if (json) headers.set('content-type', 'application/json');
  const origin = options && 'origin' in options ? options.origin : ORIGIN;
  if (origin) headers.set('origin', origin);
  const cookie = options?.cookie ?? session.cookie;
  if (cookie) headers.set('cookie', cookie);
  const authorization = options?.authorization ?? session.authorization;
  if (authorization) headers.set('authorization', authorization);
  for (const [name, value] of Object.entries(options?.headers ?? {})) headers.set(name, value);
  return headers;
}

function cookiePair(setCookie: string | null): { token: string; cookie: string } {
  const match = setCookie?.match(/patrick_session=([^;]+)/);
  if (!match?.[1]) throw new Error('COOKIE_MISSING');
  return { token: match[1], cookie: `patrick_session=${match[1]}` };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function confirmation(proposalHash: string, challengeId: string, expectedRevision: number, clientRequestId: string) {
  const payload: Json = { proposal_hash: proposalHash, challenge_id: challengeId };
  return {
    client_request_id: clientRequestId,
    expected_revision: expectedRevision,
    payload_hash: sha256(canonicalPayload(payload)),
    payload,
  };
}

function confirmPath(id: string): string {
  return `/api/v1/control-proposals/${id}/confirm`;
}

function countControlReceipts(db: SqliteDatabase, proposalId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM control_receipts WHERE proposal_id = ?').get(proposalId) as { n: number };
  return Number(row.n);
}

async function authenticateOwner(fx: Fixture) {
  const authenticator = new TestAuthenticator();
  const anon = http(fx.app);
  const ticket = issueBootstrapTicket(fx.db, { accountId: 'owner' }, fx.now);
  const registrationChallenge = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID }, {
    headers: { 'x-patrick-bootstrap': ticket.ticket },
  });
  if (registrationChallenge.status !== 200) throw new Error(`registration challenge ${registrationChallenge.status}`);
  const registrationBody = await registrationChallenge.json() as { challenge_id: string; challenge: RegistrationOptions };
  const registered = await anon.post('/api/v1/auth/verify', {
    challenge_id: registrationBody.challenge_id,
    credential: authenticator.registrationResponse(registrationBody.challenge),
  });
  if (registered.status !== 200) throw new Error(`registration verify ${registered.status}`);
  const authenticationChallenge = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID });
  if (authenticationChallenge.status !== 200) throw new Error(`authentication challenge ${authenticationChallenge.status}`);
  const authenticationBody = await authenticationChallenge.json() as { challenge_id: string; challenge: AuthenticationOptions };
  const authenticated = await anon.post('/api/v1/auth/verify', {
    challenge_id: authenticationBody.challenge_id,
    credential: authenticator.authenticationResponse(authenticationBody.challenge),
  });
  if (authenticated.status !== 200) throw new Error(`authentication verify ${authenticated.status}`);
  const setCookie = authenticated.headers.get('set-cookie');
  const { token, cookie } = cookiePair(setCookie);
  return {
    authenticator,
    token,
    cookie,
    setCookie: setCookie ?? '',
    registrationSetCookie: registered.headers.get('set-cookie') ?? '',
    api: http(fx.app, { cookie }),
  };
}

async function openControlChallenge(api: ReturnType<typeof http>): Promise<string> {
  const response = await api.post('/api/v1/auth/challenge', { rp_id: RP_ID });
  expect(response.status).toBe(200);
  const body = await response.json() as { challenge_id: string };
  return body.challenge_id;
}

test('owner session read succeeds and cross-origin or consult confirm writes no receipt', async () => {
  const fx = createFixture();
  try {
    const owner = await authenticateOwner(fx);
    const store = createCredentialStore(fx.credentialDirectory, fx.now);
    const consult = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'consult',
      domain: 'personal',
      permissions: ['consultations.write'],
    }, fx.now, store);
    const ownerApi = owner.api;
    const consultOnlyApi = http(fx.app, { authorization: consult.authorization });
    const validConfirmation = confirmation('c'.repeat(64), 'challenge-1', 0, 'req-brief');
    expect((await ownerApi.get('/api/v1/session')).status).toBe(200);
    expect((await ownerApi.post(confirmPath('p-1'), validConfirmation, { origin: 'https://other.invalid' })).status).toBe(403);
    expect((await consultOnlyApi.post(confirmPath('p-1'), validConfirmation)).status).toBe(403);
    expect(countControlReceipts(fx.db, 'p-1')).toBe(0);
  } finally {
    fx.close();
  }
});

test('registration starts from a one-time short-lived bootstrap ticket bound to localhost', async () => {
  expect(ORIGIN).toBe('http://localhost');
  expect(RP_ID).toBe('localhost');
  const fx = createFixture();
  try {
    const ticket = issueBootstrapTicket(fx.db, { accountId: 'owner' }, fx.now);
    const stored = JSON.stringify(fx.db.prepare('SELECT * FROM bootstrap_tickets').all());
    expect(stored).not.toContain(ticket.ticket);
    expect(stored).toContain(sha256(ticket.ticket));
    const anon = http(fx.app);
    const first = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID }, {
      headers: { 'x-patrick-bootstrap': ticket.ticket },
    });
    expect(first.status).toBe(200);
    const replay = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID }, {
      headers: { 'x-patrick-bootstrap': ticket.ticket },
    });
    expect(replay.status).toBe(403);
    const expired = issueBootstrapTicket(fx.db, { accountId: 'owner' }, fx.now);
    fx.advance(BOOTSTRAP_TTL_MS + 1_000);
    const late = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID }, {
      headers: { 'x-patrick-bootstrap': expired.ticket },
    });
    expect(late.status).toBe(403);
    const fresh = issueBootstrapTicket(fx.db, { accountId: 'owner' }, fx.now);
    const wrongOrigin = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID }, {
      origin: 'https://other.invalid',
      headers: { 'x-patrick-bootstrap': fresh.ticket },
    });
    expect(wrongOrigin.status).toBe(403);
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM auth_challenges').get()).toEqual({ n: 1 });
    const wrongRp = await anon.post('/api/v1/auth/challenge', { rp_id: 'evil.invalid' }, {
      headers: { 'x-patrick-bootstrap': fresh.ticket },
    });
    expect(wrongRp.status).toBe(422);
  } finally {
    fx.close();
  }
});

test('a failed registration challenge insert leaves the bootstrap ticket unconsumed', async () => {
  const fx = createFixture();
  try {
    const ticket = issueBootstrapTicket(fx.db, { accountId: 'owner' }, fx.now);
    const ticketHash = sha256(ticket.ticket);
    fx.db.exec(`CREATE TRIGGER t03_abort_auth_challenge_insert
      BEFORE INSERT ON auth_challenges
      BEGIN
        SELECT RAISE(ABORT, 't03_abort_auth_challenge_insert');
      END;`);
    const anon = http(fx.app);
    const blocked = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID }, {
      headers: { 'x-patrick-bootstrap': ticket.ticket },
    });
    expect(blocked.status).not.toBe(200);
    fx.db.exec('DROP TRIGGER t03_abort_auth_challenge_insert;');
    const row = fx.db.prepare('SELECT consumed_at FROM bootstrap_tickets WHERE ticket_hash = ?').get(ticketHash) as {
      consumed_at: string | null;
    };
    expect(row.consumed_at).toBeNull();
    const retry = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID }, {
      headers: { 'x-patrick-bootstrap': ticket.ticket },
    });
    expect(retry.status).toBe(200);
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM auth_challenges WHERE account_id = 'owner' AND purpose = 'registration'`).get()).toEqual({ n: 1 });
  } finally {
    fx.close();
  }
});

test('verify accepts a signed assertion and rejects a tampered or replayed one', async () => {
  const fx = createFixture();
  try {
    const authenticator = new TestAuthenticator();
    const anon = http(fx.app);
    const ticket = issueBootstrapTicket(fx.db, { accountId: 'owner' }, fx.now);
    const registrationChallenge = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID }, {
      headers: { 'x-patrick-bootstrap': ticket.ticket },
    });
    expect(registrationChallenge.status).toBe(200);
    const registrationBody = await registrationChallenge.json() as { challenge_id: string; challenge: RegistrationOptions };
    expect(registrationBody.challenge.rp.id).toBe('localhost');
    const registered = await anon.post('/api/v1/auth/verify', {
      challenge_id: registrationBody.challenge_id,
      credential: authenticator.registrationResponse(registrationBody.challenge),
    });
    expect(registered.status).toBe(200);
    const authenticationChallenge = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID });
    expect(authenticationChallenge.status).toBe(200);
    const authenticationBody = await authenticationChallenge.json() as { challenge_id: string; challenge: AuthenticationOptions };
    expect(authenticationBody.challenge.rpId).toBe('localhost');
    const forged = authenticator.authenticationResponse(authenticationBody.challenge);
    const signature = Buffer.from(isoBase64URL.toBuffer(forged.response.signature));
    signature[10] ^= 0xff;
    forged.response.signature = isoBase64URL.fromBuffer(signature);
    const tampered = await anon.post('/api/v1/auth/verify', {
      challenge_id: authenticationBody.challenge_id,
      credential: forged,
    });
    expect(tampered.status).toBe(401);
    expect(errorBodySchema.safeParse(await tampered.json()).success).toBe(true);
    const wrongOrigin = authenticator.authenticationResponse(authenticationBody.challenge, 'https://other.invalid');
    const crossOriginAssertion = await anon.post('/api/v1/auth/verify', {
      challenge_id: authenticationBody.challenge_id,
      credential: wrongOrigin,
    });
    expect(crossOriginAssertion.status).toBe(401);
    const signed = authenticator.authenticationResponse(authenticationBody.challenge);
    const verified = await anon.post('/api/v1/auth/verify', {
      challenge_id: authenticationBody.challenge_id,
      credential: signed,
    });
    expect(verified.status).toBe(200);
    const replay = await anon.post('/api/v1/auth/verify', {
      challenge_id: authenticationBody.challenge_id,
      credential: signed,
    });
    expect(replay.status).toBe(401);
    const expiring = await anon.post('/api/v1/auth/challenge', { rp_id: RP_ID });
    const expiringBody = await expiring.json() as { challenge_id: string; challenge: AuthenticationOptions };
    fx.advance(CHALLENGE_TTL_MS + 1_000);
    const expired = await anon.post('/api/v1/auth/verify', {
      challenge_id: expiringBody.challenge_id,
      credential: authenticator.authenticationResponse(expiringBody.challenge),
    });
    expect(expired.status).toBe(401);
    const session = cookiePair(verified.headers.get('set-cookie'));
    const owner = http(fx.app, { cookie: session.cookie });
    expect((await owner.get('/api/v1/session')).status).toBe(200);
  } finally {
    fx.close();
  }
});

test('the session cookie is HttpOnly and SameSite=Strict and only its hash is stored', async () => {
  const fx = createFixture();
  try {
    const owner = await authenticateOwner(fx);
    for (const setCookie of [owner.registrationSetCookie, owner.setCookie]) {
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie.toLowerCase()).not.toContain('samesite=lax');
      expect(setCookie.toLowerCase()).not.toContain('samesite=none');
    }
    const columns = fx.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    const names = columns.map((column) => column.name);
    expect(names).not.toContain('token');
    expect(names).not.toContain('secret');
    expect(names).not.toContain('public_key');
    expect(names).toEqual(expect.arrayContaining(['token_hash', 'auth_epoch', 'expires_at', 'authenticated_at', 'credential_ref']));
    const row = fx.db.prepare('SELECT token_hash, auth_epoch, credential_ref FROM sessions WHERE token_hash = ?').get(sha256(owner.token)) as {
      token_hash: string;
      auth_epoch: number;
      credential_ref: string;
    };
    expect(row.token_hash).toBe(sha256(owner.token));
    expect(row.auth_epoch).toBeGreaterThan(0);
    expect(row.credential_ref).not.toContain(owner.token);
    fx.db.pragma('wal_checkpoint(TRUNCATE)');
    const stored = Buffer.concat([
      readFileSync(fx.databasePath),
      existsSync(`${fx.databasePath}-wal`) ? readFileSync(`${fx.databasePath}-wal`) : Buffer.alloc(0),
    ]);
    expect(stored.includes(Buffer.from(owner.token))).toBe(false);
    const passkey = fx.db.prepare('SELECT credential_id, public_key FROM passkey_credentials').get() as {
      credential_id: string;
      public_key: Buffer;
    };
    expect(passkey.credential_id).toBe(owner.authenticator.id);
    expect(stored.includes(passkey.public_key)).toBe(true);
    expect(JSON.stringify(fx.db.prepare('SELECT * FROM sessions').all())).not.toContain(passkey.public_key.toString('base64url'));
    const removed = await owner.api.delete('/api/v1/session');
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(removed.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await owner.api.get('/api/v1/session')).status).toBe(401);
  } finally {
    fx.close();
  }
});

test('a legitimate confirm writes one receipt and a same-key replay does not write another', async () => {
  const fx = createFixture();
  try {
    const owner = await authenticateOwner(fx);
    const challengeId = await openControlChallenge(owner.api);
    const proposalHash = 'ab'.repeat(32);
    stageControlProposal(fx.db, {
      proposalId: 'p-1',
      accountId: 'owner',
      proposalHash,
      challengeId,
      baseRevision: 0,
      target: 'settings',
      action: 'apply',
      scope: 'personal',
    });
    const body = confirmation(proposalHash, challengeId, 0, 'req-confirm-1');
    const accepted = await owner.api.post(confirmPath('p-1'), body);
    expect(accepted.status).toBe(202);
    const receipt = commandAcceptedSchema.parse(await accepted.json());
    expect(receipt.state).toBe('received');
    expect(receipt.receipt_url).toBe(`/api/v1/commands/${receipt.command_id}`);
    expect(countControlReceipts(fx.db, 'p-1')).toBe(1);
    const replay = await owner.api.post(confirmPath('p-1'), body);
    expect(replay.status).toBe(202);
    expect(commandAcceptedSchema.parse(await replay.json()).command_id).toBe(receipt.command_id);
    expect(countControlReceipts(fx.db, 'p-1')).toBe(1);
    const stored = fx.db.prepare(`SELECT receipt_id, proposal_hash, auth_epoch, authenticated_at, credential_ref
      FROM control_receipts WHERE proposal_id = ?`).get('p-1') as {
      receipt_id: string;
      proposal_hash: string;
      auth_epoch: number;
      authenticated_at: string;
      credential_ref: string;
    };
    const controlReceipt = await owner.api.get(`/api/v1/control-receipts/${stored.receipt_id}`);
    expect(controlReceipt.status).toBe(200);
    const receiptSnapshot = await controlReceipt.json() as {
      schema_version: string;
      scope: unknown;
      as_of: string;
      watermark: unknown;
      freshness: string;
      data: {
        proposal_hash: string;
        auth_epoch: number;
        authenticated_at: string;
        credential_ref: string;
      };
    };
    expect(receiptSnapshot.schema_version).toBe('1.0');
    expect(receiptSnapshot.scope).toBeTruthy();
    expect(receiptSnapshot.as_of).toBeTruthy();
    expect(receiptSnapshot.watermark).toBeTruthy();
    expect(receiptSnapshot.freshness).toBe('fresh');
    expect(receiptSnapshot.data.proposal_hash).toBe(stored.proposal_hash);
    expect(receiptSnapshot.data.auth_epoch).toBe(stored.auth_epoch);
    expect(receiptSnapshot.data.authenticated_at).toBe(stored.authenticated_at);
    expect(receiptSnapshot.data.credential_ref).toBe(stored.credential_ref);
    expect(receipt.receipt_url).toBe(`/api/v1/commands/${receipt.command_id}`);
    const consult = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'consult',
      domain: 'personal',
      permissions: ['consultations.write'],
    }, fx.now, createCredentialStore(fx.credentialDirectory, fx.now));
    expect((await http(fx.app, { authorization: consult.authorization }).get(`/api/v1/control-receipts/${stored.receipt_id}`)).status).toBe(403);
    expect((await owner.api.get('/api/v1/control-receipts/rcpt_missing')).status).toBe(404);
    const command = await owner.api.get(`/api/v1/commands/${receipt.command_id}`);
    expect(command.status).toBe(200);
    const snapshot = await command.json() as { schema_version: string; data: { command_id: string }; scope: { account_id: string } };
    const getCommand = routes.find((route) => route.operationId === 'getCommand');
    expect(getCommand?.response.safeParse(snapshot).success).toBe(true);
    expect(snapshot.data.command_id).toBe(receipt.command_id);
    expect(snapshot.scope.account_id).toBe('owner');
    const session = await owner.api.get('/api/v1/session');
    const sessionBody = await session.json() as { data: { operations: string[]; auth_epoch: number } };
    const getSession = routes.find((route) => route.operationId === 'getSession');
    expect(getSession?.response.safeParse(sessionBody).success).toBe(true);
    expect(sessionBody.data.operations).toContain('owner');
    expect(sessionBody.data.auth_epoch).toBeGreaterThan(0);
  } finally {
    fx.close();
  }
});

test('changed hash, expiry, stale revision, and a consumed challenge leave no receipt', async () => {
  const fx = createFixture();
  try {
    const owner = await authenticateOwner(fx);
    const proposalHash = 'cd'.repeat(32);
    const changedChallenge = await openControlChallenge(owner.api);
    stageControlProposal(fx.db, {
      proposalId: 'p-hash',
      accountId: 'owner',
      proposalHash,
      challengeId: changedChallenge,
      baseRevision: 0,
      target: 'settings',
      action: 'apply',
      scope: 'personal',
    });
    const changed = await owner.api.post(confirmPath('p-hash'), confirmation('ef'.repeat(32), changedChallenge, 0, 'req-hash'));
    expect(changed.status).toBe(409);
    expect(countControlReceipts(fx.db, 'p-hash')).toBe(0);

    const expiredChallenge = await openControlChallenge(owner.api);
    stageControlProposal(fx.db, {
      proposalId: 'p-expired',
      accountId: 'owner',
      proposalHash,
      challengeId: expiredChallenge,
      baseRevision: 0,
      target: 'settings',
      action: 'apply',
      scope: 'personal',
    });
    const past = '2020-01-01T00:00:00.000Z';
    fx.db.prepare('UPDATE auth_challenges SET expires_at = ? WHERE challenge_id = ?').run(past, expiredChallenge);
    fx.db.prepare('UPDATE control_proposals SET expires_at = ? WHERE proposal_id = ?').run(past, 'p-expired');
    const expired = await owner.api.post(confirmPath('p-expired'), confirmation(proposalHash, expiredChallenge, 0, 'req-expired'));
    expect(expired.status).toBe(403);
    expect(countControlReceipts(fx.db, 'p-expired')).toBe(0);

    const staleChallenge = await openControlChallenge(owner.api);
    stageControlProposal(fx.db, {
      proposalId: 'p-stale',
      accountId: 'owner',
      proposalHash,
      challengeId: staleChallenge,
      baseRevision: 0,
      target: 'settings',
      action: 'apply',
      scope: 'personal',
    });
    fx.db.prepare('UPDATE accounts SET policy_revision = policy_revision + 1 WHERE account_id = ?').run('owner');
    const stale = await owner.api.post(confirmPath('p-stale'), confirmation(proposalHash, staleChallenge, 0, 'req-stale'));
    expect(stale.status).toBe(409);
    const staleBody = errorBodySchema.parse(await stale.json());
    expect(staleBody.code).toBe('CONFLICT');
    expect(staleBody.current_revision).toBe(1);
    expect(countControlReceipts(fx.db, 'p-stale')).toBe(0);
    fx.db.prepare('UPDATE accounts SET policy_revision = 0 WHERE account_id = ?').run('owner');

    const replayChallenge = await openControlChallenge(owner.api);
    stageControlProposal(fx.db, {
      proposalId: 'p-once',
      accountId: 'owner',
      proposalHash,
      challengeId: replayChallenge,
      baseRevision: 0,
      target: 'settings',
      action: 'apply',
      scope: 'personal',
    });
    const first = await owner.api.post(confirmPath('p-once'), confirmation(proposalHash, replayChallenge, 0, 'req-once'));
    expect(first.status).toBe(202);
    stageControlProposal(fx.db, {
      proposalId: 'p-replay',
      accountId: 'owner',
      proposalHash,
      challengeId: replayChallenge,
      baseRevision: 0,
      target: 'settings',
      action: 'apply',
      scope: 'personal',
    });
    const replay = await owner.api.post(confirmPath('p-replay'), confirmation(proposalHash, replayChallenge, 0, 'req-replay'));
    expect(replay.status).toBe(403);
    expect(countControlReceipts(fx.db, 'p-replay')).toBe(0);
    expect(countControlReceipts(fx.db, 'p-once')).toBe(1);
  } finally {
    fx.close();
  }
});

test('cross-origin, old auth epoch, consult, and MCP callers leave no receipt', async () => {
  const fx = createFixture();
  try {
    const owner = await authenticateOwner(fx);
    const store = createCredentialStore(fx.credentialDirectory, fx.now);
    const consult = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'consult',
      domain: 'personal',
      permissions: ['consultations.write'],
    }, fx.now, store);
    const mcp = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'mcp',
      domain: 'personal',
      permissions: ['mcp:consult'],
    }, fx.now, store);
    const proposalHash = 'a1'.repeat(32);
    const challengeId = await openControlChallenge(owner.api);
    stageControlProposal(fx.db, {
      proposalId: 'p-1',
      accountId: 'owner',
      proposalHash,
      challengeId,
      baseRevision: 0,
      target: 'settings',
      action: 'apply',
      scope: 'personal',
    });
    const body = confirmation(proposalHash, challengeId, 0, 'req-deny');
    const crossOrigin = await owner.api.post(confirmPath('p-1'), body, { origin: 'https://other.invalid' });
    expect(crossOrigin.status).toBe(403);
    const missingOrigin = await owner.api.post(confirmPath('p-1'), body, { origin: null });
    expect(missingOrigin.status).toBe(403);
    const missingCaller = await http(fx.app).post(confirmPath('p-1'), body);
    expect(missingCaller.status).toBe(403);
    const consultOnly = await http(fx.app, { authorization: consult.authorization }).post(confirmPath('p-1'), body);
    expect(consultOnly.status).toBe(403);
    const mcpCaller = await http(fx.app, { authorization: mcp.authorization }).post(confirmPath('p-1'), body);
    expect(mcpCaller.status).toBe(403);
    fx.db.prepare('UPDATE accounts SET auth_epoch = auth_epoch + 1 WHERE account_id = ?').run('owner');
    const oldEpoch = await owner.api.post(confirmPath('p-1'), body);
    expect(oldEpoch.status).toBe(401);
    expect((await owner.api.get('/api/v1/session')).status).toBe(401);
    expect(countControlReceipts(fx.db, 'p-1')).toBe(0);
    for (const response of [crossOrigin, missingOrigin, missingCaller, consultOnly, mcpCaller]) {
      const parsed = errorBodySchema.parse(await response.json());
      expect(parsed.code).toBe('FORBIDDEN');
      expect(parsed.retryable).toBe(false);
      expect(parsed.correlation_id.length).toBeGreaterThan(0);
    }
  } finally {
    fx.close();
  }
});

test('revoking the command object permission rejects the same key and the command read', async () => {
  const fx = createFixture();
  try {
    const owner = await authenticateOwner(fx);
    const challengeId = await openControlChallenge(owner.api);
    const proposalHash = 'b2'.repeat(32);
    stageControlProposal(fx.db, {
      proposalId: 'p-revoke',
      accountId: 'owner',
      proposalHash,
      challengeId,
      baseRevision: 0,
      target: 'settings',
      action: 'apply',
      scope: 'personal',
    });
    const body = confirmation(proposalHash, challengeId, 0, 'req-revoke');
    const accepted = await owner.api.post(confirmPath('p-revoke'), body);
    expect(accepted.status).toBe(202);
    const commandId = commandAcceptedSchema.parse(await accepted.json()).command_id;
    fx.db.prepare(`UPDATE caller_scopes SET revoked_at = ?
      WHERE account_id = 'owner' AND caller_id = 'web' AND permission = 'owner'`).run(fx.now().toISOString());
    const resent = await owner.api.post(confirmPath('p-revoke'), body);
    expect(resent.status).toBe(403);
    expect(errorBodySchema.parse(await resent.json()).code).toBe('FORBIDDEN');
    const command = await owner.api.get(`/api/v1/commands/${commandId}`);
    expect(command.status).toBe(403);
    expect(errorBodySchema.parse(await command.json()).code).toBe('FORBIDDEN');
    expect(countControlReceipts(fx.db, 'p-revoke')).toBe(1);
    expect((await owner.api.get('/api/v1/session')).status).toBe(200);
  } finally {
    fx.close();
  }
});

test('raising auth_epoch rejects the old cookie and closes its SSE stream', async () => {
  const fx = createFixture();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const owner = await authenticateOwner(fx);
    const response = await fx.app.request('/api/v1/session/stream', {
      headers: { cookie: owner.cookie, origin: ORIGIN },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    reader = response.body?.getReader();
    if (!reader) throw new Error('SSE_BODY_MISSING');
    const opened = await reader.read();
    expect(opened.done).toBe(false);
    fx.db.prepare('UPDATE accounts SET auth_epoch = auth_epoch + 1 WHERE account_id = ?').run('owner');
    const deadline = Date.now() + 2_000;
    let done = false;
    while (!done && Date.now() < deadline) {
      done = (await reader.read()).done;
    }
    expect(done).toBe(true);
    expect((await owner.api.get('/api/v1/session')).status).toBe(401);
  } finally {
    await reader?.cancel().catch(() => undefined);
    fx.close();
  }
});

test('credential references expire and receipts never store the secret bytes', async () => {
  const fx = createFixture();
  try {
    let currentMs = Date.parse('2026-11-16T09:00:00.000Z');
    const now = () => new Date(currentMs);
    const store = createCredentialStore(fx.credentialDirectory, now);
    const secret = new TextEncoder().encode('owner-secret-not-in-sqlite');
    const reference = store.put(secret, 1_000);
    expect(reference).not.toContain('owner-secret-not-in-sqlite');
    expect(store.resolve(reference)).toEqual(secret);
    currentMs += 1_001;
    expect(store.resolve(reference)).toBeNull();

    const owner = await authenticateOwner(fx);
    const challengeId = await openControlChallenge(owner.api);
    const proposalHash = 'd4'.repeat(32);
    stageControlProposal(fx.db, {
      proposalId: 'p-secret',
      accountId: 'owner',
      proposalHash,
      challengeId,
      baseRevision: 0,
      target: 'settings',
      action: 'apply',
      scope: 'personal',
    });
    const accepted = await owner.api.post(confirmPath('p-secret'), confirmation(proposalHash, challengeId, 0, 'req-secret'));
    expect(accepted.status).toBe(202);
    const receipt = fx.db.prepare('SELECT credential_ref FROM control_receipts WHERE proposal_id = ?').get('p-secret') as {
      credential_ref: string;
    };
    const session = fx.db.prepare('SELECT credential_ref FROM sessions WHERE token_hash = ?').get(sha256(owner.token)) as {
      credential_ref: string;
    };
    const appStore = createCredentialStore(fx.credentialDirectory, fx.now);
    const receiptSecret = appStore.resolve(receipt.credential_ref);
    const sessionSecret = appStore.resolve(session.credential_ref);
    expect(receiptSecret).toBeInstanceOf(Uint8Array);
    expect(sessionSecret).toBeInstanceOf(Uint8Array);
    expect(receipt.credential_ref).not.toContain(Buffer.from(receiptSecret ?? []).toString('base64url'));
    fx.db.pragma('wal_checkpoint(TRUNCATE)');
    const stored = readFileSync(fx.databasePath);
    expect(stored.includes(Buffer.from(receiptSecret ?? []))).toBe(false);
    expect(stored.includes(Buffer.from(sessionSecret ?? []))).toBe(false);
    expect(stored.includes(Buffer.from(receipt.credential_ref))).toBe(true);
  } finally {
    fx.close();
  }
});

test('settings registration accepts only inspect, validate, apply, and recheck', async () => {
  clearSettingsOperations();
  expect(settingsOperations()).toEqual([]);
  expect(() => registerSettingsOperation('connect_vault', () => ({}))).toThrow('SETTINGS_OPERATION_UNSUPPORTED');
  expect(() => registerSettingsOperation('set_feishu_connection', () => ({}))).toThrow('SETTINGS_OPERATION_UNSUPPORTED');
  const checkedAt = '2026-11-16T08:00:00.000Z';
  registerSettingsOperation('inspect', () => ({ records: [{ target: 'host', observed: 'ready' }] }));
  registerSettingsOperation('validate', () => ({ draft_hash: 'ab'.repeat(32), valid: true }));
  registerSettingsOperation('apply', () => ({ effects: [{ item: 'host', effect: 'unchanged' }] }));
  registerSettingsOperation('recheck', () => ({ ok: true, checked_at: checkedAt }));
  expect(settingsOperations().slice().sort()).toEqual(['apply', 'inspect', 'recheck', 'validate']);
  await expect(runSettingsOperation('inspect', {})).resolves.toEqual({ records: [{ target: 'host', observed: 'ready' }] });
  await expect(runSettingsOperation('validate', {})).resolves.toEqual({ draft_hash: 'ab'.repeat(32), valid: true });
  await expect(runSettingsOperation('apply', {})).resolves.toEqual({ effects: [{ item: 'host', effect: 'unchanged' }] });
  await expect(runSettingsOperation('recheck', {})).resolves.toEqual({ ok: true, checked_at: checkedAt });
  expect(settingsOperations().join(' ')).not.toMatch(/vault|feishu/i);
  clearSettingsOperations();
});

test('the auth migration appends after the untouched core schema', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const coreBytes = readFileSync(join(root, 'packages/storage/migrations/0002_core.sql'));
  expect(createHash('sha256').update(coreBytes).digest('hex')).toBe(CORE_SQL_HASH);
  const authBytes = readFileSync(join(root, 'packages/storage/migrations/0003_auth_control.sql'));
  const authHash = createHash('sha256').update(authBytes).digest('hex');
  const hubBytes = readFileSync(join(root, 'packages/storage/migrations/0004_hub_work.sql'));
  const hubHash = createHash('sha256').update(hubBytes).digest('hex');
  const sourceBytes = readFileSync(join(root, 'packages/storage/migrations/0005_sources.sql'));
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const vaultBytes = readFileSync(join(root, 'packages/storage/migrations/0006_vault_evidence.sql'));
  const vaultHash = createHash('sha256').update(vaultBytes).digest('hex');
  const standardsBytes = readFileSync(join(root, 'packages/storage/migrations/0007_standards.sql'));
  const standardsHash = createHash('sha256').update(standardsBytes).digest('hex');
  const admissionBytes = readFileSync(join(root, 'packages/storage/migrations/0008_admission_budget.sql'));
  const admissionHash = createHash('sha256').update(admissionBytes).digest('hex');
  const manifest = JSON.parse(readFileSync(join(root, 'packages/storage/migrations/manifest.json'), 'utf8')) as {
    file: string;
    sha256: string;
  }[];
  expect(manifest).toEqual([
    { file: '0002_core.sql', sha256: CORE_SQL_HASH },
    { file: '0003_auth_control.sql', sha256: authHash },
    { file: '0004_hub_work.sql', sha256: hubHash },
    { file: '0005_sources.sql', sha256: sourceHash },
    { file: '0006_vault_evidence.sql', sha256: vaultHash },
    { file: '0007_standards.sql', sha256: standardsHash },
    { file: '0008_admission_budget.sql', sha256: admissionHash },
  ]);
  const controlSource = readFileSync(join(root, 'apps/service/src/control.ts'), 'utf8');
  expect(controlSource).toContain(CONFIRM_SQL);
  expect(controlSource).toContain('withImmediateTransaction');
  const fx = createFixture();
  try {
    const applied = fx.db.prepare('SELECT file, sha256 FROM schema_migrations ORDER BY position').all();
    expect(applied).toEqual(manifest);
    const tables = fx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      'accounts',
      'auth_challenges',
      'bootstrap_tickets',
      'caller_scopes',
      'command_inbox',
      'command_records',
      'control_proposals',
      'control_receipts',
      'passkey_credentials',
      'sessions',
    ]));
  } finally {
    fx.close();
  }
});
