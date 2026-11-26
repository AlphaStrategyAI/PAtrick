import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, verify, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { createRecoveryRuntimeGate, openDatabase, recoveryWriteAllowed } from '@patrick/storage';
import { createRecoveryBackup } from '../../packages/host/src/recovery/backup.js';
import { createRecoveryRestorer } from '../../packages/host/src/recovery/restore.js';
import { createRecoveryWitness, withdrawalEntryHash, type RecoveryWitnessRecord } from '../../packages/host/src/recovery/witness.js';
import { createRecoveryWithdrawalJournal } from '../../packages/host/src/recovery/withdrawals.js';
import { createHttpsRecoveryWithdrawalLogPort, createHttpsRecoveryWitnessPort, createRecoveryWitnessServer,
  openRecoveryWitnessStore } from '../../packages/host/src/recovery/https-witness.mjs';
import { openRecoveryWithdrawalStore } from '../../packages/host/src/recovery/withdrawal-store.mjs';
import type { WithdrawalEntry } from '../../packages/host/src/recovery/types.js';

const emptyHash = createHash('sha256').update('').digest('hex');
const withdrawal = { seq: 0, hash: emptyHash };
const initial = { domain: 'personal', writerEpoch: 'initial-epoch', writerId: 'primary', state: 'open',
  withdrawal, certificate: null, activationId: null, parentSealedRevision: null } as const;
const certificate = { id: 'handoff', cutId: 'backup-cut', previousWriterId: 'primary', fenceProof: 'verified-fence', withdrawalsReconciled: true };

let root: string;
let ca: Buffer;
let serverTls: { key: Buffer; cert: Buffer };
const credentials = new Map<string, { key: Buffer; cert: Buffer; fingerprint: string }>();

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 't22-https-witness-'));
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: root, stdio: 'ignore' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-sha256',
    '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Fixture witness CA');
  ca = readFileSync(join(root, 'ca.pem'));
  for (const name of ['server', 'primary', 'candidate-a', 'candidate-b', 'read-only', 'unenrolled']) {
    run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`,
      '-subj', `/CN=${name}`, ...(name === 'server' ? ['-addext', 'subjectAltName=IP:127.0.0.1'] : []));
    run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-days', '1', '-sha256', '-out', `${name}.pem`, ...(name === 'server' ? ['-copy_extensions', 'copy'] : []));
    const cert = readFileSync(join(root, `${name}.pem`));
    credentials.set(name, { cert, key: readFileSync(join(root, `${name}.key`)), fingerprint: new X509Certificate(cert).fingerprint256 });
  }
  serverTls = credentials.get('server')!;
}, 30_000);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS_MISSING');
  return `https://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function start(store: ReturnType<typeof openRecoveryWitnessStore>, withdrawalStore?: ReturnType<typeof openRecoveryWithdrawalStore>,
  { allowCandidateBWithdrawals = false } = {}) {
  const clients = ['primary', 'candidate-a', 'candidate-b', 'read-only'].map(name => ({
    fingerprint: credentials.get(name)!.fingerprint, domains: ['personal'], ...(name === 'read-only' ? {} : { writerId: name }),
    ...(withdrawalStore && (name !== 'candidate-b' || allowCandidateBWithdrawals) ? { withdrawals: true as const } : {}),
  }));
  return createRecoveryWitnessServer({ ...serverTls, ca, authorityId: 'independent-fixture', clients, store, withdrawalStore });
}

function connect(origin: string, name: string, tlsCa = ca) {
  return createHttpsRecoveryWitnessPort({ origin, authorityId: 'independent-fixture', ...credentials.get(name)!, ca: tlsCa });
}

function logPort(origin: string, name: string) {
  return createHttpsRecoveryWithdrawalLogPort({ origin, authorityId: 'independent-fixture', ...credentials.get(name)!, ca });
}

function entry(seq: number, previousHash: string, writerEpoch: string = initial.writerEpoch, eventId = `withdrawal-${seq}`, reason = '本人撤回'): WithdrawalEntry {
  const payload = {
    domain: initial.domain, seq, writerEpoch, previousHash,
    event: { eventId, targetKind: 'knowledge', targetId: 'note-fixed', epoch: seq, targetVersion: 1,
      reason, createdAt: '2026-11-25T00:00:00.000Z' },
  };
  return { ...payload, hash: withdrawalEntryHash(payload) };
}

test('backs up and reads back a legacy withdrawal reason larger than a regular history page without truncation', async () => {
  const store = openRecoveryWitnessStore(join(root, 'long-reason-witness.sqlite'), { create: true });
  const log = openRecoveryWithdrawalStore(join(root, 'long-reason-log.sqlite'), { create: true });
  store.initialize(initial);
  const server = start(store, log);
  const origin = await listen(server);
  try {
    const primary = createRecoveryWitness({ writerId: 'primary', port: connect(origin, 'primary'), verifySealedProof: async () => true });
    const logClient = logPort(origin, 'primary');
    const first = entry(1, emptyHash);
    const large = entry(2, first.hash, initial.writerEpoch, 'legacy-reason', '本人撤回："\\\n'.repeat(17_000));
    const last = entry(3, large.hash);
    for (const withdrawalEntry of [first, large, last]) {
      await expect(logClient.appendAndReadBack(withdrawalEntry)).resolves.toMatchObject({ verified: true });
      expect(await primary.advanceWithdrawalHead(initial.domain, initial.writerEpoch, withdrawalEntry)).toBe(true);
    }
    expect(await logPort(origin, 'read-only').readComplete(initial.domain, (await primary.current(initial.domain))!))
      .toEqual([first, large, last]);
  } finally { await close(server); store.close(); log.close(); }
}, 15_000);

test('an interrupted withdrawal append blocks sealing across restarts until the same entry is reconciled', () => {
  const witnessPath = join(root, 'interrupted-append-witness.sqlite');
  const logPath = join(root, 'interrupted-append-log.sqlite');
  const store = openRecoveryWitnessStore(witnessPath, { create: true });
  const log = openRecoveryWithdrawalStore(logPath, { create: true });
  const pending = entry(1, emptyHash);
  const { revision, ...registered } = store.initialize(initial);
  try {
    store.configureWithdrawals(log, ['personal']);
    expect(() => store.appendWithdrawal(pending, 'primary', {
      ...log, append() { throw new Error('FIXTURE_LOG_UNAVAILABLE'); },
    })).toThrow('FIXTURE_LOG_UNAVAILABLE');
  } finally { store.close(); log.close(); }

  const reopened = openRecoveryWitnessStore(witnessPath);
  const reopenedLog = openRecoveryWithdrawalStore(logPath);
  try {
    reopened.configureWithdrawals(reopenedLog, ['personal']);
    expect(reopened.compareAndSwap('personal', revision, { ...registered, state: 'sealed', certificate }, 'primary', reopenedLog))
      .toBe('denied');
    expect(reopened.appendWithdrawal(entry(1, emptyHash, initial.writerEpoch, 'different-entry'), 'primary', reopenedLog))
      .toBe('conflict');
    expect(reopened.appendWithdrawal(pending, 'primary', reopenedLog)).toBe('applied');
    const withdrawal = { seq: pending.seq, hash: pending.hash };
    expect(reopened.compareAndSwap('personal', revision, { ...registered, withdrawal }, 'primary', reopenedLog)).toBe('applied');
    const advanced = reopened.read('personal')!;
    expect(reopened.compareAndSwap('personal', advanced.revision,
      { ...registered, state: 'sealed', certificate, withdrawal }, 'primary', reopenedLog)).toBe('applied');
  } finally { reopened.close(); reopenedLog.close(); }
});

test('enrollment keeps the live log database when a backup has the same logical identity', () => {
  const witnessPath = join(root, 'enrolled-log-copy-witness.sqlite');
  const logPath = join(root, 'enrolled-log-source.sqlite');
  const copyPath = join(root, 'enrolled-log-copy.sqlite');
  const store = openRecoveryWitnessStore(witnessPath, { create: true });
  const log = openRecoveryWithdrawalStore(logPath, { create: true });
  try {
    store.initialize(initial);
    store.configureWithdrawals(log, ['personal']);
  } finally { store.close(); log.close(); }
  copyFileSync(logPath, copyPath);
  const reopened = openRecoveryWitnessStore(witnessPath);
  const copy = openRecoveryWithdrawalStore(copyPath);
  try {
    expect(copy.identity).toBe(log.identity);
    expect(() => reopened.configureWithdrawals(copy, ['personal'])).toThrow('RECOVERY_WITNESS_WITHDRAWAL_STORE_MISMATCH');
  } finally { reopened.close(); copy.close(); }
});

test('upgrade fences pre-upgrade witness storage and validates the entire enrolled history', () => {
  const witnessPath = join(root, 'legacy-witness.sqlite');
  const log = openRecoveryWithdrawalStore(join(root, 'legacy-witness-log.sqlite'), { create: true });
  const first = entry(1, emptyHash);
  const second = entry(2, first.hash);
  const third = entry(3, second.hash);
  const current = { ...initial, withdrawal: { seq: second.seq, hash: second.hash } };
  const legacy = new Database(witnessPath);
  chmodSync(witnessPath, 0o600);
  legacy.exec(`
    CREATE TABLE witness_domains (domain TEXT PRIMARY KEY, revision TEXT NOT NULL, record TEXT NOT NULL) STRICT;
    CREATE TABLE witness_withdrawal_authority (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), identity TEXT NOT NULL) STRICT;
  `);
  legacy.prepare('INSERT INTO witness_domains VALUES (?, ?, ?)').run('personal', 'legacy-revision', JSON.stringify(current));
  legacy.prepare('INSERT INTO witness_withdrawal_authority VALUES (1, ?)').run(log.identity);
  const priorReader = legacy.prepare('SELECT record FROM witness_domains WHERE domain = ?');
  const store = openRecoveryWitnessStore(witnessPath);
  try {
    expect(store.read('personal')?.revision).toBe('legacy-revision');
    expect(() => priorReader.get('personal')).toThrow(/no such table/);
    expect(log.append(second)).toBe(true);
    expect(() => store.configureWithdrawals(log, ['personal'])).toThrow('RECOVERY_WITHDRAWAL_HEAD_MISSING');
    expect(log.append(first)).toBe(true);
    expect(log.append(third)).toBe(true);
    store.configureWithdrawals(log, ['personal']);
    expect(store.compareAndSwap('personal', 'legacy-revision', { ...current, state: 'sealed', certificate }, 'primary', log))
      .toBe('denied');
    expect(store.compareAndSwap('personal', 'legacy-revision',
      { ...current, withdrawal: { seq: third.seq, hash: third.hash } }, 'primary', log)).toBe('applied');
  } finally { store.close(); legacy.close(); log.close(); }
});

test('withdrawal readback persists across restart and gates witness updates and recovery across writer epochs', async () => {
  const witnessPath = join(root, 'withdrawal-witness.sqlite');
  const logPath = join(root, 'withdrawals.sqlite');
  const store = openRecoveryWitnessStore(witnessPath, { create: true });
  const log = openRecoveryWithdrawalStore(logPath, { create: true });
  store.initialize(initial);
  const server = start(store, log);
  const origin = await listen(server);
  const primary = createRecoveryWitness({ writerId: 'primary', port: connect(origin, 'primary'), verifySealedProof: async () => true });
  const head = entry(1, emptyHash);
  const next = entry(2, head.hash);
  try {
    expect(await primary.advanceWithdrawalHead(initial.domain, initial.writerEpoch, head)).toBe(false);
    await expect(logPort(origin, 'read-only').appendAndReadBack(head)).rejects.toThrow();
    await expect(logPort(origin, 'candidate-a').appendAndReadBack(head)).rejects.toThrow();
    await expect(logPort(origin, 'primary').appendAndReadBack({ ...head, event: { ...head.event, reason: 'altered' } })).rejects.toThrow();
    expect(await logPort(origin, 'primary').appendAndReadBack(head)).toEqual({
      domain: initial.domain, seq: head.seq, hash: head.hash, verified: true,
    });
    await expect(logPort(origin, 'primary').appendAndReadBack(entry(1, emptyHash, initial.writerEpoch, 'competing'))).rejects.toThrow();
    await expect(logPort(origin, 'candidate-b').readComplete(initial.domain, { ...initial, revision: 'fixture',
      withdrawal: { seq: head.seq, hash: head.hash } })).rejects.toThrow();
    expect(await primary.advanceWithdrawalHead(initial.domain, initial.writerEpoch, head)).toBe(true);
    expect(await logPort(origin, 'primary').appendAndReadBack(head)).toMatchObject({ verified: true });
    await expect(logPort(origin, 'primary').appendAndReadBack(entry(2, head.hash, initial.writerEpoch, head.event.eventId)))
      .rejects.toThrow();
    expect(await logPort(origin, 'primary').appendAndReadBack(next)).toMatchObject({ verified: true });
    const current = (await primary.current(initial.domain))!;
    expect(await primary.sealRecoveryWriter(initial.domain, current.revision, certificate, current.withdrawal)).toBe(false);
  } finally { await close(server); store.close(); log.close(); }

  const reopened = openRecoveryWitnessStore(witnessPath);
  const reopenedLog = openRecoveryWithdrawalStore(logPath);
  const restarted = start(reopened, reopenedLog);
  const fresh = await listen(restarted);
  try {
    const recovered = createRecoveryWitness({ writerId: 'primary', port: connect(fresh, 'primary'), verifySealedProof: async () => true });
    const before = (await recovered.current(initial.domain))!;
    expect(await logPort(fresh, 'read-only').readComplete(initial.domain, before)).toEqual([head]);
    await expect(logPort(fresh, 'read-only').readComplete(initial.domain, {
      ...before, withdrawal: { seq: next.seq, hash: 'f'.repeat(64) },
    })).rejects.toThrow();
    expect(await recovered.advanceWithdrawalHead(initial.domain, initial.writerEpoch, next)).toBe(true);
    const beforeSeal = (await recovered.current(initial.domain))!;
    expect(await recovered.sealRecoveryWriter(initial.domain, beforeSeal.revision, certificate, beforeSeal.withdrawal)).toBe(true);
    const sealed = (await recovered.current(initial.domain))!;
    const candidate = createRecoveryWitness({ writerId: 'candidate-a', port: connect(fresh, 'candidate-a'), verifySealedProof: async () => true });
    expect(await candidate.claimRecoveryWriter(initial.domain, sealed.revision, 'fixture-claim')).toBe('acquired');
    const current = (await candidate.current(initial.domain))!;
    await expect(logPort(fresh, 'primary').appendAndReadBack(entry(3, next.hash))).rejects.toThrow();
    const afterHandoff = entry(3, next.hash, current.writerEpoch);
    expect(await logPort(fresh, 'candidate-a').appendAndReadBack(afterHandoff)).toMatchObject({ verified: true });
    expect(await candidate.advanceWithdrawalHead(initial.domain, current.writerEpoch, afterHandoff)).toBe(true);
    expect(await logPort(fresh, 'read-only').readComplete(initial.domain, (await candidate.current(initial.domain))!))
      .toEqual([head, next, afterHandoff]);
  } finally { await close(restarted); reopened.close(); reopenedLog.close(); }
}, 15_000);

test('mTLS witness chooses one recovery writer, survives authority restart and resolves a lost response', async () => {
  const path = join(root, 'handoff.sqlite');
  const store = openRecoveryWitnessStore(path, { create: true });
  const registered = store.initialize(initial);
  expect(() => store.initialize(initial)).toThrow();
  const server = start(store);
  const origin = await listen(server);
  try {
    const primary = createRecoveryWitness({ writerId: 'primary', port: connect(origin, 'primary'), verifySealedProof: async () => true });
    expect(await primary.sealRecoveryWriter('personal', registered.revision, certificate, withdrawal)).toBe(true);
    const sealed = (await primary.current('personal'))!;
    const candidates = ['candidate-a', 'candidate-b'].map(writerId => {
      const port = connect(origin, writerId);
      const witness = createRecoveryWitness({ writerId, verifySealedProof: async () => true, port: {
        ...port, async compareAndSwap(...args) {
          const changed = await port.compareAndSwap(...args);
          if (changed) throw new Error('FIXTURE_RESPONSE_LOST');
          return changed;
        },
      } });
      return { writerId, witness };
    });
    const results = await Promise.all(candidates.map(({ writerId, witness }) =>
      witness.claimRecoveryWriter('personal', sealed.revision, writerId + '-claim')));
    expect([...results].sort()).toEqual(['acquired', 'lost']);
    const winner = candidates[results.indexOf('acquired')].writerId;
    const committed = await connect(origin, 'read-only').readAuthoritative('personal');
    expect(committed).toMatchObject({ writerId: winner, activationId: winner + '-claim', parentSealedRevision: sealed.revision, state: 'open' });
    expect(committed.writerEpoch).not.toBe(sealed.writerEpoch);
    await close(server);
    store.close();
    const reopened = openRecoveryWitnessStore(path);
    const restarted = start(reopened);
    try {
      const fresh = await listen(restarted);
      expect(await connect(fresh, 'read-only').readAuthoritative('personal')).toEqual(committed);
      const winnerPort = createRecoveryWitness({ writerId: winner, port: connect(fresh, winner) });
      expect(await winnerPort.claimRecoveryWriter('personal', sealed.revision, winner + '-claim')).toBe('acquired');
      expect(await winnerPort.claimRecoveryWriter('personal', sealed.revision, 'different-claim')).toBe('lost');
      const formerWriter = connect(fresh, 'primary');
      await expect(formerWriter.compareAndSwap('personal', committed.revision, {
        ...initial, state: 'sealed', certificate,
      })).rejects.toThrow('RECOVERY_WITNESS_REMOTE_REJECTED');
    } finally { await close(restarted); reopened.close(); }
  } finally { if (server.listening) { await close(server); store.close(); } }
});

test('mTLS recovery activation admits only the CAS winner after a lost commit response', async () => {
  const { domain, writerEpoch } = initial;
  const setId = 'ordered-handoff';
  const recoveryRoot = join(root, `${setId}-sets`);
  const versionLocks = { application: 'fixture' };
  const recoveryPointAt = '2026-11-24T23:59:00.000Z';
  const interruptedAt = '2026-11-25T00:01:00.000Z';
  const startedAt = '2026-11-25T00:02:00.000Z';
  const admittedAt = '2026-11-25T00:05:00.000Z';
  const keys = generateKeyPairSync('ed25519');
  const authority = {
    keyId: setId,
    sign: async (bytes: Uint8Array) => sign(null, bytes, keys.privateKey).toString('base64'),
    verify: async (bytes: Uint8Array, signature: string, keyId: string) =>
      keyId === setId && verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64')),
  };
  const store = openRecoveryWitnessStore(join(root, `${setId}-witness.sqlite`), { create: true });
  let log: ReturnType<typeof openRecoveryWithdrawalStore> | undefined;
  let server: Server | undefined;
  const runtimeDatabases: Database.Database[] = [];
  try {
    log = openRecoveryWithdrawalStore(join(root, `${setId}-log.sqlite`), { create: true });
    store.initialize(initial);
    server = start(store, log, { allowCandidateBWithdrawals: true });
    const origin = await listen(server);
    const primaryPort = connect(origin, 'primary');
    const postCut = entry(1, emptyHash);
    const verifySealedProof = async (record: RecoveryWitnessRecord) =>
      record.certificate?.id === certificate.id && record.certificate.fenceProof === certificate.fenceProof;
    const primary = createRecoveryWitness({ writerId: 'primary', port: primaryPort, verifySealedProof });
    const captured = await (async () => {
      const service = openDatabase(join(root, `${setId}-service.sqlite`));
      let hub: ReturnType<typeof openDatabase> | undefined;
      try {
        hub = openDatabase(join(root, `${setId}-hub.sqlite`));
        for (const database of [service, hub]) {
          database.prepare("INSERT INTO hub_snapshots VALUES ('hub', 1, '{}', ?)").run(recoveryPointAt);
        }
        service.prepare("INSERT INTO accounts VALUES ('owner', 1, 1, ?)").run(recoveryPointAt);
        service.prepare(`INSERT INTO channel_connections VALUES (
          'feishu', 'owner', 'personal', 'app', 'tenant', 'fixture-ref', 1, 1, 4, 2, 3,
          NULL, NULL, 'old-owner', 'old-chat', 'ready', 'active', NULL, NULL, '1.0', ?, ?)`).run(recoveryPointAt, recoveryPointAt);
        service.prepare(`INSERT INTO knowledge_records VALUES
          (?, ?, 'owner', ?, 1, 'available', 'Fixture note', 'Fixture content', '1.0', ?, ?)`)
          .run(postCut.event.targetId, postCut.event.targetId, domain, recoveryPointAt, recoveryPointAt);
        const backup = createRecoveryBackup({
          databases: { service, hub }, root: recoveryRoot, authority, now: () => new Date(recoveryPointAt),
          freeze: { async acquire() {
            return { cutId: certificate.cutId, ingressFrozen: true, claimsFrozen: true, receiptsFrozen: true,
              effectsFrozen: true, executionTreesStopped: true, uncertainCallsJournaled: true,
              durableHandoff: true, async release() {} };
          } },
        });
        const set = await backup.captureRecoverySet({ setId, domains: [{ domain, writerEpoch, withdrawal }], versionLocks, resources: [] });
        expect(set.manifest.completeness).toEqual({ recoverable: true, gaps: [] });
        const { event } = postCut;
        service.prepare('INSERT INTO withdrawal_events VALUES (?,?,?,?,?,?,?,?)')
          .run(event.eventId, domain, event.targetKind, event.targetId, event.targetVersion, event.epoch, event.reason, event.createdAt);
        const journal = createRecoveryWithdrawalJournal({ database: service, witness: primary, log: logPort(origin, 'primary') });
        expect(await journal.protectPending(domain, writerEpoch)).toBe('protected');
        return set;
      } finally { try { service.close(); } finally { hub?.close(); } }
    })();

    const head = { seq: postCut.seq, hash: postCut.hash };
    const beforeSeal = await primaryPort.readAuthoritative(domain);
    expect(beforeSeal.withdrawal).toEqual(head);
    const timedCertificate = { ...certificate, timing: { interruptedAt, recoveryPointAt, manifestSha256: captured.manifestHash } };
    expect(await primary.sealRecoveryWriter(domain, beforeSeal.revision, timedCertificate, head)).toBe(true);
    const sealed = await primaryPort.readAuthoritative(domain);
    expect(sealed).toMatchObject({ certificate: timedCertificate, state: 'sealed', withdrawal: head });

    const contenders = ['candidate-a', 'candidate-b'];
    const bothReady = new AbortController();
    const attempts = new Map<string, { domain: string; revision: string; next: Omit<RecoveryWitnessRecord, 'revision'> }>();
    const outcomes = new Map<string, boolean>();
    const claimReadbacks = new Map<string, RecoveryWitnessRecord>();
    const admissions: Array<{ writerId: string; domain: string; directory: string; writerEpoch: string; activationId: string; witnessRevision: string }> = [];
    const results = await Promise.allSettled(contenders.map(async writerId => {
      const port = connect(origin, writerId);
      const witness = createRecoveryWitness({ writerId, verifySealedProof, port: {
        ...port,
        async readAuthoritative(claimDomain) {
          const record = await port.readAuthoritative(claimDomain);
          if (outcomes.has(writerId) && !claimReadbacks.has(writerId)) claimReadbacks.set(writerId, record);
          return record;
        },
        async compareAndSwap(claimDomain, revision, next) {
          attempts.set(writerId, { domain: claimDomain, revision, next });
          if (attempts.size === contenders.length) bothReady.abort();
          if (!bothReady.signal.aborted) await once(bothReady.signal, 'abort', { signal: AbortSignal.timeout(5000) });
          const applied = await port.compareAndSwap(claimDomain, revision, next);
          outcomes.set(writerId, applied);
          if (applied) throw new Error('FIXTURE_COMMIT_RESPONSE_LOST');
          return applied;
        },
      } });
      let wallClock = startedAt;
      const receipt = await createRecoveryRestorer({
        authority, recoveryRoot, isolationRoot: join(root, `${setId}-${writerId}`), versionLocks,
        witness, withdrawalLog: logPort(origin, writerId), now: () => new Date(wallClock),
        fence: { async verify() { return { stopped: true, credentialsRevoked: true, proof: certificate.fenceProof }; } },
        replay: {
          externalAccess: 'read_only',
          async reconcileHub(context) {
            return { confirmed: context.externalAccess === 'read_only'
              && context.hub.prepare("SELECT hub_seq FROM hub_snapshots WHERE cursor_name='hub'").pluck().get() === 1 };
          },
          async recoverPendingIngest() { return { confirmed: true }; },
          async rebuildProjections() { return { confirmed: true }; },
        },
        activation: { async enableDomain(input) {
          admissions.push({ writerId, ...input });
          const database = new Database(join(input.directory, 'databases/service.sqlite'), { readonly: true });
          runtimeDatabases.push(database);
          createRecoveryRuntimeGate(database).admit({
            domain: input.domain, writerEpoch: input.writerEpoch, activationId: input.activationId, witnessRevision: input.witnessRevision,
          });
          wallClock = admittedAt;
          return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: !recoveryWriteAllowed(database, input.domain) };
        } },
      }).restoreRecoverySet(setId, 'activate', captured.manifestHash);
      return { writerId, receipt };
    }));
    const restored = results.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });

    const committed = await connect(origin, 'read-only').readAuthoritative(domain);
    expect([...attempts.keys()].sort()).toEqual(contenders);
    expect([...outcomes.keys()].sort()).toEqual(contenders);
    expect([...outcomes].filter(([, applied]) => applied)).toEqual([[committed.writerId, true]]);
    expect(claimReadbacks).toEqual(new Map(contenders.map(writerId => [writerId, committed])));
    expect(committed.revision).not.toBe(sealed.revision);
    expect(committed.writerEpoch).not.toBe(sealed.writerEpoch);
    expect(committed).toEqual({ ...attempts.get(committed.writerId)!.next, revision: committed.revision });
    expect(admissions).toHaveLength(1);
    expect(recoveryWriteAllowed(runtimeDatabases[0], domain)).toBe(true);
    expect(restored[0].receipt.directory).not.toBe(restored[1].receipt.directory);
    for (const { writerId, receipt } of restored) {
      const won = writerId === committed.writerId;
      const activationId = `${receipt.receiptId}:${domain}`;
      expect(attempts.get(writerId)).toMatchObject({
        domain, revision: sealed.revision,
        next: { writerId, state: 'open', activationId, parentSealedRevision: sealed.revision, withdrawal: head, certificate: timedCertificate },
      });
      expect(receipt).toMatchObject({
        setId, manifestHash: captured.manifestHash, mode: 'activate', orderlyHandoff: won, external_writes: 0,
        startedAt, finishedAt: won ? admittedAt : startedAt, rpoMs: won ? 120_000 : null, rtoMs: won ? 240_000 : null,
        channels: { feishu: 'requires_reauthorization' },
        data_domains: { [domain]: { status: won ? 'open' : 'blocked', activationId,
          writerEpoch: won ? committed.writerEpoch : null, reasons: won ? [] : ['writer_claim_lost'] } },
      });
      if (won) expect(admissions).toEqual([{
        writerId, domain, directory: receipt.directory, writerEpoch: committed.writerEpoch, activationId, witnessRevision: committed.revision,
      }]);
      const database = new Database(join(receipt.directory, 'databases/service.sqlite'), { readonly: true });
      try {
        expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(database.prepare(`SELECT status,writer_epoch,activation_id,witness_revision,receipt_id
          FROM recovery_domain_gates WHERE data_domain=?`).get(domain)).toEqual({
          status: won ? 'open' : 'protection_pending', writer_epoch: won ? committed.writerEpoch : writerEpoch,
          activation_id: won ? activationId : null, witness_revision: won ? committed.revision : null, receipt_id: receipt.receiptId,
        });
        expect(recoveryWriteAllowed(database, domain)).toBe(false);
        expect(database.prepare('SELECT sequence,previous_hash,entry_hash,protection FROM recovery_withdrawal_log WHERE data_domain=?').all(domain))
          .toEqual([{ sequence: postCut.seq, previous_hash: postCut.previousHash, entry_hash: postCut.hash, protection: 'protected' }]);
        expect(database.prepare('SELECT COUNT(*) FROM recovery_withdrawal_pending').pluck().get()).toBe(0);
        expect(database.prepare('SELECT status FROM knowledge_records WHERE knowledge_id=?').pluck().get(postCut.event.targetId)).toBe('withdrawn');
        expect(database.prepare('SELECT status,transport_mode,owner_open_id,chat_id FROM channel_connections').get()).toEqual({
          status: 'requires_reauthorization', transport_mode: 'disabled', owner_open_id: null, chat_id: null,
        });
        const durable = database.prepare('SELECT receipt_json FROM recovery_receipts WHERE receipt_id=?').pluck().get(receipt.receiptId) as string;
        expect(JSON.parse(durable)).toEqual(receipt);
      } finally { database.close(); }
    }
  } finally {
    try {
      for (const database of runtimeDatabases) database.close();
      if (server?.listening) await close(server);
    } finally { try { store.close(); } finally { log?.close(); } }
  }
}, 120_000);

test('authority enforces enrolled peers, read-only roles, writer fencing and exact revision', async () => {
  const store = openRecoveryWitnessStore(join(root, 'scope.sqlite'), { create: true });
  const record = store.initialize(initial);
  const server = start(store);
  const origin = await listen(server);
  try {
    await expect(connect(origin, 'unenrolled').readAuthoritative('personal')).rejects.toThrow('RECOVERY_WITNESS_REMOTE_REJECTED');
    await expect(connect(origin, 'primary').readAuthoritative('company')).rejects.toThrow('RECOVERY_WITNESS_REMOTE_REJECTED');
    const next = { ...initial, state: 'sealed', certificate } satisfies Omit<RecoveryWitnessRecord, 'revision'>;
    await expect(connect(origin, 'read-only').compareAndSwap('personal', record.revision, next)).rejects.toThrow('RECOVERY_WITNESS_REMOTE_REJECTED');
    await expect(connect(origin, 'candidate-a').compareAndSwap('personal', record.revision, next)).rejects.toThrow('RECOVERY_WITNESS_REMOTE_REJECTED');
    expect(await connect(origin, 'primary').compareAndSwap('personal', 'stale-revision', next)).toBe(false);
    const forged = { ...next, withdrawal: { seq: 1, hash: emptyHash } };
    await expect(connect(origin, 'primary').compareAndSwap('personal', record.revision, forged)).rejects.toThrow('RECOVERY_WITNESS_REMOTE_REJECTED');
    expect(await connect(origin, 'primary').readAuthoritative('personal')).toEqual(record);
    const observed: boolean[] = [];
    server.on('secureConnection', socket => observed.push((socket as TLSSocket).authorized));
    const wrongTrust = Buffer.from(credentials.get('unenrolled')!.cert);
    await expect(connect(origin, 'primary', wrongTrust).readAuthoritative('personal')).rejects.toThrow();
    expect(observed).toEqual([]);
  } finally { await close(server); store.close(); }
});

test('offline import seeds an unbound log only from a complete journal matching the authoritative head', () => {
  const script = fileURLToPath(new URL('../../scripts/recovery-witness.mjs', import.meta.url));
  const witnessPath = join(root, 'import-witness.sqlite');
  const logPath = join(root, 'import-log.sqlite');
  const snapshot = join(root, 'import-service.sqlite');
  const first = entry(1, emptyHash);
  const second = entry(2, first.hash);
  const store = openRecoveryWitnessStore(witnessPath, { create: true });
  const log = openRecoveryWithdrawalStore(logPath, { create: true });
  try {
    store.initialize(initial);
    for (const item of [first, second]) {
      expect(store.compareAndSwap('personal', store.read('personal')!.revision, {
        ...initial, withdrawal: { seq: item.seq, hash: item.hash },
      }, 'primary')).toBe('applied');
    }
  } finally { log.close(); store.close(); }

  function addToSnapshot(path: string, ...items: WithdrawalEntry[]) {
    const service = openDatabase(path);
    chmodSync(path, 0o600);
    try {
      const insert = service.prepare('INSERT INTO recovery_withdrawal_log VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const item of items) insert.run(
        item.domain, item.seq, item.writerEpoch, item.previousHash, item.hash, JSON.stringify(item.event), 'protected',
      );
    } finally { service.close(); }
  }
  const run = (source = snapshot) => spawnSync(process.execPath, [script, 'import-log', witnessPath, logPath, 'personal', source],
    { encoding: 'utf8', timeout: 5000 });
  addToSnapshot(snapshot, first);
  const incomplete = run();
  expect(incomplete.status).toBe(1);
  expect(JSON.parse(incomplete.stderr)).toEqual({ code: 'RECOVERY_WITHDRAWAL_IMPORT_CHAIN_INVALID' });
  const alternate = join(root, 'import-alternate.sqlite');
  addToSnapshot(alternate, first, entry(2, first.hash, initial.writerEpoch, 'alternate'));
  const diverged = run(alternate);
  expect(diverged.status).toBe(1);
  expect(JSON.parse(diverged.stderr)).toEqual({ code: 'RECOVERY_WITHDRAWAL_IMPORT_CHAIN_INVALID' });
  const untouched = openRecoveryWithdrawalStore(logPath);
  try { expect(untouched.read('personal', first.seq, first.hash)).toBeUndefined(); } finally { untouched.close(); }
  addToSnapshot(snapshot, second);
  for (let attempt = 0; attempt < 2; attempt++) {
    const imported = run();
    expect(imported.status, imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toEqual({ status: 'imported', domain: 'personal', seq: second.seq, hash: second.hash });
  }
  const updated = openRecoveryWitnessStore(witnessPath);
  const seeded = openRecoveryWithdrawalStore(logPath);
  try {
    updated.configureWithdrawals(seeded, ['personal']);
    expect(seeded.read('personal', first.seq, first.hash)).toEqual(first);
    expect(seeded.read('personal', second.seq, second.hash)).toEqual(second);
    const enrolled = run();
    expect(enrolled.status).toBe(1);
    expect(JSON.parse(enrolled.stderr)).toEqual({ code: 'RECOVERY_WITNESS_WITHDRAWAL_IMPORT_ALREADY_ENROLLED' });
  } finally { seeded.close(); updated.close(); }
}, 15_000);

test('standalone witness opens only initialized state and serves enrolled clients from a separate process', async () => {
  const script = fileURLToPath(new URL('../../scripts/recovery-witness.mjs', import.meta.url));
  const store = join(root, 'standalone.sqlite');
  const withdrawalStore = join(root, 'standalone-withdrawals.sqlite');
  const config = join(root, 'serve.json');
  const registration = {
    store, authorityId: 'independent-fixture', host: '127.0.0.1', port: 0,
    caPath: join(root, 'ca.pem'), certPath: join(root, 'server.pem'), keyPath: join(root, 'server.key'),
    clients: [{ fingerprint: credentials.get('primary')!.fingerprint, domains: ['personal'], writerId: 'primary' }],
  };
  writeFileSync(config, JSON.stringify(registration), { mode: 0o600 });
  const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
  const missing = run(['serve', config]);
  expect(missing.status).toBe(1);
  expect(JSON.parse(missing.stderr)).toMatchObject({ code: 'RECOVERY_WITNESS_STORE_MISSING' });
  const initialize = run(['initialize', store, 'personal', 'primary', 'initial-epoch']);
  expect(initialize.status, initialize.stderr).toBe(0);
  const revision = JSON.parse(initialize.stdout).revision;
  const sidecar = store + '-wal';
  symlinkSync(registration.keyPath, sidecar);
  expect(JSON.parse(run(['serve', config]).stderr)).toEqual({ code: 'RECOVERY_WITNESS_STORE_INVALID' });
  rmSync(sidecar);
  chmodSync(registration.keyPath, 0o644);
  expect(JSON.parse(run(['serve', config]).stderr)).toEqual({ code: 'RECOVERY_WITNESS_FILE_INVALID' });
  chmodSync(registration.keyPath, 0o600);
  const wrongDomain = { ...registration, clients: [{ ...registration.clients[0], domains: ['company'] }] };
  writeFileSync(config, JSON.stringify(wrongDomain));
  expect(JSON.parse(run(['serve', config]).stderr)).toEqual({ code: 'RECOVERY_WITNESS_DOMAIN_NOT_INITIALIZED' });
  const enrolled = { ...registration, withdrawalStore, clients: [{ ...registration.clients[0], withdrawals: true }] };
  writeFileSync(config, JSON.stringify(enrolled));
  expect(JSON.parse(run(['serve', config]).stderr)).toEqual({ code: 'RECOVERY_WITHDRAWAL_STORE_MISSING' });
  expect(run(['initialize-log', withdrawalStore]).status).toBe(0);
  const child = spawn(process.execPath, [script, 'serve', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const first = await Promise.race([
      once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }).then(([bytes]) => JSON.parse(bytes.toString())),
      exited.then(() => { throw new Error('FIXTURE_AUTHORITY_EXITED'); }),
    ]);
    const origin = `https://127.0.0.1:${first.port}`;
    const port = connect(origin, 'primary');
    const log = logPort(origin, 'primary');
    expect(await port.readAuthoritative('personal')).toEqual({ ...initial, revision });
    const witness = createRecoveryWitness({ writerId: 'primary', port, verifySealedProof: async () => true });
    const service = openDatabase(join(root, 'standalone-service.sqlite'));
    const hub = openDatabase(join(root, 'standalone-hub.sqlite'));
    const recoveryRoot = join(root, 'standalone-sets');
    const versionLocks = { application: 'fixture' };
    const keys = generateKeyPairSync('ed25519');
    const authority = {
      keyId: 'standalone-fixture',
      sign: async (bytes: Uint8Array) => sign(null, bytes, keys.privateKey).toString('base64'),
      verify: async (bytes: Uint8Array, signature: string, keyId: string) =>
        keyId === 'standalone-fixture' && verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64')),
    };
    const entries: WithdrawalEntry[] = [];
    try {
      const createdAt = '2026-11-25T00:00:00.000Z';
      for (const database of [service, hub]) {
        database.prepare("INSERT INTO hub_snapshots VALUES ('hub', 1, '{}', ?)").run(createdAt);
      }
      service.prepare("INSERT INTO accounts VALUES ('owner', 1, 1, ?)").run(createdAt);
      service.prepare(`INSERT INTO channel_connections VALUES (
        'feishu', 'owner', 'personal', 'app', 'tenant', 'fixture-ref', 1, 1, 4, 2, 3,
        NULL, NULL, 'old-owner', 'old-chat', 'ready', 'active', NULL, NULL, '1.0', ?, ?)`).run(createdAt, createdAt);
      const backup = createRecoveryBackup({
        databases: { service, hub }, root: recoveryRoot, authority,
        freeze: { async acquire() {
          return { cutId: certificate.cutId, ingressFrozen: true, claimsFrozen: true, receiptsFrozen: true,
            effectsFrozen: true, executionTreesStopped: true, uncertainCallsJournaled: true,
            durableHandoff: true, async release() {} };
        } },
      });
      const captured = await backup.captureRecoverySet({
        setId: 'standalone-fixture', domains: [{ domain: initial.domain, writerEpoch: initial.writerEpoch, withdrawal }],
        versionLocks, resources: [],
      });
      expect(captured.manifest.completeness).toEqual({ recoverable: true, gaps: [] });
      const insert = service.prepare('INSERT INTO withdrawal_events VALUES (?,?,?,?,?,?,?,?)');
      let previousHash = emptyHash;
      for (let seq = 1; seq <= 18; seq++) {
        const value = entry(seq, previousHash);
        const { event } = value;
        insert.run(event.eventId, value.domain, event.targetKind, event.targetId, event.targetVersion, event.epoch, event.reason, event.createdAt);
        entries.push(value);
        previousHash = value.hash;
      }
      const journal = createRecoveryWithdrawalJournal({ database: service, witness, log });
      expect(await journal.protectPending(initial.domain, initial.writerEpoch)).toBe('protected');
      expect(service.prepare('SELECT COUNT(*) AS count FROM recovery_withdrawal_pending').get()).toEqual({ count: 0 });
    } finally { try { service.close(); } finally { hub.close(); } }
    const current = (await witness.current(initial.domain))!;
    expect(current.withdrawal).toEqual({ seq: 18, hash: entries.at(-1)!.hash });
    expect(await witness.sealRecoveryWriter(initial.domain, current.revision, certificate, current.withdrawal)).toBe(true);
    const isolated = await createRecoveryRestorer({
      authority, recoveryRoot, isolationRoot: join(root, 'standalone-isolation'), versionLocks,
      witness, withdrawalLog: log,
      fence: { async verify() { return { stopped: true, credentialsRevoked: true, proof: certificate.fenceProof }; } },
      replay: { externalAccess: 'read_only', async reconcileHub() { return { confirmed: true }; },
        async recoverPendingIngest() { return { confirmed: true }; }, async rebuildProjections() { return { confirmed: true }; } },
    }).restoreRecoverySet('standalone-fixture');
    expect(isolated).toMatchObject({
      orderlyHandoff: false, external_writes: 0, channels: { feishu: 'requires_reauthorization' },
      data_domains: { personal: { status: 'blocked', reasons: ['drill_mode'] } },
    });
    const recovered = new Database(join(isolated.directory, 'databases/service.sqlite'), { readonly: true });
    try {
      expect(recovered.prepare('SELECT sequence,entry_hash,protection FROM recovery_withdrawal_log ORDER BY sequence').all())
        .toEqual(entries.map(value => ({ sequence: value.seq, entry_hash: value.hash, protection: 'protected' })));
      expect(recovered.prepare('SELECT status,transport_mode FROM channel_connections').get())
        .toEqual({ status: 'requires_reauthorization', transport_mode: 'disabled' });
    } finally { recovered.close(); }
    child.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
    const reopened = openRecoveryWitnessStore(store);
    try {
      expect(reopened.read('personal')).toMatchObject({ certificate, state: 'sealed', withdrawal: current.withdrawal });
      expect(() => reopened.initialize({ ...initial, domain: 'company' })).toThrow('RECOVERY_WITNESS_INITIALIZATION_DISABLED');
    }
    finally { reopened.close(); }
    const missingHead = join(root, 'standalone-empty-log.sqlite');
    expect(run(['initialize-log', missingHead]).status).toBe(0);
    writeFileSync(config, JSON.stringify({ ...enrolled, withdrawalStore: missingHead }));
    const wrongStore = run(['serve', config]);
    expect(wrongStore.status).toBe(1);
    expect(JSON.parse(wrongStore.stderr)).toEqual({ code: 'RECOVERY_WITNESS_WITHDRAWAL_STORE_MISMATCH' });
    writeFileSync(config, JSON.stringify(registration));
    const missingStore = run(['serve', config]);
    expect(missingStore.status).toBe(1);
    expect(JSON.parse(missingStore.stderr)).toEqual({ code: 'RECOVERY_WITNESS_WITHDRAWAL_STORE_MISMATCH' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}, 15_000);
