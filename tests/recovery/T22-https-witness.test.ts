import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createRecoveryWitness, type RecoveryWitnessRecord } from '../../packages/host/src/recovery/witness.js';
import { createHttpsRecoveryWitnessPort, createRecoveryWitnessServer, openRecoveryWitnessStore } from '../../packages/host/src/recovery/https-witness.mjs';

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

function start(store: ReturnType<typeof openRecoveryWitnessStore>) {
  const clients = ['primary', 'candidate-a', 'candidate-b', 'read-only'].map(name => ({
    fingerprint: credentials.get(name)!.fingerprint, domains: ['personal'], ...(name === 'read-only' ? {} : { writerId: name }),
  }));
  return createRecoveryWitnessServer({ ...serverTls, ca, authorityId: 'independent-fixture', clients, store });
}

function connect(origin: string, name: string, tlsCa = ca) {
  return createHttpsRecoveryWitnessPort({ origin, authorityId: 'independent-fixture', ...credentials.get(name)!, ca: tlsCa });
}

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

test('standalone witness opens only initialized state and serves enrolled clients from a separate process', async () => {
  const script = fileURLToPath(new URL('../../scripts/recovery-witness.mjs', import.meta.url));
  const store = join(root, 'standalone.sqlite');
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
  writeFileSync(config, JSON.stringify(registration));
  const child = spawn(process.execPath, [script, 'serve', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const first = await Promise.race([
      once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }).then(([bytes]) => JSON.parse(bytes.toString())),
      exited.then(() => { throw new Error('FIXTURE_AUTHORITY_EXITED'); }),
    ]);
    const port = connect(`https://127.0.0.1:${first.port}`, 'primary');
    expect(await port.readAuthoritative('personal')).toEqual({ ...initial, revision });
    const witness = createRecoveryWitness({ writerId: 'primary', port, verifySealedProof: async () => true });
    expect(await witness.sealRecoveryWriter('personal', revision, certificate, withdrawal)).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
    const reopened = openRecoveryWitnessStore(store);
    try {
      expect(reopened.read('personal')).toMatchObject({ certificate, state: 'sealed' });
      expect(() => reopened.initialize({ ...initial, domain: 'company' })).toThrow('RECOVERY_WITNESS_INITIALIZATION_DISABLED');
    }
    finally { reopened.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}, 15_000);
