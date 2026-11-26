import { mkdir, mkdtemp, readFile, realpath, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPayload } from '@patrick/contracts';
import { expect, test, vi } from 'vitest';
import { createVaultReconciliationWorker } from '../../apps/service/src/vault-reconciliation.js';
import { createRuntimeProvisioning } from '../../deploy/runtime/composition.js';
import { createInstalledService } from '../../deploy/runtime/service.js';
import { renderCommittedView } from '../../packages/integrations/vault/adoption-projection.js';
import { confirmVault, connectVault, requireVault } from '../../packages/integrations/vault/connection.js';
import { sha256 } from '../../packages/integrations/vault/projection-publication.js';
import { projectionManifest } from '../../packages/integrations/vault/projector.js';
import { readVault, readVaultEdit } from '../../packages/integrations/vault/reader.js';
import { reconcileConnectedVaults } from '../../packages/integrations/vault/reconciliation.js';
import { createBlobStore, openDatabase, type SqliteDatabase } from '@patrick/storage';

const identity = { accountId: 'owner', scopeId: 'test', domains: ['personal', 'other-account', 'other-host'],
  deviceId: 'workstation', configRevision: '1' };
const noteFile = '知识笔记/验收 #1.md';
const note = (body: string) => `---\nkind: knowledge\nknowledge_id: k-roundtrip\n---\n\n${body}\n`;
const batchFile = (root: string, vaultId: string, revision: number) =>
  join(root, '系统视图', '批次', `vault-sync-${sha256(vaultId).slice(0, 24)}-${revision}`, '知识', '当前.md');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}

test('the installed service reconciles a saved Vault with no listener, and resumes without duplicate publications', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'patrick-vault-service-'));
  const databasePath = join(root, 'service.sqlite');
  const credentialDirectory = join(root, 'credentials');
  const captureHost = hostname();
  const now = new Date().toISOString();
  const authority = { keyId: 'fixture', async sign(): Promise<string> { throw Error('unused'); }, async verify() { return false; } };
  let database!: SqliteDatabase;
  const provisioning = createRuntimeProvisioning({
    registration: { identity, captureHost, serviceUid: process.geteuid!(), profile: 'test', dataRoot: root,
      minimumFreeBytes: 0, origin: 'http://localhost', rpId: 'localhost',
      listener: { host: '127.0.0.1', port: 0, origin: 'http://localhost' } },
    service: { databasePath, credentialDirectory,
      recoveryRuntime: { attach({ database: handle, admission }) {
        database = handle;
        for (const domain of ['personal', 'work', 'other-account', 'other-host']) {
          database.prepare(`INSERT OR IGNORE INTO recovery_domain_gates
            (data_domain,writer_epoch,status,activation_id,witness_revision,reason,updated_at) VALUES(?,?,?,?,?,?,?)`)
            .run(domain, 'epoch', 'open', 'activation', 'witness', 'fixture', now);
          admission.admit({ domain, writerEpoch: 'epoch', activationId: 'activation', witnessRevision: 'witness' });
        }
      } },
      bindRecoveryOperations() { return { root, authority, targets: {} }; },
    },
  });
  let runtime: ReturnType<typeof createInstalledService> | undefined;
  const vaultPath = join(root, 'personal');
  const pointer = () => database.prepare(`SELECT projection_revision AS revision FROM projection_pointers
    WHERE data_domain='personal' AND view_kind='standards'`).get();
  const revisions = () => database.prepare('SELECT vault_id,content_hash,observed_seq FROM vault_revisions ORDER BY observed_seq').all();
  try {
    await mkdir(credentialDirectory);
    runtime = createInstalledService(provisioning);
    for (const domain of ['personal', 'work', 'other-account', 'other-host']) {
      const vault = join(root, domain);
      const host = domain === 'other-host' ? 'foreign-host' : captureHost;
      await mkdir(join(vault, '知识笔记'), { recursive: true });
      await writeFile(join(vault, noteFile), note(domain === 'personal' ? '初次保存' : '范围外'));
      await connectVault(database, { accountId: domain === 'other-account' ? 'foreign-account' : identity.accountId,
        deviceId: identity.deviceId, vaultId: domain, root: vault, domain, captureHost: host, now });
      await confirmVault(database, identity.deviceId, domain, now);
    }
    await expect(runtime.drain()).resolves.toMatchObject({ status: 'closed' });
    runtime = createInstalledService(provisioning);
    await vi.waitFor(() => expect(pointer()).toEqual({ revision: 1 }), { timeout: 5000 });
    const firstHash = sha256(note('初次保存'));
    expect(revisions()).toEqual([{ vault_id: 'personal', content_hash: firstHash, observed_seq: 1 }]);
    const blobs = createBlobStore(join(root, 'blobs'));
    expect(Buffer.from(await blobs.readBlob(firstHash)).toString()).toBe(note('初次保存'));
    expect(await readFile(join(vaultPath, '系统视图/索引.md'), 'utf8')).toContain('projection_revision: 1');
    expect(await readFile(batchFile(vaultPath, 'personal', 1), 'utf8')).toContain('"revision": 1');

    await expect(runtime.drain()).resolves.toMatchObject({ status: 'closed' });
    runtime = createInstalledService(provisioning);
    await vi.waitFor(() => expect(runtime?.read()).toMatchObject({ active: 0 }), { timeout: 5000 });
    await writeFile(join(vaultPath, noteFile), note('稍后保存'));
    await vi.waitFor(() => expect(pointer()).toEqual({ revision: 2 }), { timeout: 8000 });
    expect(revisions()).toEqual([
      { vault_id: 'personal', content_hash: firstHash, observed_seq: 1 },
      { vault_id: 'personal', content_hash: sha256(note('稍后保存')), observed_seq: 2 },
    ]);
    expect(await readFile(batchFile(vaultPath, 'personal', 2), 'utf8')).toContain('"revision": 2');
    expect(Buffer.from(await blobs.readBlob(sha256(note('稍后保存')))).toString()).toBe(note('稍后保存'));

    await expect(runtime.drain()).resolves.toMatchObject({ status: 'closed' });
    await rename(vaultPath, join(root, 'original-personal'));
    await mkdir(join(vaultPath, '知识笔记'), { recursive: true });
    await writeFile(join(vaultPath, noteFile), note('替换目录'));
    runtime = createInstalledService(provisioning);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pointer()).toEqual({ revision: 2 });
    expect(revisions()).toHaveLength(2);
  } finally {
    await runtime?.drain();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test('stopping collection joins an active archive write and leaves its uncommitted Vault revision for restart', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'patrick-vault-drain-'));
  const database = openDatabase(join(root, 'service.sqlite'));
  const blobs = createBlobStore(join(root, 'blobs'));
  const vault = join(root, 'vault');
  const started = deferred();
  const release = deferred();
  const worker = createVaultReconciliationWorker(database, { ...blobs,
    async putBlob(bytes) {
      started.resolve();
      await release.promise;
      return blobs.putBlob(bytes);
    } }, { ...identity, captureHost: hostname() }, () => new Date(), new AbortController().signal);
  try {
    const now = new Date().toISOString();
    await mkdir(join(vault, '知识笔记'), { recursive: true });
    await writeFile(join(vault, noteFile), note('排空期间保存'));
    await connectVault(database, { accountId: identity.accountId, deviceId: identity.deviceId, vaultId: 'vault',
      root: vault, domain: 'personal', captureHost: hostname(), now });
    await confirmVault(database, identity.deviceId, 'vault', now);
    worker.start();
    await started.promise;
    worker.stop();
    const joined = worker.join();
    expect(worker.active).toBe(1);
    release.resolve();
    await joined;
    expect(worker.active).toBe(0);
    expect(worker.errors).toEqual([]);
    expect(database.prepare('SELECT 1 FROM vault_revisions').get()).toBeUndefined();
    expect(database.prepare('SELECT 1 FROM projection_pointers').get()).toBeUndefined();
  } finally {
    worker.stop();
    release.resolve();
    await worker.join();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a restarted reconciler replays the exact reserved projection before publishing newly collected content', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'patrick-vault-replay-'));
  const databasePath = join(root, 'service.sqlite');
  let database = openDatabase(databasePath);
  const blobs = createBlobStore(join(root, 'blobs'));
  const vault = join(root, 'vault');
  const scope = { ...identity, captureHost: hostname() };
  const now = new Date().toISOString();
  try {
    await mkdir(join(vault, '知识笔记'), { recursive: true });
    await writeFile(join(vault, noteFile), note('保留原批次'));
    await connectVault(database, { accountId: identity.accountId, deviceId: identity.deviceId, vaultId: 'vault',
      root: vault, domain: 'personal', captureHost: scope.captureHost, now });
    await confirmVault(database, identity.deviceId, 'vault', now);
    await readVault(database, blobs, 'vault', now);
    const binding = requireVault(database, 'vault');
    const original = renderCommittedView(database, binding);
    const bytes = Buffer.from(canonicalPayload(original));
    const blob = await blobs.putBlob(bytes);
    database.prepare('INSERT INTO blobs (sha256,byte_length,created_at) VALUES (?,?,?)').run(blob, bytes.length, now);
    const manifest = canonicalPayload({ reconciliationRender: { blob, configRevision: binding.config_revision,
      connectionEpoch: binding.connection_epoch, rootIdentity: binding.root_identity }, manifest: projectionManifest(original) });
    database.prepare(`INSERT INTO projection_batches VALUES ('personal','standards',1,'vault',?,
      ?,?,'pending',0,?,?)`).run(`vault-sync-${sha256('vault').slice(0, 24)}-1`, manifest, sha256(manifest), now, now);
    database.close();
    await writeFile(join(vault, noteFile), note('重启期间保存'));
    await mkdir(join(vault, '附件'));
    const attachment = join(vault, '附件', '待处理.pdf');
    await writeFile(attachment, 'sample');
    await truncate(attachment, 20_000_001);
    database = openDatabase(databasePath);
    const onError = vi.fn();
    const tick = () => reconcileConnectedVaults(database, blobs, scope, now, new AbortController().signal, onError);
    await tick();
    expect(await readFile(batchFile(vault, 'vault', 1), 'utf8')).toBe(original['知识/当前.md']);
    expect(database.prepare('SELECT applied FROM projection_batches WHERE projection_revision=1').get()).toEqual({ applied: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
    await rm(attachment);
    await tick();
    expect(await readFile(batchFile(vault, 'vault', 2), 'utf8')).toContain('"revision": 2');
    expect(database.prepare('SELECT projection_revision FROM projection_pointers').get()).toEqual({ projection_revision: 2 });
  } finally {
    if (database.open) database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a background scan cannot commit an older snapshot after an explicit edit check commits', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'patrick-vault-race-'));
  const database = openDatabase(join(root, 'service.sqlite'));
  const blobs = createBlobStore(join(root, 'blobs'));
  const vault = join(root, 'vault');
  const started = deferred();
  const release = deferred();
  const now = new Date().toISOString();
  let scan: ReturnType<typeof readVault> | undefined;
  try {
    await mkdir(join(vault, '知识笔记'), { recursive: true });
    await writeFile(join(vault, noteFile), note('旧稿'));
    await connectVault(database, { accountId: identity.accountId, deviceId: identity.deviceId, vaultId: 'vault',
      root: vault, domain: 'personal', captureHost: hostname(), now });
    await confirmVault(database, identity.deviceId, 'vault', now);
    scan = readVault(database, { ...blobs, async putBlob(bytes) {
      started.resolve();
      await release.promise;
      return blobs.putBlob(bytes);
    } }, 'vault', now, { authorize() {} });
    await started.promise;
    await writeFile(join(vault, noteFile), note('新稿'));
    await readVaultEdit(database, blobs, 'vault', noteFile, now, () => {});
    release.resolve();
    await expect(scan).resolves.toMatchObject({ state: 'ready', collected: 0 });
    expect(database.prepare('SELECT observed_seq,content_hash FROM vault_revisions').all())
      .toEqual([{ observed_seq: 1, content_hash: sha256(note('新稿')) }]);
  } finally {
    release.resolve();
    await scan?.catch(() => {});
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
