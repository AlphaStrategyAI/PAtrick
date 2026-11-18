import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

const io = vi.hoisted(() => ({ roots: [] as string[], calls: [] as string[] }));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  function observe(name: string, path: unknown) {
    if (typeof path === 'string' && io.roots.some((root) => path === root || path.startsWith(root + '/'))) io.calls.push(name + ':' + path);
  }
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) => { observe('realpath', args[0]); return actual.realpath(...args); },
    stat: (...args: Parameters<typeof actual.stat>) => { observe('stat', args[0]); return actual.stat(...args); },
    readdir: (...args: Parameters<typeof actual.readdir>) => { observe('readdir', args[0]); return actual.readdir(...args); },
    readFile: (...args: Parameters<typeof actual.readFile>) => { observe('readFile', args[0]); return actual.readFile(...args); },
    open: (...args: Parameters<typeof actual.open>) => { observe('open', args[0]); return actual.open(...args); },
  };
});
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { openDatabase } from '../../packages/storage/src/database.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';

test('normal directory preview is blocked before normalization or filesystem access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-block-red-')); const dir = join(root, 'source');
  mkdirSync(dir); writeFileSync(join(dir, 'note.md'), 'ordinary test note');
  const db = openDatabase(join(root, 'state.sqlite'));
  try {
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    io.roots = [dir, realpathSync(dir)]; io.calls = [];
    await expect(registry.detectSource({ accountId: 'owner', dataDomain: 'personal' }, { type: 'directory', target: dir }))
      .rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    expect(io.calls).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_configs').get()).toEqual({ n: 0 });
  } finally { io.roots = []; db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('paused directory reads return a blocked error without inventing a receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-block-paused-')); const dir = join(root, 'source'); mkdirSync(dir);
  const db = openDatabase(join(root, 'state.sqlite')); const stamp = '2026-11-17T05:00:00.000Z';
  try {
    db.prepare(`INSERT INTO source_configs VALUES ('legacy','owner','personal','directory',?,?,'{}','[]',NULL,'poll','none',0,0,'paused',2,'1.0',?,?)`)
      .run(dir, dir, stamp, stamp);
    db.prepare("INSERT INTO source_cursors VALUES ('legacy',2,'sweep:1','advanced',1,?)").run(stamp);
    const registry = createSourceRegistry(db, { blobs: createBlobStore(join(root, 'blobs')) });
    io.roots = [dir, realpathSync(dir)]; io.calls = [];
    await expect(registry.collectSource('legacy', 1)).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    await expect(registry.wakeDirectory('legacy', 'note.md')).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    expect(io.calls).toEqual([]);
    expect(db.prepare('SELECT status,config_revision FROM source_configs').get()).toEqual({ status: 'paused', config_revision: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM collection_receipts').get()).toEqual({ n: 0 });
  } finally { io.roots = []; db.close(); rmSync(root, { recursive: true, force: true }); }
});

async function seededHistory() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-block-history-')); const dir = join(root, 'source');
  mkdirSync(dir); writeFileSync(join(dir, 'note.md'), 'new ordinary note');
  const db = openDatabase(join(root, 'state.sqlite')); const blobs = createBlobStore(join(root, 'blobs'));
  const stamp = '2026-11-17T05:00:00.000Z'; const path = realpathSync(dir);
  const scope = JSON.stringify({ repo: null, branch: null, path: null, root: path, excludes: [] });
  db.prepare(`INSERT INTO source_configs VALUES ('legacy','owner','personal','directory',?,?,?,'[]',NULL,'poll','none',0,1,'enabled',1,'1.0',?,?)`)
    .run(path, path, scope, stamp, stamp);
  db.prepare(`INSERT INTO source_versions SELECT source_id,config_revision,account_id,data_domain,connector_type,normalized_target,
    physical_root,scope_json,excludes_json,credential_ref,frequency,history,has_trigger_rule,enabled,status,schema_version,created_at
    FROM source_configs WHERE source_id='legacy'`).run();
  db.prepare("INSERT INTO source_cursors VALUES ('legacy',1,'sweep:1','advanced',1,?)").run(stamp);
  db.prepare("INSERT INTO collection_receipts VALUES ('legacy-receipt','legacy',1,'first_collection','sweep:1',1,NULL,?,1,NULL)").run(stamp);
  const hash = await blobs.putBlob(Buffer.from('saved historical note'));
  db.prepare('INSERT INTO blobs VALUES (?,?,?)').run(hash, Buffer.byteLength('saved historical note'), stamp);
  db.prepare("INSERT INTO source_objects VALUES ('legacy','old-object','note.md','connector',0,1)").run();
  db.prepare(`INSERT INTO source_revisions VALUES ('legacy','old-object',1,'old-revision',?,'connector',0,'owner','personal','1.0',?)`).run(hash, stamp);
  db.prepare("INSERT INTO source_revision_provenance VALUES ('old-revision','legacy',1,'owner','personal')").run();
  db.prepare("INSERT INTO domain_events VALUES (1,'old-event','old-object',1,NULL,'owner','personal','1.0','{}',?)").run(stamp);
  db.prepare("INSERT INTO outbox (event_id,destination) VALUES ('old-event','source-work')").run();
  const registry = createSourceRegistry(db, { blobs });
  const tables = ['source_configs', 'source_versions', 'source_cursors', 'source_objects', 'source_revisions', 'source_revision_provenance',
    'directory_commit_generations', 'collection_receipts', 'delete_sweeps', 'domain_events', 'outbox', 'blobs'];
  const state = () => tables.map((name) => db.prepare(`SELECT * FROM ${name}`).all());
  return { root, dir, db, blobs, hash, registry, state, close() { io.roots = []; if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('enabled existing directory preserves revisions, blobs, cursor and outbox while all reads are blocked', async () => {
  const f = await seededHistory();
  try {
    const before = f.state();
    io.roots = [f.dir, realpathSync(f.dir)]; io.calls = [];
    const actor = { accountId: 'owner', dataDomain: 'personal' };
    await expect(f.registry.detectSource(actor, { type: 'directory', target: f.dir })).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    await expect(f.registry.enableSource(actor, { type: 'directory', target: f.dir })).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    await expect(f.registry.collectSource('legacy', 1)).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    await expect(f.registry.collectSource('legacy', 99)).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    await expect(f.registry.wakeDirectory('legacy', 'note.md')).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    expect(io.calls).toEqual([]);
    expect(f.state()).toEqual(before);
    expect(Buffer.from(await f.blobs.readBlob(f.hash)).toString()).toBe('saved historical note');
  } finally { f.close(); }
});

test('direct public directory I/O helpers fail before filesystem access and keep the pure stability function', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrick-block-helpers-')); const dir = join(root, 'source'); mkdirSync(dir);
  try {
    writeFileSync(join(dir, 'note.md'), 'ordinary note');
    io.roots = [dir, realpathSync(dir)]; io.calls = [];
    const { samplePath, scanDirectory, listSamples, stabilityDecision } = await import('../../packages/integrations/sources/directory.js');
    await expect(samplePath(join(dir, 'note.md'))).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    await expect(scanDirectory(dir, [])).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    await expect(listSamples(dir, [])).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    expect(io.calls).toEqual([]);
    expect(stabilityDecision({ size: 1, mtimeMs: 2 }, { exists: true, offline: false, placeholder: false, size: 1, mtimeMs: 2 }).ready).toBe(true);
  } finally { io.roots = []; rmSync(root, { recursive: true, force: true }); }
});

test('recovery closure takes priority over blocked directory reads, without filesystem or state changes', async () => {
  const f = await seededHistory();
  try {
    const { createRecoveryRuntimeGate } = await import('../../packages/storage/src/recovery-gate.js');
    createRecoveryRuntimeGate(f.db);
    const before = f.state(); io.roots = [f.dir, realpathSync(f.dir)]; io.calls = [];
    const actor = { accountId: 'owner', dataDomain: 'personal' };
    await expect(f.registry.detectSource(actor, { type: 'directory', target: f.dir })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    await expect(f.registry.enableSource(actor, { type: 'directory', target: f.dir })).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    await expect(f.registry.collectSource('legacy', 1)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    await expect(f.registry.wakeDirectory('legacy', 'note.md')).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    await expect(f.registry.collectSource('missing', 1)).rejects.toThrow('SOURCE_NOT_FOUND');
    expect(io.calls).toEqual([]); expect(f.state()).toEqual(before);
  } finally { f.close(); }
});

test('owner pause persists as an explicit state change while blocked reads add nothing', async () => {
  const f = await seededHistory();
  try {
    const paused = await f.registry.pauseSource('legacy');
    expect(paused).toMatchObject({ eventId: 'paused:legacy:2', accepted: true, kind: 'pause' });
    const before = f.state(); io.roots = [f.dir, realpathSync(f.dir)]; io.calls = [];
    await expect(f.registry.collectSource('legacy', 1)).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    await expect(f.registry.wakeDirectory('legacy', 'note.md')).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    expect(io.calls).toEqual([]); expect(f.state()).toEqual(before);
    expect(f.db.prepare("SELECT status,config_revision FROM source_configs WHERE source_id='legacy'").get()).toEqual({ status: 'paused', config_revision: 2 });
    expect(Buffer.from(await f.blobs.readBlob(f.hash)).toString()).toBe('saved historical note');
  } finally { f.close(); }
});

test('directory blocking remains in effect after restart while historical records remain readable', async () => {
  const f = await seededHistory();
  let reopened: ReturnType<typeof openDatabase> | undefined;
  try {
    const before = f.state(); f.db.close();
    reopened = openDatabase(join(f.root, 'state.sqlite'));
    const tables = ['source_configs', 'source_versions', 'source_cursors', 'source_objects', 'source_revisions', 'source_revision_provenance',
      'directory_commit_generations', 'collection_receipts', 'delete_sweeps', 'domain_events', 'outbox', 'blobs'];
    const registry = createSourceRegistry(reopened, { blobs: f.blobs });
    io.roots = [f.dir, realpathSync(f.dir)]; io.calls = [];
    await expect(registry.collectSource('legacy', 1)).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    await expect(registry.wakeDirectory('legacy', 'note.md')).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    expect(io.calls).toEqual([]);
    expect(tables.map((name) => reopened!.prepare(`SELECT * FROM ${name}`).all())).toEqual(before);
    expect(Buffer.from(await f.blobs.readBlob(f.hash)).toString()).toBe('saved historical note');
  } finally { if (reopened?.open) reopened.close(); f.close(); }
});

test('a signed synthetic recovery set restores and restarts with history intact and directory reads blocked', async () => {
  const f = await seededHistory();
  const hub = openDatabase(join(f.root, 'hub.sqlite'));
  let restored: ReturnType<typeof openDatabase> | undefined;
  let runtime: ReturnType<typeof openDatabase> | undefined;
  try {
    const { createHash, generateKeyPairSync, sign, verify } = await import('node:crypto');
    const { createRecoveryBackup } = await import('../../packages/host/src/recovery/backup.js');
    const { createRecoveryRestorer } = await import('../../packages/host/src/recovery/restore.js');
    const { recoveryWriteAllowed } = await import('../../packages/storage/src/recovery-gate.js');
    const { directoryReaderCapability } = await import('../../packages/integrations/sources/registry.js');
    const stamp = '2026-11-17T05:00:00.000Z';
    f.db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(stamp);
    const originalConfig = f.db.prepare("SELECT * FROM source_configs WHERE source_id='legacy'").get();
    const retained = ['source_cursors', 'source_objects', 'source_revisions', 'source_revision_provenance',
      'directory_commit_generations', 'delete_sweeps', 'collection_receipts', 'domain_events', 'outbox', 'blobs'];
    const history = retained.map((name) => f.db.prepare(`SELECT * FROM ${name}`).all());
    const originalVersions = f.db.prepare('SELECT * FROM source_versions').all();
    const keys = generateKeyPairSync('ed25519');
    const authority = {
      keyId: 'synthetic-recovery-key',
      sign: async (bytes: Uint8Array) => sign(null, bytes, keys.privateKey).toString('base64'),
      verify: async (bytes: Uint8Array, signature: string, keyId: string) =>
        keyId === 'synthetic-recovery-key' && verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64')),
    };
    const versionLocks = { application: 'synthetic-test' };
    const scope = {
      setId: 'directory-block', domains: [{ domain: 'personal', writerEpoch: 'previous-writer',
        withdrawal: { seq: 0, hash: createHash('sha256').update('').digest('hex') } }],
      resources: [{ kind: 'blob' as const, root: join(f.root, 'blobs'), domain: 'personal' }], versionLocks,
    };
    const freeze = { async acquire() { return {
      cutId: 'synthetic-cut', ingressFrozen: true, claimsFrozen: true, receiptsFrozen: true, effectsFrozen: true,
      executionTreesStopped: true, uncertainCallsJournaled: true, durableHandoff: true, async release() {},
    }; } };
    const recoveryRoot = join(f.root, 'sets');
    const set = await createRecoveryBackup({ root: recoveryRoot, databases: { service: f.db, hub }, authority, freeze,
      now: () => new Date(stamp) }).captureRecoverySet(scope);
    expect(set.manifest.completeness).toEqual({ recoverable: true, gaps: [] });
    const result = await createRecoveryRestorer({ recoveryRoot, isolationRoot: join(f.root, 'isolation'), authority, versionLocks,
      now: () => new Date(stamp) }).restoreRecoverySet(scope.setId, 'drill', set.manifestHash);
    expect(result.external_writes).toBe(0);
    expect(result.data_domains.personal.status).toBe('blocked');
    const restoredPath = join(result.directory, 'databases/service.sqlite');
    restored = openDatabase(restoredPath);
    restored.close();
    restored = openDatabase(restoredPath);
    expect(recoveryWriteAllowed(restored, 'personal')).toBe(false);
    const source = restored.prepare("SELECT * FROM source_configs WHERE source_id='legacy'").get() as {
      status: string; enabled: number; config_revision: number; physical_root: string;
    };
    expect(source).toMatchObject({ status: 'paused', enabled: 0, config_revision: 2 });
    expect(source.physical_root.startsWith(result.directory + '/')).toBe(true);
    const quarantined = restored.prepare("SELECT row_json FROM recovery_quarantined_records WHERE table_name='source_configs' AND record_id='legacy'")
      .get() as { row_json: string };
    expect(JSON.parse(quarantined.row_json)).toEqual(originalConfig);
    expect(restored.prepare('SELECT * FROM source_versions WHERE config_revision=1').all()).toEqual(originalVersions);
    expect(retained.map((name) => restored!.prepare(`SELECT * FROM ${name}`).all())).toEqual(history);
    expect(Buffer.from(await createBlobStore(join(result.directory, 'resources/0')).readBlob(f.hash)).toString()).toBe('saved historical note');
    expect(directoryReaderCapability).toEqual({ state: 'blocked', reason: 'DIRECTORY_READER_UNAVAILABLE' });
    const stateBefore = retained.map((name) => restored!.prepare(`SELECT * FROM ${name}`).all());
    io.roots = [f.dir, realpathSync(f.dir), source.physical_root]; io.calls = [];
    const registry = createSourceRegistry(restored, { blobs: createBlobStore(join(result.directory, 'resources/0')) });
    await expect(registry.collectSource('legacy', 2)).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    await expect(registry.wakeDirectory('legacy', 'note.md')).rejects.toThrow('RECOVERY_WRITE_BLOCKED');
    const { samplePath } = await import('../../packages/integrations/sources/directory.js');
    await expect(samplePath(join(f.dir, 'note.md'))).rejects.toThrow('DIRECTORY_READER_UNAVAILABLE');
    expect(io.calls).toEqual([]);
    expect(retained.map((name) => restored!.prepare(`SELECT * FROM ${name}`).all())).toEqual(stateBefore);

    // The real activation workflow is exercised with synthetic external authority ports.
    const { createRecoveryWitness } = await import('../../packages/host/src/recovery/witness.js');
    const { createRecoveryRuntimeGate } = await import('../../packages/storage/src/recovery-gate.js');
    const observed: string[] = [];
    let witnessRecord: import('../../packages/host/src/recovery/witness.js').RecoveryWitnessRecord = {
      domain: 'personal', revision: 'sealed-revision', writerEpoch: 'previous-writer', writerId: 'previous-writer-id',
      state: 'sealed', withdrawal: scope.domains[0]!.withdrawal,
      certificate: { id: 'synthetic-certificate', cutId: 'synthetic-cut', previousWriterId: 'previous-writer-id',
        fenceProof: 'synthetic-fence', withdrawalsReconciled: true },
      activationId: null, parentSealedRevision: null,
    };
    let candidateWaiting!: () => void; let competitorWaiting!: () => void;
    let releaseCandidate!: () => void; let winnerPublished!: () => void;
    const candidateAtCas = new Promise<void>((resolve) => { candidateWaiting = resolve; });
    const competitorAtCas = new Promise<void>((resolve) => { competitorWaiting = resolve; });
    const candidateMayCommit = new Promise<void>((resolve) => { releaseCandidate = resolve; });
    const winnerCommitted = new Promise<void>((resolve) => { winnerPublished = resolve; });
    const port = {
      independence: 'independent_authority' as const, consistency: 'linearizable' as const, authorityId: 'synthetic-only',
      async readAuthoritative() { return structuredClone(witnessRecord); },
      async compareAndSwap(domain: string, revision: string, next: Omit<typeof witnessRecord, 'revision'>) {
        if (next.writerId === 'candidate-writer') {
          observed.push('candidate-cas-waiting'); candidateWaiting(); await candidateMayCommit;
        } else if (next.writerId === 'competing-writer') {
          observed.push('competitor-cas-waiting'); competitorWaiting(); await winnerCommitted;
        }
        if (domain !== 'personal' || witnessRecord.revision !== revision) return false;
        observed.push('writer-cas');
        witnessRecord = { ...structuredClone(next), revision: `${revision}-winner` };
        if (next.writerId === 'candidate-writer') winnerPublished();
        return true;
      },
    };
    const verifySealedProof = async () => { observed.push('sealed-proof'); return true; };
    const witness = createRecoveryWitness({ port, writerId: 'candidate-writer', verifySealedProof });
    const competitor = createRecoveryWitness({ port, writerId: 'competing-writer', verifySealedProof });
    const activating = createRecoveryRestorer({
      recoveryRoot, isolationRoot: join(f.root, 'activated'), authority, versionLocks, witness,
      now: () => new Date(stamp),
      fence: { async verify(domain, record) {
        expect(domain).toBe('personal'); expect(record.writerId).toBe('previous-writer-id');
        observed.push('previous-writer-fenced');
        return { stopped: true, credentialsRevoked: true, proof: 'synthetic-fence' };
      } },
      withdrawalLog: { independence: 'independent_authority', async readComplete() { observed.push('withdrawals'); return []; } },
      replay: {
        externalAccess: 'read_only',
        async reconcileHub(context) { expect(context.externalAccess).toBe('read_only'); observed.push('hub'); return { confirmed: true }; },
        async recoverPendingIngest() { observed.push('ingest'); return { confirmed: true }; },
        async rebuildProjections() { observed.push('projections'); return { confirmed: true }; },
      },
      activation: { async enableDomain(input) {
        expect(witnessRecord).toMatchObject({ state: 'open', writerId: 'candidate-writer', activationId: input.activationId });
        expect(await witness.claimRecoveryWriter('personal', 'sealed-revision', input.activationId)).toBe('acquired');
        runtime = openDatabase(join(input.directory, 'databases/service.sqlite'));
        createRecoveryRuntimeGate(runtime).admit(input);
        expect(recoveryWriteAllowed(runtime, 'personal')).toBe(false); // Publication of the open gate is still pending.
        observed.push('runtime-admitted');
        return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true };
      } },
    }).restoreRecoverySet(scope.setId, 'activate', set.manifestHash);
    await Promise.race([candidateAtCas, activating.then(() => { throw new Error('candidate did not reach CAS'); })]);
    const competing = competitor.claimRecoveryWriter('personal', 'sealed-revision', 'competing-activation');
    await Promise.race([competitorAtCas, competing.then(() => { throw new Error('competitor did not reach CAS'); })]);
    releaseCandidate();
    const [activated, competingResult] = await Promise.all([activating, competing]);
    expect(competingResult).toBe('lost');
    expect(activated.external_writes).toBe(0);
    expect(activated.orderlyHandoff).toBe(true);
    expect(activated.data_domains.personal.status).toBe('open');
    expect(witnessRecord).toMatchObject({ state: 'open', writerId: 'candidate-writer', parentSealedRevision: 'sealed-revision' });
    expect(witnessRecord.writerEpoch).not.toBe('previous-writer');
    expect(observed).toEqual(expect.arrayContaining(['sealed-proof', 'previous-writer-fenced', 'withdrawals', 'hub', 'ingest',
      'projections', 'candidate-cas-waiting', 'competitor-cas-waiting', 'writer-cas', 'runtime-admitted']));
    const order = ['previous-writer-fenced', 'withdrawals', 'hub', 'ingest', 'projections', 'candidate-cas-waiting',
      'competitor-cas-waiting', 'writer-cas', 'runtime-admitted'];
    expect(observed.filter((item) => order.includes(item))).toEqual(order);
    const live = runtime as unknown as ReturnType<typeof openDatabase>;
    expect(recoveryWriteAllowed(live, 'personal')).toBe(true);
    const activatedSource = live.prepare("SELECT * FROM source_configs WHERE source_id='legacy'").get() as { physical_root: string };
    expect(activatedSource).toMatchObject({ status: 'paused', enabled: 0, config_revision: 2 });
    const activatedBefore = [live.prepare('SELECT * FROM source_configs').all(), live.prepare('SELECT * FROM source_versions').all(),
      ...retained.map((name) => live.prepare(`SELECT * FROM ${name}`).all())];
    expect(retained.map((name) => live.prepare(`SELECT * FROM ${name}`).all())).toEqual(history);
    expect(Buffer.from(await createBlobStore(join(activated.directory, 'resources/0')).readBlob(f.hash)).toString()).toBe('saved historical note');
    io.roots = [f.dir, realpathSync(f.dir), activatedSource.physical_root]; io.calls = [];
    const admittedRegistry = createSourceRegistry(live, { blobs: createBlobStore(join(activated.directory, 'resources/0')) });
    const blocked = { name: 'DirectoryReaderUnavailableError', code: 'DIRECTORY_READER_UNAVAILABLE' };
    await expect(admittedRegistry.detectSource({ accountId: 'owner', dataDomain: 'personal' },
      { type: 'directory', target: activatedSource.physical_root })).rejects.toMatchObject(blocked);
    await expect(admittedRegistry.collectSource('legacy', 2)).rejects.toMatchObject(blocked);
    await expect(admittedRegistry.wakeDirectory('legacy', 'note.md')).rejects.toMatchObject(blocked);
    expect(io.calls).toEqual([]);
    expect([live.prepare('SELECT * FROM source_configs').all(), live.prepare('SELECT * FROM source_versions').all(),
      ...retained.map((name) => live.prepare(`SELECT * FROM ${name}`).all())]).toEqual(activatedBefore);
  } finally { if (runtime?.open) runtime.close(); if (restored?.open) restored.close(); hub.close(); f.close(); }
});
