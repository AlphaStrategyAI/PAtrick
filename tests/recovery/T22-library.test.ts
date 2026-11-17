import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { test, expect, vi, afterEach } from 'vitest';
import { openDatabase, createRecoveryRuntimeGate, recoveryWriteAllowed } from '@patrick/storage';
import { createRecoveryBackup } from '../../packages/host/src/recovery/backup.js';
import { createRecoveryRestorer, reconcileRecoveredDomain } from '../../packages/host/src/recovery/restore.js';
import { createRecoveryWitness, withdrawalEntryHash, type RecoveryWitnessRecord } from '../../packages/host/src/recovery/witness.js';
import { createRecoveryWithdrawalJournal } from '../../packages/host/src/recovery/withdrawals.js';
import { createResticRecoveryBackup } from '../../packages/host/src/recovery/restic.js';
import { createOwnerRecoveryImporter } from '../../packages/host/src/recovery/owner-import.js';
import { digest } from '../../packages/host/src/recovery/files.js';
import type { RecoveryScope, WithdrawalEntry } from '../../packages/host/src/recovery/types.js';

const filesystemBoundary = vi.hoisted(() => ({
  beforeRead: undefined as ((path: string) => void) | undefined,
  afterRead: undefined as ((path: string) => void) | undefined,
  beforeOpen: undefined as ((path: string) => void) | undefined,
  afterOpen: undefined as ((path: string) => void) | undefined,
  afterScan: undefined as ((path: string) => void) | undefined,
  afterSync: undefined as ((path: string) => void) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...filesystem,
    async readFile(...args: Parameters<typeof filesystem.readFile>) {
      filesystemBoundary.beforeRead?.(String(args[0]));
      const result = await filesystem.readFile(...args);
      filesystemBoundary.afterRead?.(String(args[0]));
      return result;
    },
    async readdir(...args: Parameters<typeof filesystem.readdir>) {
      const result = await filesystem.readdir(...args);
      filesystemBoundary.afterScan?.(String(args[0]));
      return result;
    },
    async open(...args: Parameters<typeof filesystem.open>) {
      filesystemBoundary.beforeOpen?.(String(args[0]));
      const handle = await filesystem.open(...args);
      filesystemBoundary.afterOpen?.(String(args[0]));
      const readFile = handle.readFile.bind(handle);
      vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs) => {
        filesystemBoundary.beforeRead?.(String(args[0]));
        const result = await readFile(...readArgs);
        filesystemBoundary.afterRead?.(String(args[0]));
        return result;
      });
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        filesystemBoundary.afterSync?.(String(args[0]));
      };
      return handle;
    },
  };
});
afterEach(() => {
  filesystemBoundary.beforeRead = undefined;
  filesystemBoundary.afterRead = undefined;
  filesystemBoundary.beforeOpen = undefined;
  filesystemBoundary.afterOpen = undefined;
  filesystemBoundary.afterScan = undefined;
  filesystemBoundary.afterSync = undefined;
  vi.restoreAllMocks();
});

const stamp = '2026-11-17T06:00:00.000Z';
const versionLocks = { application: 'review-fixture' };
const keys = generateKeyPairSync('ed25519');
const authority = {
  keyId: 'review-fixture',
  sign: async (bytes: Uint8Array) => sign(null, bytes, keys.privateKey).toString('base64'),
  verify: async (bytes: Uint8Array, signature: string, keyId: string) =>
    keyId === 'review-fixture' && verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64')),
};
function entry(sequence: number, previousHash: string, id: string, writerEpoch = 'old-epoch'): WithdrawalEntry {
  const payload = {
    domain: 'personal', seq: sequence, writerEpoch, previousHash,
    event: { eventId: id, targetKind: 'knowledge', targetId: id, targetVersion: 1, epoch: sequence, reason: 'withdraw', createdAt: stamp },
  };
  return { ...payload, hash: withdrawalEntryHash(payload) };
}
function addEvent(database: ReturnType<typeof openDatabase>, value: WithdrawalEntry) {
  const event = value.event;
  database.prepare('INSERT INTO withdrawal_events VALUES (?,?,?,?,?,?,?,?)').run(
    event.eventId, value.domain, event.targetKind, event.targetId, event.targetVersion, event.epoch, event.reason, event.createdAt,
  );
}
function fixture() {
  const root = mkdtempSync('/private/tmp/patrick-T22-library-');
  const service = openDatabase(join(root, 'service.sqlite'));
  const hub = openDatabase(join(root, 'hub.sqlite'));
  for (const database of [service, hub]) database.prepare("INSERT INTO hub_snapshots VALUES ('hub',9,'{}',?)").run(stamp);
  service.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(stamp);
  const initial = entry(1, digest(''), 'initial');
  addEvent(service, initial);
  service.prepare('INSERT INTO recovery_withdrawal_log VALUES (?,?,?,?,?,?,?)').run(
    initial.domain, initial.seq, initial.writerEpoch, initial.previousHash, initial.hash, JSON.stringify(initial.event), 'protected',
  );
  service.prepare('DELETE FROM recovery_withdrawal_pending').run();
  service.prepare("UPDATE recovery_domain_gates SET writer_epoch='old-epoch',status='blocked'").run();
  const head = { seq: 1, hash: initial.hash };
  const freeze = {
    async acquire() {
      return { cutId: 'review-cut', ingressFrozen: true, claimsFrozen: true, receiptsFrozen: true,
        effectsFrozen: true, executionTreesStopped: true, uncertainCallsJournaled: true, durableHandoff: true,
        async release() {} };
    },
  };
  const scope: RecoveryScope = { setId: 'set-review', domains: [{ domain: 'personal', writerEpoch: 'old-epoch', withdrawal: head }],
    resources: [], versionLocks };
  return { root, service, hub, initial, head, freeze, scope, close() {
    service.close(); hub.close(); rmSync(root, { recursive: true, force: true });
  } };
}
function witnessFixture(head: { seq: number; hash: string }) {
  let record: RecoveryWitnessRecord = {
    domain: 'personal', revision: 'sealed-revision', writerEpoch: 'old-epoch', writerId: 'old-writer',
    state: 'sealed', withdrawal: { ...head },
    certificate: { id: 'review-certificate', cutId: 'review-cut', previousWriterId: 'old-writer', fenceProof: 'review-fence', withdrawalsReconciled: true },
    activationId: null, parentSealedRevision: null,
  };
  const port = {
    independence: 'independent_authority' as const, consistency: 'linearizable' as const, authorityId: 'review-fixture-only',
    async readAuthoritative() { return structuredClone(record); },
    async compareAndSwap(_domain: string, revision: string, next: Omit<RecoveryWitnessRecord, 'revision'>) {
      if (record.revision !== revision) return false;
      record = { ...structuredClone(next), revision: `${revision}-next` };
      return true;
    },
  };
  const witness = createRecoveryWitness({ port, writerId: 'new-writer', verifySealedProof: async () => true });
  return { witness, port, read: () => record };
}
function restoreOptions(local: ReturnType<typeof fixture>, remote: ReturnType<typeof witnessFixture>) {
  return {
    recoveryRoot: join(local.root, 'sets'), isolationRoot: join(local.root, 'isolated'), authority, versionLocks,
    witness: remote.witness,
    fence: { async verify() { return { stopped: true, credentialsRevoked: true, proof: 'review-fence' }; } },
    withdrawalLog: { independence: 'independent_authority' as const, async readComplete() { return [local.initial]; } },
    replay: {
      externalAccess: 'read_only' as const,
      async reconcileHub() { return { confirmed: true }; },
      async recoverPendingIngest() { return { confirmed: true }; },
      async rebuildProjections() { return { confirmed: true }; },
    },
  };
}
async function capture(local: ReturnType<typeof fixture>) {
  return createRecoveryBackup({ root: join(local.root, 'sets'), databases: local, authority, freeze: local.freeze })
    .captureRecoverySet(local.scope);
}
function registerVault(local: ReturnType<typeof fixture>, name: string) {
  const root = join(local.root, name);
  mkdirSync(root);
  writeFileSync(join(root, 'draft.md'), name);
  local.service.prepare('INSERT INTO accounts VALUES (?,1,1,?)').run(name, stamp);
  local.service.prepare(`INSERT INTO source_configs VALUES (
    ?,?,'personal','directory',?,?,'{}','[]',NULL,'daily','none',0,1,'enabled',1,'1.0',?,?)`).run(
    `${name}-source`, name, root, root, stamp, stamp,
  );
  local.service.prepare(`INSERT INTO vaults VALUES (
    ?,?,?,'personal','fixture-host',?,?,?, ?,?,1,1,'connected','1.0',?,?)`).run(
    name, `${name}-source`, name, root, local.root, `${statSync(root).dev}:${statSync(root).ino}`, root, digest(root), stamp, stamp,
  );
  return root;
}
function uncertainNotification(database: ReturnType<typeof openDatabase>, id: string) {
  database.prepare(`INSERT INTO notification_intents (
    intent_id,account_id,data_domain,object_id,event_version,kind,channel,auth_epoch,binding_hash,expires_at,
    status,attempts,next_at,lease_until,evidence_hash,updated_at
  ) VALUES (?,'owner','personal','work',1,'progress','feishu',1,?,'2027-01-01','uncertain',1,NULL,NULL,NULL,?)`).run(id, digest('binding'), stamp);
}

function replaceVaultRoot(root: string, text = 'unrelated-replacement') {
  renameSync(root, `${root}-surviving-original`);
  mkdirSync(root);
  writeFileSync(join(root, 'draft.md'), text);
}

test.each(['unchanged', 'before_admission', 'database_backup', 'directory_scan', 'source_read', 'destination_sync', 'manifest_sign'] as const)(
  'R1: capture binds physical Vault identity across %s', async (boundary) => {
    const local = fixture();
    try {
      const root = registerVault(local, 'physical-vault');
      local.scope.resources.push({ kind: 'vault', domain: 'personal', root, vaultId: 'physical-vault' });
      if (boundary === 'before_admission') replaceVaultRoot(root);
      if (boundary === 'database_backup') {
        const backup = local.service.backup.bind(local.service);
        vi.spyOn(local.service, 'backup').mockImplementationOnce(async (...args) => {
          const result = await backup(...args);
          replaceVaultRoot(root);
          return result;
        });
      }
      if (boundary === 'directory_scan') filesystemBoundary.afterScan = (path) => {
        if (path === root) { filesystemBoundary.afterScan = undefined; replaceVaultRoot(root); }
      };
      if (boundary === 'source_read') filesystemBoundary.afterRead = (path) => {
        if (path === join(root, 'draft.md')) { filesystemBoundary.afterRead = undefined; replaceVaultRoot(root, 'physical-vault'); }
      };
      if (boundary === 'destination_sync') filesystemBoundary.afterSync = (path) => {
        if (path.endsWith('/resources/0/draft.md')) { filesystemBoundary.afterSync = undefined; replaceVaultRoot(root, 'physical-vault'); }
      };
      const signer = { ...authority, async sign(bytes: Uint8Array) {
        const signature = await authority.sign(bytes);
        if (boundary === 'manifest_sign') replaceVaultRoot(root);
        return signature;
      } };
      const outcome = await createRecoveryBackup({
        root: join(local.root, 'sets'), databases: local, authority: signer, freeze: local.freeze,
      }).captureRecoverySet(local.scope).then(
        (set) => ({ recoverable: set.manifest.completeness.recoverable }),
        (error: Error) => ({ recoverable: false, error: error.message }),
      );
      expect(outcome.recoverable).toBe(boundary === 'unchanged');
      expect(readFileSync(join(boundary === 'unchanged' ? root : `${root}-surviving-original`, 'draft.md'), 'utf8')).toBe('physical-vault');
    } finally { local.close(); }
  },
);

test.each(['unchanged', 'before_admission', 'directory_scan', 'source_read', 'destination_read', 'destination_sync'] as const)(
  'R1: survivor merge binds physical Vault identity across %s', async (boundary) => {
    const local = fixture();
    try {
      const root = registerVault(local, 'physical-vault');
      local.scope.resources.push({ kind: 'vault', domain: 'personal', root, vaultId: 'physical-vault' });
      await capture(local);
      writeFileSync(join(root, 'draft.md'), 'newer-authorized-draft');
      if (boundary === 'before_admission') replaceVaultRoot(root);
      if (boundary === 'directory_scan') filesystemBoundary.afterScan = (path) => {
        if (path === root) { filesystemBoundary.afterScan = undefined; replaceVaultRoot(root); }
      };
      if (boundary === 'source_read' || boundary === 'destination_read') filesystemBoundary.afterRead = (path) => {
        if ((boundary === 'source_read' && path === join(root, 'draft.md'))
          || (boundary === 'destination_read' && path.endsWith(`/vault/personal/${digest('physical-vault')}/draft.md`))) {
          filesystemBoundary.afterRead = undefined;
          replaceVaultRoot(root);
        }
      };
      if (boundary === 'destination_sync') filesystemBoundary.afterRead = (path) => {
        if (path !== join(root, 'draft.md')) return;
        filesystemBoundary.afterRead = undefined;
        filesystemBoundary.afterSync = (destination) => {
          if (destination.endsWith(`/vault/personal/${digest('physical-vault')}/draft.md`)) {
            filesystemBoundary.afterSync = undefined;
            replaceVaultRoot(root);
          }
        };
      };
      const outcome = await createRecoveryRestorer({
        recoveryRoot: join(local.root, 'sets'), isolationRoot: join(local.root, 'isolated'), authority, versionLocks,
        survivors: [{ domain: 'personal', root, vaultId: 'physical-vault' }],
      }).restoreRecoverySet('set-review').then(
        (receipt) => ({ accepted: true as const, text: readFileSync(join(receipt.directory, 'vault/personal', digest('physical-vault'), 'draft.md'), 'utf8') }),
        (error: Error) => ({ accepted: false as const, error: error.message }),
      );
      expect(outcome.accepted).toBe(boundary === 'unchanged');
      if (outcome.accepted) expect(outcome.text).toBe('newer-authorized-draft');
      expect(readFileSync(join(boundary === 'unchanged' ? root : `${root}-surviving-original`, 'draft.md'), 'utf8')).toBe('newer-authorized-draft');
    } finally { local.close(); }
  },
);

test.each([
  ['capture', 'unchanged'], ['capture', 'persistent'], ['capture', 'transient'],
  ['survivor', 'unchanged'], ['survivor', 'persistent'], ['survivor', 'transient'],
] as const)('R1: %s retains full ancestor containment across source open: %s', async (operation, boundary) => {
  const local = fixture();
  try {
    const root = registerVault(local, 'nested-vault');
    const inside = join(root, 'inside');
    const outside = join(local.root, 'outside');
    const saved = join(local.root, 'saved-inside');
    mkdirSync(inside);
    mkdirSync(outside);
    writeFileSync(join(inside, 'draft.md'), 'authorized-original');
    writeFileSync(join(outside, 'draft.md'), 'unapproved-external-bytes');
    const identity = `${statSync(root).dev}:${statSync(root).ino}`;
    local.scope.resources.push({ kind: 'vault', domain: 'personal', root, vaultId: 'nested-vault' });
    if (operation === 'survivor') await capture(local);
    filesystemBoundary.beforeOpen = (path) => {
      if (boundary === 'unchanged' || path !== join(inside, 'draft.md')) return;
      filesystemBoundary.beforeOpen = undefined;
      renameSync(inside, saved);
      symlinkSync(outside, inside, 'dir');
    };
    filesystemBoundary.afterOpen = (path) => {
      if (boundary !== 'transient' || path !== join(inside, 'draft.md')) return;
      filesystemBoundary.afterOpen = undefined;
      rmSync(inside);
      renameSync(saved, inside);
    };
    const action = operation === 'capture' ? capture(local).then((set) => ({
      accepted: set.manifest.completeness.recoverable,
      copied: readFileSync(join(set.directory, 'resources/0/inside/draft.md'), 'utf8'),
    })) : createRecoveryRestorer({
      recoveryRoot: join(local.root, 'sets'), isolationRoot: join(local.root, 'isolated'), authority, versionLocks,
      survivors: [{ domain: 'personal', root, vaultId: 'nested-vault' }],
    }).restoreRecoverySet('set-review').then((receipt) => ({
      accepted: true, copied: readFileSync(join(receipt.directory, 'vault/personal', digest('nested-vault'), 'inside/draft.md'), 'utf8'),
    }));
    const outcome = await action.catch((error: Error) => ({ accepted: false, copied: undefined, error: error.message }));
    expect(`${statSync(root).dev}:${statSync(root).ino}`).toBe(identity);
    expect(outcome.accepted, `${operation} ${boundary} ${JSON.stringify(outcome)}`).toBe(boundary === 'unchanged');
    if (outcome.accepted) expect(outcome.copied).toBe('authorized-original');
    expect(readFileSync(join(boundary === 'persistent' ? saved : inside, 'draft.md'), 'utf8')).toBe('authorized-original');
  } finally {
    filesystemBoundary.beforeOpen = undefined;
    filesystemBoundary.afterOpen = undefined;
    local.close();
  }
});

test('R1: capture revalidates the final source hash through admitted ancestry', async () => {
  const local = fixture();
  try {
    const root = registerVault(local, 'hash-vault');
    const inside = join(root, 'inside');
    const outside = join(local.root, 'hash-outside');
    mkdirSync(inside);
    mkdirSync(outside);
    writeFileSync(join(inside, 'draft.md'), 'authorized-original');
    // Equal bytes still require admitted physical containment for revalidation.
    writeFileSync(join(outside, 'draft.md'), 'authorized-original');
    local.scope.resources.push({ kind: 'vault', domain: 'personal', root, vaultId: 'hash-vault' });
    filesystemBoundary.afterSync = (path) => {
      if (!path.endsWith('/resources/0/inside/draft.md')) return;
      filesystemBoundary.afterSync = undefined;
      renameSync(inside, join(local.root, 'saved-inside'));
      symlinkSync(outside, inside, 'dir');
    };
    const outcome = await capture(local).then((set) => ({
      accepted: set.manifest.completeness.recoverable,
      copied: readFileSync(join(set.directory, 'resources/0/inside/draft.md'), 'utf8'),
    }), (error: Error) => ({ accepted: false, error: error.message }));
    expect(outcome.accepted, JSON.stringify(outcome)).toBe(false);
    expect(readFileSync(join(local.root, 'saved-inside/draft.md'), 'utf8')).toBe('authorized-original');
  } finally { local.close(); }
});

test.each(['unchanged', 'manifest_hash', 'manifest', 'envelope', 'directory'] as const)(
  'R2: final restic clock cannot change the verified identity: %s', async (mutation) => {
    const local = fixture();
    try {
      const set = await capture(local);
      const originalHash = set.manifestHash;
      const originalDirectory = set.directory;
      const snapshot = new Map<string, Buffer>();
      const port = createResticRecoveryBackup({
        target: { targetId: 'fixture-target', repository: 'sftp:fixture:/backup', domains: ['personal'], authorized: true,
          offHostVerified: true, credentialRef: 'fixture-ref', recoveryCredentialRef: 'recovery-ref', expectedVersion: 'restic review' },
        credentials: { async resolve() { return { RESTIC_PASSWORD: 'synthetic-test-password' }; } },
        async runner(args, _environment, emit) {
          if (args.includes('version')) emit(Buffer.from('restic review'));
          else if (args.includes('backup')) {
            for (const path of args.slice(args.indexOf('--') + 1)) snapshot.set(path, readFileSync(path));
            emit(Buffer.from(JSON.stringify({ message_type: 'summary', snapshot_id: 'b'.repeat(64) }) + '\n'));
          } else if (args.includes('dump')) emit(snapshot.get(args.at(-1)!)!);
        },
        now() {
          if (mutation === 'manifest_hash') set.manifestHash = 'c'.repeat(64);
          if (mutation === 'manifest') set.manifest.setId = 'substitute-set';
          if (mutation === 'envelope') writeFileSync(join(set.directory, 'manifest.json'), '{"substitute":true}');
          if (mutation === 'directory') set.directory = join(local.root, 'substitute-directory');
          return new Date(stamp);
        },
      });
      const outcome = await port.protect(set).then(
        (receipt) => ({ accepted: true as const, receipt }), (error: Error) => ({ accepted: false as const, error: error.message }),
      );
      if (outcome.accepted) expect(outcome.receipt?.manifestHash).toBe(originalHash);
      expect(outcome.accepted).toBe(mutation === 'unchanged');
      const uploaded = JSON.parse(snapshot.get(join(originalDirectory, 'manifest.json'))!.toString()) as { manifest: unknown };
      expect(digest(JSON.stringify(uploaded.manifest))).toBe(originalHash);
    } finally { local.close(); }
  },
);

test.each(['capture', 'survivor'] as const)('R1: %s refuses a substituted file handle even after the original root returns', async (operation) => {
  const local = fixture();
  try {
    const root = registerVault(local, 'physical-vault');
    local.scope.resources.push({ kind: 'vault', domain: 'personal', root, vaultId: 'physical-vault' });
    if (operation === 'survivor') await capture(local);
    const substitute = (path: string) => {
      if (path !== join(root, 'draft.md')) return;
      filesystemBoundary.beforeOpen = undefined;
      filesystemBoundary.beforeRead = undefined;
      replaceVaultRoot(root);
    };
    const restore = (path: string) => {
      if (path !== join(root, 'draft.md')) return;
      filesystemBoundary.afterOpen = undefined;
      filesystemBoundary.afterRead = undefined;
      renameSync(root, `${root}-rejected-replacement`);
      renameSync(`${root}-surviving-original`, root);
    };
    filesystemBoundary.beforeOpen = substitute;
    filesystemBoundary.beforeRead = substitute;
    filesystemBoundary.afterOpen = restore;
    filesystemBoundary.afterRead = restore;
    const action = operation === 'capture' ? capture(local) : createRecoveryRestorer({
      recoveryRoot: join(local.root, 'sets'), isolationRoot: join(local.root, 'isolated'), authority, versionLocks,
      survivors: [{ domain: 'personal', root, vaultId: 'physical-vault' }],
    }).restoreRecoverySet('set-review');
    await expect(action).rejects.toThrow();
    expect(readFileSync(join(root, 'draft.md'), 'utf8')).toBe('physical-vault');
  } finally { local.close(); }
});

test('C1: protected withdrawal during runtime enabling cannot reopen stale admission', async () => {
  const local = fixture();
  const remote = witnessFixture(local.head);
  let runtime: Database.Database | undefined;
  try {
    await capture(local);
    const receipt = await createRecoveryRestorer({
      ...restoreOptions(local, remote),
      activation: { async enableDomain(input) {
        runtime = new Database(join(input.directory, 'databases/service.sqlite'));
        createRecoveryRuntimeGate(runtime).admit(input);
        const next = entry(2, local.initial.hash, 'concurrent-withdrawal', input.writerEpoch);
        addEvent(runtime, next);
        const journal = createRecoveryWithdrawalJournal({
          database: runtime, witness: remote.witness,
          log: { independence: 'independent_authority', async appendAndReadBack(value) {
            return { domain: value.domain, seq: value.seq, hash: value.hash, verified: true };
          } },
        });
        expect(await journal.protectPending('personal', input.writerEpoch)).toBe('protected');
        return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true };
      } },
    }).restoreRecoverySet('set-review', 'activate');
    expect(recoveryWriteAllowed(runtime!, 'personal')).toBe(false);
    expect(receipt.data_domains.personal.status).toBe('blocked');
  } finally { runtime?.close(); local.close(); }
});

test('C2: unrelated same-domain root leaves the registered Vault missing', async () => {
  const local = fixture();
  try {
    registerVault(local, 'registered');
    const unrelated = join(local.root, 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'wrong.md'), 'wrong');
    local.scope.resources.push({ kind: 'vault', domain: 'personal', root: unrelated });
    const set = await capture(local);
    expect(set.manifest.completeness.recoverable).toBe(false);
  } finally { local.close(); }
});

test('H1: two owners Vaults in the same domain preserve identities and files', async () => {
  const local = fixture();
  try {
    for (const name of ['vault-a', 'vault-b']) {
      local.scope.resources.push({ kind: 'vault', domain: 'personal', root: registerVault(local, name) });
    }
    expect((await capture(local)).manifest.completeness.recoverable).toBe(true);
    const receipt = await createRecoveryRestorer({
      recoveryRoot: join(local.root, 'sets'), isolationRoot: join(local.root, 'isolated'), authority, versionLocks,
    }).restoreRecoverySet('set-review');
    const restored = new Database(join(receipt.directory, 'databases/service.sqlite'));
    try {
      const rows = restored.prepare('SELECT vault_id,physical_root FROM vaults ORDER BY vault_id').all() as Array<{ vault_id: string; physical_root: string }>;
      expect(new Set(rows.map((row) => row.physical_root)).size).toBe(2);
      for (const row of rows) expect(readFileSync(join(row.physical_root, 'draft.md'), 'utf8')).toBe(row.vault_id);
    } finally { restored.close(); }
  } finally { local.close(); }
});

test('C3: restic cannot certify a replacement envelope under the original manifest hash', async () => {
  const local = fixture();
  try {
    const set = await capture(local);
    writeFileSync(join(set.directory, 'manifest.json'), '{"invalid":"replacement manifest"}');
    const snapshot = new Map<string, Buffer>();
    const port = createResticRecoveryBackup({
      target: { targetId: 'fixture-target', repository: 'sftp:fixture:/backup', domains: ['personal'], authorized: true,
        offHostVerified: true, credentialRef: 'fixture-ref', recoveryCredentialRef: 'recovery-ref', expectedVersion: 'restic review' },
      credentials: { async resolve() { return { RESTIC_PASSWORD: 'synthetic-test-only' }; } },
      runner: async (args, _environment, emit) => {
        if (args.includes('version')) emit(Buffer.from('restic review'));
        else if (args.includes('backup')) {
          for (const path of ['manifest.json', ...set.manifest.artifacts.map((artifact) => artifact.path)]) {
            snapshot.set(join(set.directory, path), readFileSync(join(set.directory, path)));
          }
          emit(Buffer.from(JSON.stringify({ message_type: 'summary', snapshot_id: 'b'.repeat(64) }) + '\n'));
        } else if (args.includes('dump')) emit(snapshot.get(args.at(-1)!)!);
      },
    });
    await expect(port.protect(set)).rejects.toThrow();
  } finally { local.close(); }
});

test('C4: a rebuild-created uncertain intent invalidates reconciliation', async () => {
  const local = fixture();
  try {
    await capture(local);
    const remote = witnessFixture(local.head);
    const base = restoreOptions(local, remote);
    const receipt = await createRecoveryRestorer({
      ...base,
      replay: { ...base.replay, async rebuildProjections(context) {
        uncertainNotification(context.service, 'created-after-scan');
        return { confirmed: true };
      } },
      activation: { async enableDomain() { return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true }; } },
    }).restoreRecoverySet('set-review', 'activate');
    expect(receipt.data_domains.personal.status).toBe('blocked');
  } finally { local.close(); }
});

test('H2: completed import replay returns durable receipt under owner read authorization', async () => {
  const local = fixture();
  try {
    const root = join(local.root, 'survivors');
    mkdirSync(root);
    writeFileSync(join(root, 'approved.md'), 'approved');
    let writes = 0;
    const importer = createOwnerRecoveryImporter({
      database: local.service, isolationRoot: join(local.root, 'imports'),
      witness: createRecoveryWitness({ writerId: 'candidate' }),
      control: { async authorizeRead(input) { return { authenticatedOwner: true, domain: input.domain }; }, async verify(input) {
        writes += 1;
        if (writes > 1) throw new Error('ONE_SHOT_ALREADY_CONSUMED');
        return { authenticatedOwner: true, trustedControl: true, domain: input.domain, controlReceiptRef: input.controlReceiptRef };
      } },
    });
    const request = { importId: 'stable-import', accountId: 'owner', domain: 'personal', controlReceiptRef: 'stable-control',
      root, approvedPaths: ['approved.md'], previousEpoch: 'lost-epoch' };
    const first = await importer.importSurvivors(request);
    rmSync(root, { recursive: true });
    const second = await importer.importSurvivors(request);
    expect(second).toEqual(first);
    expect(writes).toBe(1);
  } finally { local.close(); }
});

test('C1: clock callback after runtime enabling invalidates the cut and revokes its capability', async () => {
  const local = fixture();
  const remote = witnessFixture(local.head);
  let runtime: Database.Database | undefined;
  let changed = false;
  let revoked = 0;
  try {
    await capture(local);
    const receipt = await createRecoveryRestorer({
      ...restoreOptions(local, remote),
      now() {
        if (runtime && !changed) {
          changed = true;
          const next = entry(2, local.initial.hash, 'clock-withdrawal', remote.read().writerEpoch);
          addEvent(runtime, next);
          runtime.prepare('INSERT INTO recovery_withdrawal_log VALUES (?,?,?,?,?,?,?)').run(
            next.domain, next.seq, next.writerEpoch, next.previousHash, next.hash, JSON.stringify(next.event), 'protected',
          );
          runtime.prepare('DELETE FROM recovery_withdrawal_pending').run();
          runtime.prepare("UPDATE recovery_domain_gates SET status='blocked',reason='withdrawal_protected_requires_admission'").run();
          remote.read().withdrawal = { seq: next.seq, hash: next.hash };
          remote.read().revision += '-new';
        }
        return new Date(stamp);
      },
      activation: {
        async enableDomain(input) {
          runtime = new Database(join(input.directory, 'databases/service.sqlite'));
          createRecoveryRuntimeGate(runtime).admit(input);
          return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true };
        },
        async revokeDomain(input) { revoked += 1; createRecoveryRuntimeGate(runtime!).revoke(input.domain); },
      },
    }).restoreRecoverySet('set-review', 'activate');
    expect(receipt.data_domains.personal.status).toBe('blocked');
    expect(revoked).toBe(1);
    expect(recoveryWriteAllowed(runtime!, 'personal')).toBe(false);
    expect(runtime!.prepare('SELECT activation_id FROM recovery_domain_gates').get()).toEqual({ activation_id: null });
  } finally { runtime?.close(); local.close(); }
});

test('C1: authoritative withdrawal head movement without a local pending row refuses publication', async () => {
  const local = fixture();
  const remote = witnessFixture(local.head);
  let revoked = 0;
  try {
    await capture(local);
    const receipt = await createRecoveryRestorer({
      ...restoreOptions(local, remote),
      activation: {
        async enableDomain() {
          remote.read().withdrawal = { seq: 2, hash: digest('new-head') };
          remote.read().revision += '-advanced';
          return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true };
        },
        async revokeDomain() { revoked += 1; },
      },
    }).restoreRecoverySet('set-review', 'activate');
    expect(receipt.data_domains.personal.status).toBe('blocked');
    expect(revoked).toBe(1);
  } finally { local.close(); }
});

test('C1: a clock failure after enabling revokes the unpublished runtime capability', async () => {
  const local = fixture();
  let runtime: Database.Database | undefined;
  let revoked = 0;
  try {
    await capture(local);
    await expect(createRecoveryRestorer({
      ...restoreOptions(local, witnessFixture(local.head)),
      now() { if (runtime) throw new Error('CLOCK_FAILED'); return new Date(stamp); },
      activation: {
        async enableDomain(input) {
          runtime = new Database(join(input.directory, 'databases/service.sqlite'));
          createRecoveryRuntimeGate(runtime).admit(input);
          return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true };
        },
        async revokeDomain(input) { revoked += 1; createRecoveryRuntimeGate(runtime!).revoke(input.domain); },
      },
    }).restoreRecoverySet('set-review', 'activate')).rejects.toThrow('CLOCK_FAILED');
    expect(revoked).toBe(1);
    expect(runtime!.prepare('SELECT status,activation_id FROM recovery_domain_gates').get()).toEqual({ status: 'blocked', activation_id: null });
    expect(recoveryWriteAllowed(runtime!, 'personal')).toBe(false);
  } finally { runtime?.close(); local.close(); }
});

test('C2: a declared Vault identity cannot substitute a different registered physical root', async () => {
  const local = fixture();
  try {
    const first = registerVault(local, 'vault-a');
    registerVault(local, 'vault-b');
    local.scope.resources.push({ kind: 'vault', domain: 'personal', root: first, vaultId: 'vault-b' });
    const set = await capture(local);
    expect(set.manifest.completeness.recoverable).toBe(false);
    expect(set.manifest.completeness.gaps).toContain('vault_missing_or_ambiguous:vault-b');
  } finally { local.close(); }
});

test('H1: each survivor replaces only its Vault and keeps identity-bound conflict and source mappings', async () => {
  const local = fixture();
  try {
    const roots = ['vault-a', 'vault-b'].map((name) => ({ name, root: registerVault(local, name) }));
    for (const vault of roots) local.scope.resources.push({ kind: 'vault', domain: 'personal', root: vault.root });
    await capture(local);
    for (const vault of roots) writeFileSync(join(vault.root, 'draft.md'), `new-${vault.name}`);
    const receipt = await createRecoveryRestorer({
      recoveryRoot: join(local.root, 'sets'), isolationRoot: join(local.root, 'isolated'), authority, versionLocks,
      survivors: roots.map((vault) => ({ domain: 'personal', root: vault.root, vaultId: vault.name })),
    }).restoreRecoverySet('set-review');
    expect(new Set(receipt.conflicts.map((conflict) => conflict.preservedBackupPath)).size).toBe(2);
    for (const conflict of receipt.conflicts) {
      expect(readFileSync(join(receipt.directory, conflict.preservedBackupPath), 'utf8')).toBe(conflict.vaultId);
    }
    const restored = new Database(join(receipt.directory, 'databases/service.sqlite'));
    try {
      const rows = restored.prepare(`SELECT v.vault_id,v.physical_root,s.physical_root AS source_root
        FROM vaults v JOIN source_configs s ON s.source_id=v.source_id`).all() as Array<{ vault_id: string; physical_root: string; source_root: string }>;
      for (const row of rows) {
        expect(row.source_root).toBe(row.physical_root);
        expect(readFileSync(join(row.physical_root, 'draft.md'), 'utf8')).toBe(`new-${row.vault_id}`);
      }
    } finally { restored.close(); }
  } finally { local.close(); }
});

test('H1: a survivor Vault identity cannot consume another owners registered root', async () => {
  const local = fixture();
  try {
    const first = registerVault(local, 'vault-a');
    const second = registerVault(local, 'vault-b');
    local.scope.resources.push({ kind: 'vault', domain: 'personal', root: first }, { kind: 'vault', domain: 'personal', root: second });
    await capture(local);
    await expect(createRecoveryRestorer({
      recoveryRoot: join(local.root, 'sets'), isolationRoot: join(local.root, 'isolated'), authority, versionLocks,
      survivors: [{ domain: 'personal', root: second, vaultId: 'vault-a' }],
    }).restoreRecoverySet('set-review')).rejects.toThrow('RECOVERY_SURVIVOR_VAULT_AMBIGUOUS');
  } finally { local.close(); }
});

test.each(['credentials', 'backup', 'check', 'dump'] as const)('C3: envelope substitution during %s never produces verified protection', async (boundary) => {
  const local = fixture();
  try {
    const set = await capture(local);
    const snapshot = new Map<string, Buffer>();
    let replaced = false;
    const replace = () => {
      if (!replaced) writeFileSync(join(set.directory, 'manifest.json'), '{"invalid":"substitution"}');
      replaced = true;
    };
    const port = createResticRecoveryBackup({
      target: { targetId: 'fixture', repository: 'sftp:fixture:/backup', domains: ['personal'], authorized: true,
        offHostVerified: true, credentialRef: 'fixture', recoveryCredentialRef: 'recovery', expectedVersion: 'restic fixture' },
      credentials: { async resolve() { if (boundary === 'credentials') replace(); return { RESTIC_PASSWORD: 'synthetic-password' }; } },
      async runner(args, _environment, emit) {
        if (args.includes('version')) emit(Buffer.from('restic fixture'));
        else if (args.includes('backup')) {
          if (boundary === 'backup') replace();
          for (const path of ['manifest.json', ...set.manifest.artifacts.map((artifact) => artifact.path)]) {
            snapshot.set(join(set.directory, path), readFileSync(join(set.directory, path)));
          }
          emit(Buffer.from(JSON.stringify({ message_type: 'summary', snapshot_id: 'b'.repeat(64) }) + '\n'));
        } else if (args.includes('check') && boundary === 'check') replace();
        else if (args.includes('dump')) {
          if (boundary === 'dump') replace();
          emit(snapshot.get(args.at(-1)!)!);
        }
      },
    });
    await expect(port.protect(set)).rejects.toThrow();
  } finally { local.close(); }
});

test('C3: restic uploads exactly the signed inventory and excludes mutable directory extras', async () => {
  const local = fixture();
  try {
    const set = await capture(local);
    writeFileSync(join(set.directory, 'unlisted-private.txt'), 'must never upload');
    let uploaded: string[] = [];
    const port = createResticRecoveryBackup({
      target: { targetId: 'fixture', repository: 'sftp:fixture:/backup', domains: ['personal'], authorized: true,
        offHostVerified: true, credentialRef: 'fixture', recoveryCredentialRef: 'recovery', expectedVersion: 'restic fixture' },
      credentials: { async resolve() { return { RESTIC_PASSWORD: 'synthetic-password' }; } },
      async runner(args, _environment, emit) {
        if (args.includes('version')) emit(Buffer.from('restic fixture'));
        else if (args.includes('backup')) {
          uploaded = args.slice(args.indexOf('--') + 1);
          emit(Buffer.from(JSON.stringify({ message_type: 'summary', snapshot_id: 'b'.repeat(64) }) + '\n'));
        } else if (args.includes('dump')) emit(readFileSync(args.at(-1)!));
      },
    });
    await port.protect(set);
    expect(uploaded.sort()).toEqual(['manifest.json', ...set.manifest.artifacts.map((artifact) => artifact.path)].map((path) => join(set.directory, path)).sort());
  } finally { local.close(); }
});

test('C4: a later notification batch cannot silently create an earlier consultation intent', async () => {
  const local = fixture();
  try {
    uncertainNotification(local.service, 'notification');
    await capture(local);
    const base = restoreOptions(local, witnessFixture(local.head));
    const receipt = await createRecoveryRestorer({
      ...base,
      replay: { ...base.replay, async reconcileNotification(_intentId, context) {
        context.service.prepare(`INSERT INTO consultations (
          request_id,account_id,caller_id,data_domain,parent_work_id,result_version,status,domains_json,tools_json,
          deadline_at,budget_micros,permission_revision,cancelled_at,schema_version,created_at,updated_at) VALUES (
          'late-consultation','owner','web','personal',NULL,0,'pending','["personal"]','[]',
          '2027-01-01',1000,1,NULL,'1.0',?,?)`).run(stamp, stamp);
        return { confirmed: true };
      } },
      activation: { async enableDomain() { return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true }; } },
    }).restoreRecoverySet('set-review', 'activate');
    expect(receipt.data_domains.personal.status).toBe('blocked');
    expect(receipt.data_domains.personal.reasons).toContain('reconciliation_inventory_changed:consultations');
  } finally { local.close(); }
});

test('C4: an uncertain intent created after replay during activation invalidates its durable cut', async () => {
  const local = fixture();
  try {
    await capture(local);
    const receipt = await createRecoveryRestorer({
      ...restoreOptions(local, witnessFixture(local.head)),
      activation: { async enableDomain(input) {
        const runtime = new Database(join(input.directory, 'databases/service.sqlite'));
        try { uncertainNotification(runtime, 'after-replay'); } finally { runtime.close(); }
        return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true };
      } },
    }).restoreRecoverySet('set-review', 'activate');
    expect(receipt.data_domains.personal.status).toBe('blocked');
    expect(receipt.data_domains.personal.reasons).toContain('activation_cut_changed');
  } finally { local.close(); }
});

test('C4 control: a confirmed callback may settle its own row before a stable final cut', async () => {
  const local = fixture();
  try {
    uncertainNotification(local.service, 'notification');
    await capture(local);
    const base = restoreOptions(local, witnessFixture(local.head));
    const receipt = await createRecoveryRestorer({
      ...base,
      replay: { ...base.replay, async reconcileNotification(intentId, context) {
        context.service.prepare("UPDATE notification_intents SET status='superseded' WHERE intent_id=?").run(intentId);
        return { confirmed: true };
      } },
      activation: { async enableDomain() { return { epochInstalled: true, credentialsScoped: true, runtimeGateVerified: true }; } },
    }).restoreRecoverySet('set-review', 'activate');
    expect(receipt.data_domains.personal.status).toBe('open');
  } finally { local.close(); }
});

test('C4: late receipt status changes invalidate a previously reconciled effect', async () => {
  const service = new Database(':memory:');
  const hub = new Database(':memory:');
  service.exec(`CREATE TABLE effect_intents(intent_id TEXT PRIMARY KEY,data_domain TEXT);
    CREATE TABLE effect_receipts(intent_id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE notification_intents(intent_id TEXT PRIMARY KEY,data_domain TEXT,status TEXT);
    INSERT INTO effect_intents VALUES ('effect','personal');
    INSERT INTO effect_receipts VALUES ('effect','blocked');
    INSERT INTO notification_intents VALUES ('notice','personal','uncertain');`);
  try {
    const reasons = await reconcileRecoveredDomain({ service, hub, domain: 'personal', directory: '/unused', externalAccess: 'read_only' }, {
      externalAccess: 'read_only', async reconcileHub() { return { confirmed: true }; },
      async recoverPendingIngest() { return { confirmed: true }; }, async rebuildProjections() { return { confirmed: true }; },
      async reconcilePr() { return { confirmed: true }; }, async reconcileNotification() {
        service.prepare("UPDATE effect_receipts SET status='uncertain' WHERE intent_id='effect'").run();
        return { confirmed: true };
      },
    });
    expect(reasons).toContain('reconciliation_inventory_changed:effect_receipts');
  } finally { service.close(); hub.close(); }
});

test('H2: conflicting completed identities and unauthenticated readback never consume another write proof', async () => {
  const local = fixture();
  try {
    const root = join(local.root, 'survivors');
    mkdirSync(root);
    writeFileSync(join(root, 'approved.md'), 'approved');
    let writes = 0;
    let canRead = true;
    const importer = createOwnerRecoveryImporter({
      database: local.service, isolationRoot: join(local.root, 'imports'), witness: createRecoveryWitness({ writerId: 'candidate' }),
      control: {
        async authorizeRead(input) { return { authenticatedOwner: canRead, domain: input.domain }; },
        async verify(input) { writes += 1; return { authenticatedOwner: true, trustedControl: true, domain: input.domain, controlReceiptRef: input.controlReceiptRef }; },
      },
    });
    const request = { importId: 'stable-import', accountId: 'owner', domain: 'personal', controlReceiptRef: 'stable-control',
      root, approvedPaths: ['approved.md'], previousEpoch: 'lost-epoch' };
    await importer.importSurvivors(request);
    for (const changed of [{ root: `${root}-other` }, { approvedPaths: ['other.md'] }, { domain: 'company' },
      { controlReceiptRef: 'other-control' }, { previousEpoch: 'other-epoch' }]) {
      await expect(importer.importSurvivors({ ...request, ...changed })).rejects.toThrow('RECOVERY_IMPORT_ID_CONFLICT');
    }
    canRead = false;
    await expect(importer.importSurvivors(request)).rejects.toThrow('RECOVERY_OWNER_CONTROL_REQUIRED');
    expect(writes).toBe(1);
  } finally { local.close(); }
});

test('H2: interrupted import has a durable closed outcome under the original identity', async () => {
  const local = fixture();
  try {
    const root = join(local.root, 'survivors');
    mkdirSync(root);
    let writes = 0;
    const importer = createOwnerRecoveryImporter({
      database: local.service, isolationRoot: join(local.root, 'imports'), witness: createRecoveryWitness({ writerId: 'candidate' }),
      control: {
        async authorizeRead(input) { return { authenticatedOwner: true, domain: input.domain }; },
        async verify(input) { writes += 1; return { authenticatedOwner: true, trustedControl: true, domain: input.domain, controlReceiptRef: input.controlReceiptRef }; },
      },
    });
    const request = { importId: 'interrupted', accountId: 'owner', domain: 'personal', controlReceiptRef: 'stable-control',
      root, approvedPaths: ['missing.md'], previousEpoch: 'lost-epoch' };
    await expect(importer.importSurvivors(request)).rejects.toThrow('ENOENT');
    rmSync(root, { recursive: true });
    const outcome = await importer.importSurvivors(request);
    expect(outcome.data_domains.personal.status).toBe('blocked');
    expect(outcome.data_domains.personal.reasons).toContain('owner_import_incomplete');
    expect(writes).toBe(1);
  } finally { local.close(); }
});

test('H2: loss of the one-shot proof response remains a discoverable interrupted operation', async () => {
  const local = fixture();
  try {
    const root = join(local.root, 'survivors');
    mkdirSync(root);
    writeFileSync(join(root, 'approved.md'), 'approved');
    let writes = 0;
    const importer = createOwnerRecoveryImporter({
      database: local.service, isolationRoot: join(local.root, 'imports'), witness: createRecoveryWitness({ writerId: 'candidate' }),
      control: {
        async authorizeRead(input) { return { authenticatedOwner: true, domain: input.domain }; },
        async verify() { writes += 1; throw new Error('CONTROL_RESPONSE_LOST'); },
      },
    });
    const request = { importId: 'interrupted', accountId: 'owner', domain: 'personal', controlReceiptRef: 'one-shot',
      root, approvedPaths: ['approved.md'], previousEpoch: 'lost-epoch' };
    await expect(importer.importSurvivors(request)).rejects.toThrow('CONTROL_RESPONSE_LOST');
    const outcome = await importer.importSurvivors(request);
    expect(outcome.data_domains.personal.status).toBe('blocked');
    expect(writes).toBe(1);
  } finally { local.close(); }
});

test('defensive witness validation: malformed entry hash cannot advance an authoritative head', async () => {
  const local = fixture();
  const remote = witnessFixture(local.head);
  try {
    remote.read().state = 'open';
    remote.read().writerId = 'new-writer';
    const malformed = { ...entry(2, local.initial.hash, 'next'), hash: '0'.repeat(64) };
    await expect(remote.witness.advanceWithdrawalHead('personal', 'old-epoch', malformed)).resolves.toBe(false);
    expect(remote.read().withdrawal).toEqual(local.head);
  } finally { local.close(); }
});
