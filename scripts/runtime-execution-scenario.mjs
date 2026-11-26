import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [id, artifactRoot, materialSha256, sourceRoot, hubCommit] = process.argv.slice(2);
const inventoryBytes = await readFile(join(artifactRoot, 'metadata/runtime-materials.json'));
const inventory = JSON.parse(inventoryBytes);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(process.platform, inventory.observed.platform);
assert.equal(process.arch, inventory.observed.arch);
assert.equal(process.version, inventory.observed.node);
assert.equal(process.versions.modules, inventory.observed.modules);
const modules = {};
for (const name of ['composition', 'cli', 'service', 'worker']) {
  modules[name] = await import(pathToFileURL(join(artifactRoot, 'runtime', `${name}.mjs`)));
}
const require = createRequire(join(artifactRoot, 'runtime/composition.mjs'));
const sqlitePackage = 'better-sqlite3';
assert.equal(require.resolve(sqlitePackage).startsWith(join(artifactRoot, 'node_modules') + '/'), true);
await assert.rejects(readFile(join(sourceRoot, 'node_modules/better-sqlite3/package.json')), { code: 'ERR_ACCESS_DENIED' });
const nativeSha256 = sha256(await readFile(join(artifactRoot, inventory.native.path)));
assert.equal(nativeSha256, inventory.native.sha256);
const sqlite = new (require(sqlitePackage))(':memory:');
const sqliteVersion = sqlite.prepare('select sqlite_version() as version').get().version;
sqlite.close();
assert.equal(sqliteVersion, inventory.native.sqlite);
const dataRoot = await mkdtemp(join(process.cwd(), 'data-'));
const { createRuntimeProvisioning, openRuntimeDatabase } = modules.composition;
let outcome;

if (id === 'relocated-node-import') {
  const entries = { composition: 'createRuntimeProvisioning', cli: 'createInstalledCli',
    service: 'runInstalledService', worker: 'runInstalledWorker' };
  for (const [name, entry] of Object.entries(entries)) assert.equal(typeof modules[name][entry], 'function');
  outcome = { entries };
} else if (id === 'sqlite-migrate-reopen') {
  const file = join(dataRoot, 'main.sqlite');
  function open() {
    const database = openRuntimeDatabase(file);
    try {
      assert.equal(database.pragma('journal_mode', { simple: true }), 'wal');
      return database.prepare('select count(*) as count from schema_migrations').get().count;
    } finally { database.close(); }
  }
  const migrations = open();
  assert.ok(migrations > 0);
  assert.equal(open(), migrations);
  outcome = { migrations, sqliteVersion };
} else {
  const identity = { accountId: 'fixture-account', scopeId: 'fixture-scope', domains: ['personal'],
    deviceId: 'fixture-device', configRevision: '1' };
  const origin = 'http://localhost';
  const registration = { identity, captureHost: hostname(), serviceUid: process.geteuid(), profile: 'test',
    dataRoot, minimumFreeBytes: 0, origin, rpId: 'localhost', listener: { host: '127.0.0.1', port: 0, origin } };
  const credentialDirectory = join(dataRoot, 'credentials');
  const recoveryRoot = join(dataRoot, 'recovery');
  await mkdir(credentialDirectory);
  await mkdir(recoveryRoot);
  const now = new Date().toISOString();
  const authority = { keyId: 'fixture', async sign() { throw new Error('unexpected signature'); }, async verify() { return false; } };
  const writer = { domain: 'personal', writerEpoch: 'fixture-epoch', activationId: 'fixture-activation', witnessRevision: 'fixture-witness' };
  let database;
  const service = {
    databasePath: join(dataRoot, 'service.sqlite'), credentialDirectory,
    recoveryRuntime: { attach(context) {
      database = context.database;
      database.prepare('INSERT OR IGNORE INTO recovery_domain_gates(data_domain,writer_epoch,status,activation_id,witness_revision,reason,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(writer.domain, writer.writerEpoch, 'open', writer.activationId, writer.witnessRevision, 'fixture', now);
      context.admission.admit(writer);
    } },
    bindRecoveryOperations() { return { root: recoveryRoot, authority, targets: {} }; },
  };
  if (id === 'service-cli-drain') {
    const provisioning = createRuntimeProvisioning({ registration, service, hostCapabilities: {
      recovery: { root: recoveryRoot, authority, targets: { backup: { identity } } },
    } });
    const preview = await modules.cli.createInstalledCli(provisioning).run(['backup', '--preview', '--target', 'backup']);
    assert.equal(preview.code, 'RECOVERY_PREVIEW');
    const runtime = modules.service.createInstalledService(provisioning);
    const listener = await modules.service.startServiceListener(runtime, provisioning);
    try {
      const home = await fetch(listener.url + '/', { signal: AbortSignal.timeout(5000) });
      assert.equal(home.status, 200);
      assert.match(await home.text(), /<title>PAtrick/);
      const session = await fetch(listener.url + '/api/v1/session', { signal: AbortSignal.timeout(5000) });
      assert.equal(session.status, 401);
      await session.text();
      const { ticket } = listener.issueOwnerBootstrap();
      const challenge = await fetch(listener.url + '/api/v1/auth/challenge', {
        method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-patrick-bootstrap': ticket },
        body: JSON.stringify({ rp_id: registration.rpId }), signal: AbortSignal.timeout(5000),
      });
      assert.equal(challenge.status, 200);
      assert.equal((await challenge.json()).challenge.user.name, identity.accountId);
    } finally {
      const drained = await listener.drain({ timeoutMs: 5000 });
      assert.equal(drained.listener, 'closed');
      assert.equal(drained.runtime.status, 'closed');
      outcome = { preview: preview.code, session: 'unauthenticated', ownerChallenge: 'issued', drain: 'closed' };
    }
  } else {
    assert.equal(id, 'worker-role-readback');
    assert.match(hubCommit, /^[a-f0-9]{40}$/);
    const events = [];
    const hub = createServer(async (request, response) => {
      if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true, commit: hubCommit }));
      if (request.headers.authorization !== 'Bearer fixture-source') return response.writeHead(401).end();
      if (request.url === '/v1/events' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        events.push(JSON.parse(Buffer.concat(chunks)).type);
        return response.end(JSON.stringify({ event: 1, duplicate: false, routed: ['咨询'] }));
      }
      if (request.url === '/v1/events/1') {
        return response.end(JSON.stringify({ event: 1, runs: [{ run: 1, rule: '咨询', state: 'queued' }] }));
      }
      return response.writeHead(404).end();
    });
    hub.listen(0, '127.0.0.1');
    await once(hub, 'listening');
    const hubOrigin = `http://127.0.0.1:${hub.address().port}`;
    const provisioning = createRuntimeProvisioning({ registration: { ...registration, operationalHub: { origin: hubOrigin, commit: hubCommit } },
      service, worker: { keys: { owner: 'fixture-owner', worker: 'fixture-worker', source: 'fixture-source' } } });
    const runtime = modules.service.createInstalledService(provisioning);
    let worker;
    try {
      database.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(identity.accountId, 1, 1, now);
      database.prepare('INSERT INTO caller_scopes VALUES (?,?,?,?,NULL)').run(identity.accountId, 'web', 'personal', 'owner');
      const secret = 'a'.repeat(48);
      database.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)')
        .run(sha256(secret), identity.accountId, 'web', 1, new Date(Date.now() + 60_000).toISOString(), now, 'fixture');
      const payload = { parent_work_id: null, request_scope: { account_id: identity.accountId, caller_id: 'web',
        data_domain: 'personal', permission_epoch: 1 }, text: 'Candidate runtime exercise' };
      const response = await runtime.app.request(origin + '/api/v1/consultations', { method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie: ['patrick_session', secret].join('=') },
        body: JSON.stringify({ client_request_id: 'fixture-dispatch', expected_revision: null, payload,
          payload_hash: sha256(JSON.stringify(payload)) }),
      });
      assert.equal(response.status, 202, await response.text());
      worker = await modules.worker.runInstalledWorker(provisioning);
      const receipt = database.prepare("SELECT result FROM outbox WHERE destination='autoloop'");
      const expires = performance.now() + 5000;
      let result;
      while (performance.now() < expires && !(result = receipt.get()?.result)) await delay(20);
      assert.equal(result, 'accepted');
      assert.deepEqual(events, ['consultation.requested']);
      outcome = { result, events };
    } finally {
      try {
        if (worker) assert.equal((await worker.drain({ timeoutMs: 5000 })).status, 'closed');
        assert.equal((await runtime.drain({ timeoutMs: 5000 })).status, 'closed');
      } finally {
        const closed = once(hub, 'close');
        hub.close();
        hub.closeAllConnections();
        await closed;
      }
    }
  }
}

console.log(JSON.stringify({ id, materialSha256, inventorySha256: sha256(inventoryBytes), nativeSha256,
  os: process.platform, arch: process.arch, node: process.version, modules: process.versions.modules, outcome }));
