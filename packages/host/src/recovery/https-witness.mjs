import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

const maxBody = 16 * 1024;
const emptyHash = createHash('sha256').update('').digest('hex');
const recordFields = ['domain', 'writerEpoch', 'writerId', 'state', 'withdrawal', 'certificate', 'activationId', 'parentSealedRevision'];
const certificateFields = ['id', 'cutId', 'previousWriterId', 'fenceProof', 'withdrawalsReconciled'];
const domainId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const token = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const sha = /^[a-f0-9]{64}$/;
const fingerprintPattern = /^[A-F0-9]{2}(?::[A-F0-9]{2}){31}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const nullableToken = value => value === null || matches(token, value);

function exact(value, fields) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function check(condition, code) {
  if (!condition) throw new Error('RECOVERY_WITNESS_' + code);
}

function validTime(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validCertificate(certificate) {
  const fields = Object.hasOwn(certificate ?? {}, 'timing') ? [...certificateFields, 'timing'] : certificateFields;
  if (!exact(certificate, fields) || !matches(token, certificate.id) || !matches(token, certificate.cutId)
    || !matches(token, certificate.previousWriterId) || !matches(token, certificate.fenceProof)
    || certificate.withdrawalsReconciled !== true) return false;
  if (!fields.includes('timing')) return true;
  const { timing } = certificate;
  return exact(timing, ['interruptedAt', 'recoveryPointAt', 'manifestSha256']) && validTime(timing.interruptedAt)
    && validTime(timing.recoveryPointAt) && timing.recoveryPointAt <= timing.interruptedAt && matches(sha, timing.manifestSha256);
}

function validRecord(record, withRevision = false) {
  return exact(record, withRevision ? [...recordFields, 'revision'] : recordFields)
    && (!withRevision || matches(token, record.revision))
    && matches(domainId, record.domain) && matches(token, record.writerEpoch) && matches(token, record.writerId)
    && ['open', 'sealed'].includes(record.state) && exact(record.withdrawal, ['seq', 'hash'])
    && Number.isSafeInteger(record.withdrawal.seq) && record.withdrawal.seq >= 0 && matches(sha, record.withdrawal.hash)
    && (record.certificate === null || validCertificate(record.certificate))
    && nullableToken(record.activationId) && nullableToken(record.parentSealedRevision);
}

function permits(current, next, writerId) {
  if (next.writerId !== writerId) return false;
  if (current.state === 'sealed') {
    return next.state === 'open' && next.writerEpoch !== current.writerEpoch && next.activationId !== null
      && next.parentSealedRevision === current.revision && isDeepStrictEqual(next.withdrawal, current.withdrawal)
      && isDeepStrictEqual(next.certificate, current.certificate);
  }
  if (current.writerId !== writerId || next.writerEpoch !== current.writerEpoch) return false;
  if (next.state === 'sealed') {
    return next.activationId === null && next.parentSealedRevision === null && next.certificate?.previousWriterId === writerId
      && isDeepStrictEqual(next.withdrawal, current.withdrawal);
  }
  return next.activationId === current.activationId && next.parentSealedRevision === current.parentSealedRevision
    && isDeepStrictEqual(next.certificate, current.certificate) && next.withdrawal.seq === current.withdrawal.seq + 1
    && next.withdrawal.hash !== current.withdrawal.hash;
}

export function openRecoveryWitnessStore(path, { create = false } = {}) {
  check(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'STORE_INVALID');
  const parent = dirname(path);
  const owner = process.geteuid?.();
  const directory = lstatSync(parent);
  check(realpathSync(parent) === parent && directory.isDirectory() && directory.uid === owner && (directory.mode & 0o077) === 0, 'STORE_INVALID');
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (!existing) {
    check(create, 'STORE_MISSING');
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const identity = lstatSync(path + suffix, { throwIfNoEntry: false });
    if (!identity && suffix) continue;
    check(identity?.isFile() && identity.uid === owner && identity.nlink === 1 && (identity.mode & 0o077) === 0, 'STORE_INVALID');
  }
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    if (!existing) {
      database.exec('PRAGMA journal_mode=WAL; CREATE TABLE witness_domains (domain TEXT PRIMARY KEY, revision TEXT NOT NULL, record TEXT NOT NULL) STRICT');
    }
    const select = database.prepare('SELECT revision, record FROM witness_domains WHERE domain = ?');
    const insert = database.prepare('INSERT INTO witness_domains (domain, revision, record) VALUES (?, ?, ?)');
    const compare = database.prepare('UPDATE witness_domains SET record = ?, revision = ? WHERE domain = ? AND revision = ?');
    function read(domain) {
      const row = select.get(domain);
      if (!row) return undefined;
      const record = { ...JSON.parse(row.record), revision: row.revision };
      check(validRecord(record, true) && record.domain === domain, 'STORE_INVALID');
      return record;
    }
    return Object.freeze({
      read,
      initialize(record) {
        check(create, 'INITIALIZATION_DISABLED');
        check(validRecord(record) && record.state === 'open' && record.certificate === null && record.activationId === null
          && record.parentSealedRevision === null && record.withdrawal.seq === 0 && record.withdrawal.hash === emptyHash, 'INITIAL_RECORD_INVALID');
        const revision = randomUUID();
        insert.run(record.domain, revision, JSON.stringify(record));
        return { ...structuredClone(record), revision };
      },
      compareAndSwap(domain, revision, next, writerId) {
        if (!validRecord(next) || next.domain !== domain || !matches(token, revision)) return 'invalid';
        const current = read(domain);
        if (!current || !writerId) return 'denied';
        if (current.revision !== revision) return 'conflict';
        if (!permits(current, next, writerId)) return 'denied';
        return compare.run(JSON.stringify(next), randomUUID(), domain, revision).changes === 1 ? 'applied' : 'conflict';
      },
      close() { database.close(); },
    });
  } catch (error) {
    database.close();
    throw error;
  }
}

async function readBody(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    check(bytes <= maxBody, 'BODY_LIMIT');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}

function tlsMaterial(value) {
  check((typeof value === 'string' || Buffer.isBuffer(value)) && value.length > 0 && value.length <= 128 * 1024, 'TLS_INVALID');
  return Buffer.from(value);
}

export function createRecoveryWitnessServer({ ca, key, cert, authorityId, clients, store }) {
  check(matches(token, authorityId) && Array.isArray(clients) && clients.length > 0 && clients.length <= 64, 'ENROLLMENT_INVALID');
  const peers = new Map();
  for (const client of clients) {
    const fingerprint = typeof client?.fingerprint === 'string' && client.fingerprint.toUpperCase();
    check(matches(fingerprintPattern, fingerprint) && !peers.has(fingerprint) && Array.isArray(client.domains)
      && client.domains.length > 0 && client.domains.length <= 64 && client.domains.every(domain => matches(domainId, domain))
      && (client.writerId === undefined || matches(token, client.writerId)), 'ENROLLMENT_INVALID');
    peers.set(fingerprint, { domains: new Set(client.domains), writerId: client.writerId });
  }
  const server = createServer({ ca: tlsMaterial(ca), key: tlsMaterial(key), cert: tlsMaterial(cert), minVersion: 'TLSv1.2',
    requestCert: true, rejectUnauthorized: true, handshakeTimeout: 5000, requestTimeout: 5000, headersTimeout: 5000 });
  server.setTimeout(5000, socket => socket.destroy());
  server.on('request', (incoming, outgoing) => {
    outgoing.setHeader('cache-control', 'no-store');
    outgoing.setHeader('x-patrick-witness', authorityId);
    const finish = status => outgoing.writeHead(status).end();
    const handle = async () => {
      const domain = /^\/v1\/domains\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})$/.exec(incoming.url ?? '')?.[1];
      const peer = incoming.socket.authorized && peers.get(incoming.socket.getPeerCertificate().fingerprint256);
      if (!domain || !peer || !peer.domains.has(domain)) return finish(403);
      if (incoming.method === 'GET') {
        const record = store.read(domain);
        if (!record) return finish(404);
        outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(record));
        return;
      }
      if (incoming.method !== 'PUT') return finish(405);
      if (!peer.writerId) return finish(403);
      if (incoming.headers['content-type'] !== 'application/json') return finish(415);
      let body;
      try { body = await readBody(incoming); } catch { return finish(400); }
      if (!exact(body, ['expectedRevision', 'next'])) return finish(400);
      const outcome = store.compareAndSwap(domain, body.expectedRevision, body.next, peer.writerId);
      return finish({ applied: 204, conflict: 409, denied: 403, invalid: 400 }[outcome]);
    };
    void handle().catch(() => { if (!outgoing.headersSent && !outgoing.destroyed) finish(503); });
  });
  return server;
}

export function createHttpsRecoveryWitnessPort({ origin, authorityId, ca, key, cert }) {
  const url = new URL(origin);
  check(url.protocol === 'https:' && origin === url.origin && matches(token, authorityId), 'ENROLLMENT_INVALID');
  const tls = { ca: tlsMaterial(ca), key: tlsMaterial(key), cert: tlsMaterial(cert), minVersion: 'TLSv1.2', rejectUnauthorized: true };
  function call(domain, method, body) {
    check(matches(domainId, domain), 'DOMAIN_INVALID');
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    check(payload === undefined || payload.length <= maxBody, 'BODY_LIMIT');
    const target = new URL('/v1/domains/' + domain, url);
    return new Promise((resolveRequest, rejectRequest) => {
      const signal = AbortSignal.timeout(5000);
      const outgoing = request(target, { ...tls, agent: false, method, signal, headers: payload && {
        'content-type': 'application/json', 'content-length': payload.length,
      } }, incoming => {
        const read = async () => {
          check(incoming.headers['x-patrick-witness'] === authorityId, 'REMOTE_REJECTED');
          if (method === 'PUT' && [204, 409].includes(incoming.statusCode)) return incoming.statusCode === 204;
          check(method === 'GET' && incoming.statusCode === 200 && incoming.headers['content-type'] === 'application/json', 'REMOTE_REJECTED');
          const record = await readBody(incoming);
          check(validRecord(record, true) && record.domain === domain, 'REMOTE_REJECTED');
          return record;
        };
        void read().then(resolveRequest, rejectRequest).finally(() => incoming.destroy());
      });
      outgoing.once('error', rejectRequest);
      outgoing.end(payload);
    });
  }
  return Object.freeze({
    independence: 'independent_authority',
    consistency: 'linearizable',
    authorityId,
    readAuthoritative(domain) { return call(domain, 'GET'); },
    compareAndSwap(domain, expectedRevision, next) { return call(domain, 'PUT', { expectedRevision, next }); },
  });
}
