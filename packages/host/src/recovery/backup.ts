import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { assertName, assertRelative, canonical, containedPath, digest, durableJson, durableWrite, fileHash, publishDirectory, walkFiles } from './files.js';
import { verifyWithdrawalChain } from './witness.js';
import { assertVaultRoot, captureVaults, readVaultFile, verifyVaultRegistrations, withVaultRoot } from './vaults.js';
import type {
  RecoveryArtifact, RecoveryDatabaseReader, RecoveryDatabases, RecoveryDatabaseState, RecoveryFreezeLease,
  RecoveryFreezePort, RecoveryManifest, RecoveryManifestAuthority, RecoveryOffHostPort, RecoveryScope, RecoverySet, WithdrawalEntry,
} from './types.js';

export type RecoveryBackupOptions = {
  root: string; databases: RecoveryDatabases; authority: RecoveryManifestAuthority;
  freeze?: RecoveryFreezePort; readDatabase?: RecoveryDatabaseReader; offHost?: RecoveryOffHostPort; now?: () => Date;
};

export function readRecoveryDatabase(db: SqliteDatabase): RecoveryDatabaseState {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hub_snapshots'").get();
  if (!table) throw new Error('RECOVERY_HUB_READER_REQUIRED');
  const hub = db.prepare('SELECT COALESCE(MAX(hub_seq),0) AS seq FROM hub_snapshots').get() as { seq: number };
  const domain = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM domain_events').get() as { seq: number };
  const history = db.prepare('SELECT file,sha256 FROM schema_migrations ORDER BY position').all() as RecoveryDatabaseState['schemaHistory'];
  return { hubSeq: hub.seq, domainSeq: domain.seq, schemaHistory: history };
}

function assertCut(lease: RecoveryFreezeLease): void {
  if (!lease.cutId || !lease.ingressFrozen || !lease.claimsFrozen || !lease.receiptsFrozen || !lease.effectsFrozen
    || !lease.executionTreesStopped || !lease.uncertainCallsJournaled || !lease.durableHandoff) {
    throw new Error('RECOVERY_FREEZE_INCOMPLETE');
  }
}

function inspectPair(databases: RecoveryDatabases, read: RecoveryDatabaseReader): RecoveryManifest['databases'] {
  const service = read(databases.service, 'service');
  const hub = read(databases.hub, 'hub');
  if (service.hubSeq !== hub.hubSeq) throw new Error('RECOVERY_DATABASE_CUT_MISMATCH');
  return { service, hub };
}

function markUncertain(db: SqliteDatabase, now: string): void {
  withImmediateTransaction(db, () => {
    db.prepare("UPDATE effect_receipts SET status='uncertain',reason='recovery_cut_unconfirmed',updated_at=? WHERE status='pending'").run(now);
    db.prepare("UPDATE answer_intents SET send_status='uncertain',updated_at=? WHERE send_status='stored'").run(now);
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_intents'").get()) {
      db.prepare("UPDATE notification_intents SET status='uncertain',lease_until=NULL,updated_at=? WHERE status='sending'").run(now);
    }
    db.prepare("UPDATE channel_tests SET status='unknown',reason_code='recovery_cut_unconfirmed',updated_at=? WHERE status='sending'").run(now);
  });
}

export function createRecoveryBackup(options: RecoveryBackupOptions) {
  const now = options.now ?? (() => new Date());
  const readDatabase = options.readDatabase ?? readRecoveryDatabase;
  return {
    async captureRecoverySet(requestedScope: RecoveryScope): Promise<RecoverySet> {
      const scope = structuredClone(requestedScope);
      assertName(scope.setId);
      if (!scope.domains.length || new Set(scope.domains.map((domain) => domain.domain)).size !== scope.domains.length
        || !Object.keys(scope.versionLocks).length) throw new Error('RECOVERY_SCOPE_INVALID');
      for (const domain of scope.domains) assertName(domain.domain);
      if (!options.freeze) throw new Error('RECOVERY_FREEZE_REQUIRED');
      await mkdir(options.root, { recursive: true, mode: 0o700 });
      const directory = await containedPath(options.root, scope.setId);
      try { await stat(directory); throw new Error('RECOVERY_SET_EXISTS'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const partial = await containedPath(options.root, `.pending-${scope.setId}-${randomUUID()}`);
      await mkdir(join(partial, 'databases'), { recursive: true, mode: 0o700 });
      const lease = await options.freeze.acquire(scope.domains.map((domain) => domain.domain));
      let set: RecoverySet;
      try {
        assertCut(lease);
        assertDatabaseDomains(options.databases.service, scope.domains.map((domain) => domain.domain));
        assertDatabaseDomains(options.databases.hub, scope.domains.map((domain) => domain.domain));
        markUncertain(options.databases.service, now().toISOString());
        const before = inspectPair(options.databases, readDatabase);
        const vaultInventory = captureVaults(options.databases.service, scope);
        const assertVaultRoots = () => { for (const binding of vaultInventory.roots.values()) assertVaultRoot(binding); };
        await options.databases.service.backup(join(partial, 'databases/service.sqlite'));
        assertVaultRoots();
        await options.databases.hub.backup(join(partial, 'databases/hub.sqlite'));
        assertVaultRoots();
        const after = inspectPair(options.databases, readDatabase);
        if (canonical(before) !== canonical(after)) throw new Error('RECOVERY_DATABASE_CHANGED_DURING_CAPTURE');
        const artifacts: RecoveryArtifact[] = [];
        for (const role of ['service', 'hub'] as const) {
          const path = `databases/${role}.sqlite`;
          const db = new Database(join(partial, path), { readonly: true });
          try {
            assertDatabaseIntegrity(db);
            if (canonical(readDatabase(db, role)) !== canonical(before[role])) throw new Error('RECOVERY_DATABASE_CUT_MISMATCH');
          } finally { db.close(); }
          artifacts.push({ path, ...await fileHash(join(partial, path)), kind: 'database', domain: null });
        }
        for (const [index, resource] of scope.resources.entries()) {
          if (resource.domain && !scope.domains.some((domain) => domain.domain === resource.domain)) throw new Error('RECOVERY_RESOURCE_DOMAIN_MISMATCH');
          const binding = vaultInventory.roots.get(`resources/${index}`);
          if (resource.kind === 'vault' && !binding) continue;
          const checked = <T>(operation: () => Promise<T>) => binding ? withVaultRoot(binding, operation) : operation();
          for (const relative of await checked(() => walkFiles(resource.root))) {
            const source = await checked(() => containedPath(resource.root, relative));
            const path = `resources/${index}/${relative}`;
            const bytes = binding ? await readVaultFile(binding, relative) : await readFile(source);
            await checked(() => durableWrite(join(partial, path), bytes));
            const sourceHash = binding ? digest(await readVaultFile(binding, relative)) : (await fileHash(source)).hash;
            if (sourceHash !== digest(bytes)) throw new Error('RECOVERY_RESOURCE_CHANGED_DURING_CAPTURE');
            artifacts.push({ path, hash: digest(bytes), bytes: bytes.length, kind: resource.kind, domain: resource.domain ?? null });
          }
          assertVaultRoots();
        }
        const gaps = [...vaultInventory.gaps, ...await inventoryGaps(options.databases.service, scope, artifacts)];
        assertVaultRoots();
        const manifest: RecoveryManifest = {
          schemaVersion: '1.0', setId: scope.setId, createdAt: now().toISOString(), cutId: lease.cutId,
          domains: structuredClone(scope.domains), versionLocks: { ...scope.versionLocks }, databases: before,
          artifacts, vaults: vaultInventory.vaults, completeness: { recoverable: gaps.length === 0, gaps },
          protection: { status: 'local_only', targetId: null, snapshotId: null, recoveryCredentialRef: null, verifiedAt: null },
        };
        assertVaultRoots();
        const bytes = Buffer.from(canonical(manifest));
        const signature = await options.authority.sign(bytes);
        assertVaultRoots();
        if (!await options.authority.verify(bytes, signature, options.authority.keyId)) throw new Error('RECOVERY_SIGNATURE_INVALID');
        assertVaultRoots();
        await durableJson(join(partial, 'manifest.json'), { manifest, signature, keyId: options.authority.keyId });
        assertVaultRoots();
        await verifyRecoverySet(partial, options.authority, scope.versionLocks, readDatabase);
        assertVaultRoots();
        await publishDirectory(partial, directory);
        assertVaultRoots();
        set = retainSetEvidence({ directory, manifest, manifestHash: digest(bytes) }, canonical({ manifest, signature, keyId: options.authority.keyId }));
      } finally {
        await lease.release();
      }
      if (options.offHost) {
        const protectedReceipt = await options.offHost.protect(set);
        if (!protectedReceipt.encrypted || !protectedReceipt.offHost || !protectedReceipt.verified
          || protectedReceipt.manifestHash !== set.manifestHash || !protectedReceipt.targetId || !protectedReceipt.snapshotId
          || !protectedReceipt.recoveryCredentialRef || canonical([...protectedReceipt.domains].sort()) !== canonical(scope.domains.map((domain) => domain.domain).sort())) {
          throw new Error('RECOVERY_OFF_HOST_UNCONFIRMED');
        }
        await durableJson(join(directory, 'off-host-receipt.json'), protectedReceipt);
      }
      return set;
    },
  };
}

async function inventoryGaps(db: SqliteDatabase, scope: RecoveryScope, artifacts: RecoveryArtifact[]): Promise<string[]> {
  const gaps: string[] = [];
  const blobs = db.prepare('SELECT sha256 FROM blobs').all() as Array<{ sha256: string }>;
  for (const blob of blobs) {
    if (!artifacts.some((artifact) => artifact.kind === 'blob' && artifact.hash === blob.sha256)) gaps.push(`blob_missing:${blob.sha256}`);
  }
  const journalExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_withdrawal_log'").get();
  for (const domain of scope.domains) {
    let complete = false;
    if (journalExists) {
      try {
        const rows = db.prepare(`SELECT sequence,writer_epoch,previous_hash,entry_hash,event_json,protection
          FROM recovery_withdrawal_log WHERE data_domain=? ORDER BY sequence`).all(domain.domain) as Array<{
          sequence: number; writer_epoch: string; previous_hash: string; entry_hash: string; event_json: string; protection: string;
        }>;
        const entries: WithdrawalEntry[] = rows.map((row) => ({
          domain: domain.domain, seq: row.sequence, writerEpoch: row.writer_epoch,
          previousHash: row.previous_hash, hash: row.entry_hash, event: JSON.parse(row.event_json) as WithdrawalEntry['event'],
        }));
        const events = db.prepare('SELECT * FROM withdrawal_events WHERE data_domain=?').all(domain.domain) as Array<Record<string, unknown>>;
        complete = verifyWithdrawalChain(domain.domain, entries, domain.withdrawal) && entries.length === events.length
          && events.every((event) => entries.some((entry) => entry.event.eventId === event.event_id
            && entry.event.epoch === event.epoch && entry.event.targetKind === event.target_kind && entry.event.targetId === event.target_id
            && entry.event.targetVersion === event.target_version && entry.event.reason === event.reason && entry.event.createdAt === event.created_at));
        if (rows.some((row) => row.protection !== 'protected')) gaps.push(`withdrawal_protection_pending:${domain.domain}`);
      } catch { complete = false; }
    }
    if (!complete) gaps.push(`withdrawal_chain_incomplete:${domain.domain}`);
  }
  return gaps;
}

function assertDatabaseDomains(db: SqliteDatabase, domains: string[]): void {
  const allowed = new Set(domains);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  for (const table of tables) {
    const identifier = `"${table.name.replaceAll('"', '""')}"`;
    const columns = db.prepare(`PRAGMA table_info(${identifier})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'data_domain')) continue;
    const rows = db.prepare(`SELECT DISTINCT data_domain FROM ${identifier} WHERE data_domain IS NOT NULL`).all() as Array<{ data_domain: string }>;
    if (rows.some((row) => !allowed.has(row.data_domain))) throw new Error('RECOVERY_DATABASE_DOMAIN_SCOPE_MISMATCH');
  }
}

export async function verifyRecoverySet(
  directory: string, authority: RecoveryManifestAuthority, versionLocks: Record<string, string>,
  readDatabase: RecoveryDatabaseReader = readRecoveryDatabase,
): Promise<RecoverySet> {
  const manifestPath = await containedPath(directory, 'manifest.json');
  const envelopeBytes = await readFile(manifestPath, 'utf8');
  const envelope: unknown = JSON.parse(envelopeBytes);
  if (!envelope || typeof envelope !== 'object' || !('manifest' in envelope) || !('signature' in envelope)
    || !('keyId' in envelope) || typeof envelope.signature !== 'string' || typeof envelope.keyId !== 'string') throw new Error('RECOVERY_MANIFEST_INVALID');
  exactKeys(envelope, ['manifest', 'signature', 'keyId']);
  assertManifest(envelope.manifest);
  const manifest = envelope.manifest;
  const bytes = Buffer.from(canonical(manifest));
  if (!await authority.verify(bytes, envelope.signature, envelope.keyId)) throw new Error('RECOVERY_SIGNATURE_INVALID');
  if (canonical(manifest.versionLocks) !== canonical(versionLocks)) throw new Error('RECOVERY_VERSION_MISMATCH');
  for (const artifact of manifest.artifacts) {
    const actual = await fileHash(await containedPath(directory, artifact.path));
    if (actual.hash !== artifact.hash || actual.bytes !== artifact.bytes) throw new Error('RECOVERY_ARTIFACT_HASH_MISMATCH');
  }
  for (const role of ['service', 'hub'] as const) {
    const db = new Database(await containedPath(directory, `databases/${role}.sqlite`), { readonly: true });
    try {
      assertDatabaseIntegrity(db);
      if (canonical(readDatabase(db, role)) !== canonical(manifest.databases[role])) throw new Error('RECOVERY_DATABASE_CUT_MISMATCH');
      if (role === 'service') verifyVaultRegistrations(db, manifest.vaults);
    } finally { db.close(); }
  }
  if (manifest.databases.service.hubSeq !== manifest.databases.hub.hubSeq) throw new Error('RECOVERY_DATABASE_CUT_MISMATCH');
  return retainSetEvidence({ directory, manifest, manifestHash: digest(bytes) }, envelopeBytes);
}

const setEvidence = new WeakMap<RecoverySet, Readonly<{ directory: string; envelope: string; manifestHash: string; inventory: string }>>();

function retainSetEvidence(set: RecoverySet, envelope: string): RecoverySet {
  setEvidence.set(set, Object.freeze({ directory: set.directory, envelope, manifestHash: set.manifestHash, inventory: canonical(set.manifest) }));
  return set;
}

export function recoverySetEvidence(set: RecoverySet) {
  const evidence = setEvidence.get(set);
  if (!evidence || evidence.directory !== set.directory || evidence.manifestHash !== set.manifestHash
    || evidence.inventory !== canonical(set.manifest)) throw new Error('RECOVERY_SET_EVIDENCE_MISMATCH');
  return evidence;
}

export function assertDatabaseIntegrity(db: SqliteDatabase): void {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('RECOVERY_DATABASE_INTEGRITY_FAILED');
}

function assertManifest(value: unknown): asserts value is RecoveryManifest {
  if (!value || typeof value !== 'object') throw new Error('RECOVERY_MANIFEST_INVALID');
  const manifest = value as RecoveryManifest;
  if (manifest.schemaVersion !== '1.0' || !manifest.setId || !manifest.cutId || !Number.isFinite(Date.parse(manifest.createdAt))
    || !manifest.versionLocks || typeof manifest.versionLocks !== 'object' || !Object.keys(manifest.versionLocks).length
    || !manifest.databases?.service || !manifest.databases?.hub || !Array.isArray(manifest.domains) || !manifest.domains.length
    || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.vaults) || !manifest.completeness || typeof manifest.completeness.recoverable !== 'boolean'
    || !Array.isArray(manifest.completeness.gaps) || !['local_only', 'off_host_verified'].includes(manifest.protection?.status)) throw new Error('RECOVERY_MANIFEST_INVALID');
  assertName(manifest.setId);
  exactKeys(manifest, ['schemaVersion', 'setId', 'createdAt', 'cutId', 'domains', 'versionLocks', 'databases', 'artifacts', 'vaults', 'completeness', 'protection']);
  exactKeys(manifest.databases, ['service', 'hub']);
  exactKeys(manifest.completeness, ['recoverable', 'gaps']);
  exactKeys(manifest.protection, ['status', 'targetId', 'snapshotId', 'recoveryCredentialRef', 'verifiedAt']);
  if (manifest.completeness.gaps.some((gap) => typeof gap !== 'string' || !gap)
    || (manifest.completeness.recoverable && manifest.completeness.gaps.length)
    || Object.values(manifest.versionLocks).some((version) => typeof version !== 'string' || !version)
    || new Set(manifest.domains.map((domain) => domain.domain)).size !== manifest.domains.length) throw new Error('RECOVERY_MANIFEST_INVALID');
  for (const role of ['service', 'hub'] as const) {
    const state = manifest.databases[role];
    exactKeys(state, ['hubSeq', 'domainSeq', 'schemaHistory']);
    if (!Number.isSafeInteger(state.hubSeq) || state.hubSeq < 0 || !Number.isSafeInteger(state.domainSeq) || state.domainSeq < 0
      || !Array.isArray(state.schemaHistory)) throw new Error('RECOVERY_MANIFEST_INVALID');
    const files = new Set<string>();
    for (const migration of state.schemaHistory) {
      exactKeys(migration, ['file', 'sha256']);
      if (!/^[a-zA-Z0-9_-]+\.sql$/.test(migration.file) || !/^[a-f0-9]{64}$/.test(migration.sha256) || files.has(migration.file)) throw new Error('RECOVERY_MANIFEST_INVALID');
      files.add(migration.file);
    }
  }
  if (manifest.protection.status === 'local_only') {
    if (manifest.protection.targetId !== null || manifest.protection.snapshotId !== null || manifest.protection.recoveryCredentialRef !== null
      || manifest.protection.verifiedAt !== null) throw new Error('RECOVERY_MANIFEST_INVALID');
  } else if (!manifest.protection.targetId || !manifest.protection.snapshotId || !manifest.protection.recoveryCredentialRef
    || !manifest.protection.verifiedAt || !Number.isFinite(Date.parse(manifest.protection.verifiedAt))) throw new Error('RECOVERY_MANIFEST_INVALID');
  const paths = new Set<string>();
  for (const artifact of manifest.artifacts) {
    exactKeys(artifact, ['path', 'hash', 'bytes', 'kind', 'domain']);
    assertRelative(artifact.path);
    if (paths.has(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.hash) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
      || !['database', 'vault', 'blob', 'handoff', 'vault_kit', 'version_lock'].includes(artifact.kind)) throw new Error('RECOVERY_MANIFEST_INVALID');
    if (artifact.domain !== null && !manifest.domains.some((domain) => domain.domain === artifact.domain)) throw new Error('RECOVERY_MANIFEST_INVALID');
    if ((artifact.kind === 'vault' && artifact.domain === null)
      || (artifact.kind === 'database' && !['databases/service.sqlite', 'databases/hub.sqlite'].includes(artifact.path))
      || (artifact.kind !== 'database' && !/^resources\/[0-9]+\/.+/.test(artifact.path))) throw new Error('RECOVERY_MANIFEST_INVALID');
    paths.add(artifact.path);
  }
  if (!paths.has('databases/service.sqlite') || !paths.has('databases/hub.sqlite')) throw new Error('RECOVERY_MANIFEST_INVALID');
  const vaultIds = new Set<string>();
  const prefixes = new Set<string>();
  for (const vault of manifest.vaults) {
    exactKeys(vault, ['vaultId', 'accountId', 'sourceId', 'domain', 'physicalRoot', 'canonicalRoot', 'rootIdentity', 'scopeHash', 'resourcePrefix']);
    if (!vault.vaultId || !vault.accountId || !vault.sourceId || !vault.physicalRoot || !vault.rootIdentity
      || !/^[a-f0-9]{64}$/.test(vault.scopeHash) || vaultIds.has(vault.vaultId)
      || !manifest.domains.some((domain) => domain.domain === vault.domain)) throw new Error('RECOVERY_MANIFEST_INVALID');
    vaultIds.add(vault.vaultId);
    if (vault.resourcePrefix !== null) {
      if (!/^resources\/[0-9]+$/.test(vault.resourcePrefix) || !vault.canonicalRoot || prefixes.has(vault.resourcePrefix)) throw new Error('RECOVERY_MANIFEST_INVALID');
      prefixes.add(vault.resourcePrefix);
    } else if (manifest.completeness.recoverable) throw new Error('RECOVERY_MANIFEST_INVALID');
  }
  for (const artifact of manifest.artifacts.filter((entry) => entry.kind === 'vault')) {
    const vault = manifest.vaults.find((entry) => entry.resourcePrefix === artifact.path.split('/').slice(0, 2).join('/'));
    if ((!vault || vault.domain !== artifact.domain) && manifest.completeness.recoverable) throw new Error('RECOVERY_MANIFEST_INVALID');
  }
  for (const domain of manifest.domains) {
    exactKeys(domain, ['domain', 'writerEpoch', 'withdrawal']);
    exactKeys(domain.withdrawal, ['seq', 'hash']);
    assertName(domain.domain);
    if (!domain.writerEpoch || !Number.isSafeInteger(domain.withdrawal.seq) || domain.withdrawal.seq < 0
      || !/^[a-f0-9]{64}$/.test(domain.withdrawal.hash)) throw new Error('RECOVERY_MANIFEST_INVALID');
  }
}

function exactKeys(value: object, expected: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonical(Object.keys(value).sort()) !== canonical(expected.sort())) throw new Error('RECOVERY_MANIFEST_INVALID');
}
