import { createHash, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:https';
import { isDeepStrictEqual } from 'node:util';
import { openAuthorityStore } from './authority-store.mjs';
import { emptyWithdrawalHash, encodeWithdrawal, validWithdrawalHead, withdrawalEntryLimit, withdrawalPageSize } from './withdrawal-store.mjs';

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
  const database = openAuthorityStore(path, { create, check,
    schema: 'CREATE TABLE witness_domains (domain TEXT PRIMARY KEY, revision TEXT NOT NULL, record TEXT NOT NULL) STRICT',
  });
  try {
    const select = database.prepare('SELECT revision, record FROM witness_domains WHERE domain = ?');
    const insert = database.prepare('INSERT INTO witness_domains (domain, revision, record) VALUES (?, ?, ?)');
    const compare = database.prepare('UPDATE witness_domains SET record = ?, revision = ? WHERE domain = ? AND revision = ?');
    database.exec('CREATE TABLE IF NOT EXISTS witness_withdrawal_authority (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), identity TEXT NOT NULL) STRICT');
    const logIdentity = database.prepare('SELECT identity FROM witness_withdrawal_authority WHERE singleton = 1');
    const bindLog = database.prepare('INSERT INTO witness_withdrawal_authority VALUES (1, ?)');
    function read(domain) {
      const row = select.get(domain);
      if (!row) return undefined;
      const record = { ...JSON.parse(row.record), revision: row.revision };
      check(validRecord(record, true) && record.domain === domain, 'STORE_INVALID');
      return record;
    }
    function immediate(use) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = use();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
    function logMatches(log) {
      return logIdentity.get()?.identity === log?.identity;
    }
    return Object.freeze({
      read,
      configureWithdrawals(log, domains) {
        immediate(() => {
          const enrolled = logIdentity.get()?.identity;
          if (enrolled !== undefined) check(logMatches(log), 'WITHDRAWAL_STORE_MISMATCH');
          for (const domain of domains) {
            const record = read(domain);
            check(record, 'DOMAIN_NOT_INITIALIZED');
            const { seq, hash } = record.withdrawal;
            if (log && seq > 0 && !log.read(domain, seq, hash)) throw new Error('RECOVERY_WITHDRAWAL_HEAD_MISSING');
          }
          if (log && enrolled === undefined) {
            check(matches(token, log.identity), 'WITHDRAWAL_STORE_MISMATCH');
            bindLog.run(log.identity);
          }
        });
      },
      initialize(record) {
        check(create, 'INITIALIZATION_DISABLED');
        check(validRecord(record) && record.state === 'open' && record.certificate === null && record.activationId === null
          && record.parentSealedRevision === null && record.withdrawal.seq === 0 && record.withdrawal.hash === emptyHash, 'INITIAL_RECORD_INVALID');
        const revision = randomUUID();
        insert.run(record.domain, revision, JSON.stringify(record));
        return { ...structuredClone(record), revision };
      },
      compareAndSwap(domain, revision, next, writerId, withdrawalStore) {
        if (!validRecord(next) || next.domain !== domain || !matches(token, revision)) return 'invalid';
        return immediate(() => {
          if (!logMatches(withdrawalStore)) return 'denied';
          const current = read(domain);
          if (!current || !writerId) return 'denied';
          if (current.revision !== revision) return 'conflict';
          if (!permits(current, next, writerId) || !withdrawalAllows(current, next, withdrawalStore)) return 'denied';
          return compare.run(JSON.stringify(next), randomUUID(), domain, revision).changes === 1 ? 'applied' : 'conflict';
        });
      },
      appendWithdrawal(entry, writerId, log) {
        if (!encodeWithdrawal(entry)) return 'invalid';
        const { domain, seq, hash, writerEpoch, previousHash } = entry;
        return immediate(() => {
          if (!logMatches(log)) return 'denied';
          const current = read(domain);
          if (current?.state !== 'open' || current.writerId !== writerId || current.writerEpoch !== writerEpoch) return 'denied';
          if (seq === current.withdrawal.seq && hash === current.withdrawal.hash) {
            return log.read(domain, seq, hash) ? 'applied' : 'conflict';
          }
          if (seq !== current.withdrawal.seq + 1 || previousHash !== current.withdrawal.hash) return 'conflict';
          return log.append(entry) ? 'applied' : 'conflict';
        });
      },
      close() { database.close(); },
    });
  } catch (error) {
    database.close();
    throw error;
  }
}

function withdrawalAllows(current, next, log) {
  if (!log || current.state !== 'open') return true;
  const nextSeq = current.withdrawal.seq + 1;
  if (next.state === 'sealed') return !log.hasPending(current.domain, nextSeq, current.writerEpoch);
  const entry = log.read(next.domain, nextSeq, next.withdrawal.hash);
  return entry?.writerEpoch === current.writerEpoch && entry.previousHash === current.withdrawal.hash;
}

async function readBody(stream, limit = maxBody) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    check(bytes <= limit, 'BODY_LIMIT');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}

function tlsMaterial(value) {
  check((typeof value === 'string' || Buffer.isBuffer(value)) && value.length > 0 && value.length <= 128 * 1024, 'TLS_INVALID');
  return Buffer.from(value);
}

async function handleWithdrawal(incoming, outgoing, path, peer, store, log) {
  const [, domain, rawSeq, hash] = path;
  const seq = Number(rawSeq);
  const finish = status => outgoing.writeHead(status).end();
  if (!log || !peer.withdrawals || !peer.domains.has(domain)) return finish(403);
  if (!validWithdrawalHead(domain, seq, hash) || seq === 0) return finish(400);
  if (incoming.method === 'GET') {
    const entries = [];
    let nextHash = hash;
    for (let cursor = seq; cursor > 0 && entries.length < withdrawalPageSize; cursor--) {
      const entry = log.read(domain, cursor, nextHash);
      if (!entry) return finish(404);
      entries.push(entry);
      nextHash = entry.previousHash;
    }
    outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(entries));
    return;
  }
  if (incoming.method !== 'PUT') return finish(405);
  if (!peer.writerId) return finish(403);
  if (incoming.headers['content-type'] !== 'application/json') return finish(415);
  let entry;
  try { entry = await readBody(incoming, withdrawalEntryLimit); } catch { return finish(400); }
  if (!entry || entry.domain !== domain || entry.seq !== seq || entry.hash !== hash) return finish(400);
  const outcome = store.appendWithdrawal(entry, peer.writerId, log);
  return finish({ applied: 204, conflict: 409, denied: 403, invalid: 400 }[outcome]);
}

export function createRecoveryWitnessServer({ ca, key, cert, authorityId, clients, store, withdrawalStore }) {
  check(matches(token, authorityId) && Array.isArray(clients) && clients.length > 0 && clients.length <= 64, 'ENROLLMENT_INVALID');
  const peers = new Map();
  for (const client of clients) {
    const fingerprint = typeof client?.fingerprint === 'string' && client.fingerprint.toUpperCase();
    check(matches(fingerprintPattern, fingerprint) && !peers.has(fingerprint) && Array.isArray(client.domains)
      && client.domains.length > 0 && client.domains.length <= 64 && client.domains.every(domain => matches(domainId, domain))
      && (client.writerId === undefined || matches(token, client.writerId))
      && (client.withdrawals === undefined || (withdrawalStore && client.withdrawals === true)), 'ENROLLMENT_INVALID');
    peers.set(fingerprint, { domains: new Set(client.domains), writerId: client.writerId, withdrawals: client.withdrawals });
  }
  const server = createServer({ ca: tlsMaterial(ca), key: tlsMaterial(key), cert: tlsMaterial(cert), minVersion: 'TLSv1.2',
    requestCert: true, rejectUnauthorized: true, handshakeTimeout: 5000, requestTimeout: 5000, headersTimeout: 5000 });
  store.configureWithdrawals(withdrawalStore, new Set(clients.flatMap(client => client.domains)));
  server.setTimeout(5000, socket => socket.destroy());
  server.on('request', (incoming, outgoing) => {
    outgoing.setHeader('cache-control', 'no-store');
    outgoing.setHeader('x-patrick-witness', authorityId);
    const finish = status => outgoing.writeHead(status).end();
    const handle = async () => {
      const domain = /^\/v1\/domains\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})$/.exec(incoming.url ?? '')?.[1];
      const peer = incoming.socket.authorized && peers.get(incoming.socket.getPeerCertificate().fingerprint256);
      if (!peer) return finish(403);
      const withdrawalPath = /^\/v1\/withdrawals\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/([1-9][0-9]{0,15})\/([a-f0-9]{64})$/.exec(incoming.url ?? '');
      if (withdrawalPath) return handleWithdrawal(incoming, outgoing, withdrawalPath, peer, store, withdrawalStore);
      if (!domain || !peer.domains.has(domain)) return finish(403);
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
      const outcome = store.compareAndSwap(domain, body.expectedRevision, body.next, peer.writerId, withdrawalStore);
      return finish({ applied: 204, conflict: 409, denied: 403, invalid: 400 }[outcome]);
    };
    void handle().catch(() => { if (!outgoing.headersSent && !outgoing.destroyed) finish(503); });
  });
  return server;
}

function connectAuthority({ origin, authorityId, ca, key, cert }) {
  const url = new URL(origin);
  check(url.protocol === 'https:' && origin === url.origin && matches(token, authorityId), 'ENROLLMENT_INVALID');
  const tls = { ca: tlsMaterial(ca), key: tlsMaterial(key), cert: tlsMaterial(cert), minVersion: 'TLSv1.2', rejectUnauthorized: true };
  return (path, method, payload, read, deadline) => {
    const target = new URL(path, url);
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = AbortSignal.timeout(5000);
      const signal = deadline ? AbortSignal.any([timeout, deadline]) : timeout;
      const outgoing = request(target, { ...tls, agent: false, method, signal, headers: payload && {
        'content-type': 'application/json', 'content-length': payload.length,
      } }, incoming => {
        const decode = async () => {
          check(incoming.headers['x-patrick-witness'] === authorityId, 'REMOTE_REJECTED');
          return read(incoming);
        };
        void decode().then(resolveRequest, rejectRequest).finally(() => incoming.destroy());
      });
      outgoing.once('error', rejectRequest);
      outgoing.end(payload);
    });
  };
}

export function createHttpsRecoveryWitnessPort(options) {
  const connect = connectAuthority(options);
  function call(domain, method, body) {
    check(matches(domainId, domain), 'DOMAIN_INVALID');
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    check(payload === undefined || payload.length <= maxBody, 'BODY_LIMIT');
    return connect('/v1/domains/' + domain, method, payload, async incoming => {
      if (method === 'PUT' && [204, 409].includes(incoming.statusCode)) return incoming.statusCode === 204;
      check(method === 'GET' && incoming.statusCode === 200 && incoming.headers['content-type'] === 'application/json', 'REMOTE_REJECTED');
      const record = await readBody(incoming);
      check(validRecord(record, true) && record.domain === domain, 'REMOTE_REJECTED');
      return record;
    });
  }
  return Object.freeze({
    independence: 'independent_authority',
    consistency: 'linearizable',
    authorityId: options.authorityId,
    readAuthoritative(domain) { return call(domain, 'GET'); },
    compareAndSwap(domain, expectedRevision, next) { return call(domain, 'PUT', { expectedRevision, next }); },
  });
}

export function createHttpsRecoveryWithdrawalLogPort(options) {
  const connect = connectAuthority(options);
  const path = (domain, seq, hash) => `/v1/withdrawals/${domain}/${seq}/${hash}`;
  function page(domain, seq, hash, deadline) {
    return connect(path(domain, seq, hash), 'GET', undefined, async incoming => {
      check(incoming.statusCode === 200 && incoming.headers['content-type'] === 'application/json', 'REMOTE_REJECTED');
      const entries = await readBody(incoming, withdrawalPageSize * (withdrawalEntryLimit + 1) + 2);
      check(Array.isArray(entries) && entries.length === Math.min(seq, withdrawalPageSize), 'WITHDRAWAL_CHAIN_INVALID');
      let expectedHash = hash;
      let expectedSeq = seq;
      for (const entry of entries) {
        check(encodeWithdrawal(entry) && entry.domain === domain && entry.seq === expectedSeq && entry.hash === expectedHash, 'WITHDRAWAL_CHAIN_INVALID');
        expectedHash = entry.previousHash;
        expectedSeq--;
      }
      return entries;
    }, deadline);
  }
  return Object.freeze({
    independence: 'independent_authority',
    async appendAndReadBack(entry) {
      const content = encodeWithdrawal(entry);
      check(content, 'WITHDRAWAL_ENTRY_INVALID');
      const { domain, seq, hash } = entry;
      const status = await connect(path(domain, seq, hash), 'PUT', Buffer.from(content), incoming => incoming.statusCode)
        .catch(() => undefined);
      check(status === 204 || status === undefined, 'REMOTE_REJECTED');
      const observed = await page(domain, seq, hash);
      check(encodeWithdrawal(observed[0]) === content, 'WITHDRAWAL_ENTRY_UNCONFIRMED');
      return { domain, seq, hash, verified: true };
    },
    async readComplete(domain, record) {
      let { seq, hash } = record.withdrawal;
      check(record.domain === domain && validWithdrawalHead(domain, seq, hash), 'WITHDRAWAL_CHAIN_INVALID');
      const deadline = AbortSignal.timeout(60_000);
      const entries = [];
      const eventIds = new Set();
      while (seq > 0) {
        const batch = await page(domain, seq, hash, deadline);
        for (const entry of batch) {
          check(!eventIds.has(entry.event.eventId), 'WITHDRAWAL_CHAIN_INVALID');
          eventIds.add(entry.event.eventId);
          entries.push(entry);
        }
        seq -= batch.length;
        hash = batch.at(-1).previousHash;
      }
      check(hash === emptyWithdrawalHash, 'WITHDRAWAL_CHAIN_INVALID');
      return entries.reverse();
    },
  });
}
