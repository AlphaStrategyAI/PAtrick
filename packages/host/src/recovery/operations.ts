import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { createRecoveryBackup, verifyImmutableRecoverySet, verifyRecoverySet, type RecoveryBackupOptions } from './backup.js';
import { createRecoveryRestorer, type RecoveryRestoreOptions } from './restore.js';
import { assertName, canonical, containedPath, durableJson, syncDirectory } from './files.js';
import type { RecoveryDatabaseQuery, RecoveryDatabaseState, RecoveryManifestAuthority, RecoveryRestoreReceipt, RecoveryScope, RecoverySet } from './types.js';

export type RecoveryOperationRequest = { operationId: string; targetId: string; mode: 'backup' | 'drill'; manifestHash?: string };
export type RecoveryOperationTarget = {
  identity: { accountId: string; scopeId: string; domains: string[]; deviceId: string; configRevision: string };
  backup?: { options: RecoveryBackupOptions; scope: RecoveryScope };
  drill?: Omit<RecoveryRestoreOptions, 'activation'>;
};
export type RecoveryOperationOutcome = { manifestHash: string; receipt?: RecoveryRestoreReceipt };
export type RecoveryOperationStatus = { status: 'absent' | 'reserved' | 'running_or_uncertain' }
  | { status: 'completed'; outcome: RecoveryOperationOutcome };
type Binding = { protocol: 'patrick-recovery-operation-v1'; request: RecoveryOperationRequest; configuration: unknown; roots: RecoveryDirectoryIdentity[] };
type RecordPayload = { kind: 'reservation' | 'claim' | 'terminal'; binding: Binding; outcome?: RecoveryOperationOutcome };
type RecoveryVerifier = Pick<RecoveryManifestAuthority, 'keyId' | 'verify'>;
export type RecoveryJournalRoot = Readonly<{ path: string; device: number; inode: number }>;
type RecoveryDirectoryIdentity = RecoveryJournalRoot & { physical: string };
export type RecoveryBackupReadbackTarget = {
  identity: RecoveryOperationTarget['identity'];
  root: string;
  scope: RecoveryScope;
  authority: RecoveryVerifier;
  readDatabase?: (db: RecoveryDatabaseQuery, role: 'service' | 'hub') => RecoveryDatabaseState;
  protection?: { kind: 'local_only' } | { kind: 'off_host'; verify(set: RecoverySet): Promise<boolean> };
};

async function assertDirectoryAncestry(absolute: string, ancestor: string) {
  let cursor = ancestor;
  for (const part of absolute.slice(ancestor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('RECOVERY_SYMLINK_FORBIDDEN');
  }
}

// Every root must already be provisioned by the host. Retain both spelling and physical identity.
async function rootIdentity(path: string): Promise<RecoveryDirectoryIdentity> {
  const absolute = resolve(path);
  await assertDirectoryAncestry(absolute, parse(absolute).root);
  return directoryIdentity(absolute);
}

async function directoryIdentity(absolute: string): Promise<RecoveryDirectoryIdentity> {
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error('RECOVERY_SYMLINK_FORBIDDEN');
  if (!stat.isDirectory()) throw new Error('RECOVERY_PATH_INVALID');
  return { path: absolute, physical: await realpath(absolute), device: stat.dev, inode: stat.ino };
}

async function readbackRootIdentity(path: string): Promise<RecoveryDirectoryIdentity> {
  const identity = await directoryIdentity(resolve(path));
  if (dirname(identity.path) === dirname(identity.physical)) return identity;

  // Native realpath already establishes the common canonical prefix. Only the
  // suffix needs lstat to distinguish case normalization from a symlink.
  const root = parse(identity.path).root;
  const requested = identity.path.slice(root.length).split(sep);
  const physical = identity.physical.startsWith(root) ? identity.physical.slice(root.length).split(sep) : [];
  let matched = 0;
  while (matched < requested.length && requested[matched] === physical[matched]) matched += 1;
  await assertDirectoryAncestry(identity.path, join(root, ...requested.slice(0, matched)));
  return identity;
}

function checkedRequest(requested: RecoveryOperationRequest) {
  const request = structuredClone(requested);
  assertName(request.operationId); assertName(request.targetId);
  if (!['backup', 'drill'].includes(request.mode) || Object.keys(request).some((key) => !['operationId', 'targetId', 'mode', 'manifestHash'].includes(key))) {
    throw new Error('RECOVERY_OPERATION_REQUEST_INVALID');
  }
  return request;
}

function checkedIdentity(requested: RecoveryOperationTarget['identity']) {
  const identity = structuredClone(requested);
  if (!identity || !identity.accountId || !identity.scopeId || !identity.deviceId || !identity.configRevision || !identity.domains.length
    || identity.domains.some((domain) => !domain) || new Set(identity.domains).size !== identity.domains.length) {
    throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
  }
  return identity;
}

async function backupBinding(request: RecoveryOperationRequest, root: string, identity: RecoveryOperationTarget['identity'],
  target: { root: string; scope: RecoveryScope; authority: RecoveryVerifier; offHost: boolean },
  identifyRoot = rootIdentity): Promise<Binding> {
  const scope = structuredClone(target.scope);
  assertName(scope.setId);
  if (canonical(scope.domains.map(({ domain }) => domain).sort()) !== canonical([...identity.domains].sort())) {
    throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
  }
  const roots = [await identifyRoot(root), await identifyRoot(target.root)];
  for (const resource of scope.resources) roots.push(await identifyRoot(resource.root));
  return { protocol: 'patrick-recovery-operation-v1', request, roots,
    configuration: { identity, scope, authority: target.authority.keyId, offHost: target.offHost } };
}

async function recordPath(root: string, binding: Binding, kind: RecordPayload['kind']) {
  return containedPath(root, `${binding.request.operationId}.${kind}.json`);
}

// Restart readback has no live owner to trust journal size. Limit the read even
// if an entry grows after stat; never wait for a special file to produce bytes.
async function readBoundedRecord(path: string, maxBytes: number) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error('RECOVERY_OPERATION_RECORD_INVALID');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(path).catch(() => { throw new Error('RECOVERY_OPERATION_RECORD_INVALID'); });
    if (length !== before.size || [after, named].some((entry) => !entry.isFile() || entry.dev !== before.dev
      || entry.ino !== before.ino || entry.size !== before.size || entry.mtimeMs !== before.mtimeMs)) {
      throw new Error('RECOVERY_OPERATION_RECORD_INVALID');
    }
    return buffer.toString('utf8', 0, length);
  } finally { await handle.close(); }
}

async function readRecord(root: string, authority: RecoveryVerifier, binding: Binding, kind: RecordPayload['kind'], maxBytes?: number) {
  const path = await recordPath(root, binding, kind);
  const text = maxBytes === undefined
    ? await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    })
    : await readBoundedRecord(path, maxBytes);
  if (text === undefined) return undefined;
  let record: { payload: RecordPayload; keyId: string; signature: string };
  try {
    record = JSON.parse(text) as typeof record;
    if (Object.keys(record).sort().join(',') !== 'keyId,payload,signature' || record.keyId !== authority.keyId
      || !await authority.verify(Buffer.from(canonical(record.payload)), record.signature, authority.keyId)
      || record.payload.kind !== kind || record.payload.binding.protocol !== 'patrick-recovery-operation-v1'
      || (kind === 'terminal' && !record.payload.outcome)) throw new Error('invalid');
  } catch { throw new Error('RECOVERY_OPERATION_RECORD_INVALID'); }
  if (canonical(record.payload.binding) !== canonical(binding)) throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
  return record.payload;
}

async function readStatus(root: string, authority: RecoveryVerifier, binding: Binding,
  verifyOutcome: (outcome: RecoveryOperationOutcome) => Promise<void>, maxBytes?: number): Promise<RecoveryOperationStatus> {
  // Read newest publication first so concurrent forward progress cannot look like a missing predecessor.
  const terminal = await readRecord(root, authority, binding, 'terminal', maxBytes);
  const claim = await readRecord(root, authority, binding, 'claim', maxBytes);
  const reservation = await readRecord(root, authority, binding, 'reservation', maxBytes);
  if ((!reservation && (claim || terminal)) || (terminal && !claim)) throw new Error('RECOVERY_OPERATION_RECORD_INVALID');
  if (terminal) {
    await verifyOutcome(terminal.outcome!);
    return { status: 'completed', outcome: terminal.outcome! };
  }
  if (claim) return { status: 'running_or_uncertain' };
  return { status: reservation ? 'reserved' : 'absent' };
}

function verifyBackupOutcome(set: RecoverySet, scope: RecoveryScope, outcome: RecoveryOperationOutcome) {
  if (set.manifest.setId !== scope.setId || set.manifestHash !== outcome.manifestHash) {
    throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
  }
}

/** Reads an existing backup on independently enrolled, host-controlled storage.
 * An absent record is not permission to repeat an operation.
 */
export function createRecoveryBackupReader(options: {
  root: RecoveryJournalRoot; authority: RecoveryVerifier; targets: Record<string, RecoveryBackupReadbackTarget>;
}) {
  function plan(request: RecoveryOperationRequest) {
    const registered = Object.hasOwn(options.targets, request.targetId) ? options.targets[request.targetId] : undefined;
    const targetAuthority = registered?.authority;
    const journalAuthority = options.authority;
    if (!targetAuthority?.keyId || typeof targetAuthority.verify !== 'function'
      || !journalAuthority?.keyId || typeof journalAuthority.verify !== 'function') throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
    const protection = registered!.protection;
    const offHost = protection?.kind === 'off_host';
    if (protection !== undefined && protection?.kind !== 'local_only' && (!offHost || typeof protection.verify !== 'function')) {
      throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
    }
    return {
      root: registered!.root, scope: structuredClone(registered!.scope), identity: checkedIdentity(registered!.identity),
      journalRoot: structuredClone(options.root), readDatabase: registered!.readDatabase, offHost,
      journalAuthority, journalKeyId: journalAuthority.keyId, verifyJournal: journalAuthority.verify,
      targetAuthority, authority: { keyId: targetAuthority.keyId, verify: targetAuthority.verify },
      protection, verifyProtection: offHost ? protection.verify : undefined,
    };
  }

  async function observeBinding(request: RecoveryOperationRequest, target: ReturnType<typeof plan>) {
    const expected = target.journalRoot;
    const binding = await backupBinding(request, expected.path, target.identity, target, readbackRootIdentity);
    const [root] = binding.roots;
    if (root.path !== expected.path || root.physical !== expected.path || root.device !== expected.device || root.inode !== expected.inode) {
      throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
    }
    return binding;
  }

  return {
    async read(requested: RecoveryOperationRequest): Promise<RecoveryOperationStatus> {
      const request = checkedRequest(requested);
      if (request.mode !== 'backup' || request.manifestHash !== undefined) throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
      const target = plan(request);
      const binding = await observeBinding(request, target);
      const journal = { keyId: target.journalKeyId, verify: target.verifyJournal.bind(target.journalAuthority) };
      // A trusted v1 binding may itself be large. Restrict the envelope overhead
      // independently of its known canonical size, including the trusted key ID.
      const maxBytes = Buffer.byteLength(canonical(binding)) + Buffer.byteLength(JSON.stringify(journal.keyId)) + 1024 * 1024;
      const result = await readStatus(target.journalRoot.path, journal, binding, async (outcome) => {
        const authority = { async verify(bytes: Uint8Array, signature: string, keyId: string) {
          return keyId === target.authority.keyId && target.authority.verify.call(target.targetAuthority, bytes, signature, keyId);
        } };
        const path = await containedPath(target.root, target.scope.setId);
        const set = await verifyImmutableRecoverySet(path, authority, target.scope.versionLocks, target.readDatabase);
        verifyBackupOutcome(set, target.scope, outcome);
        if (canonical(set.manifest.domains) !== canonical(target.scope.domains)) throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
        if (target.verifyProtection && !await target.verifyProtection.call(target.protection, set)) {
          throw new Error('RECOVERY_OFF_HOST_UNCONFIRMED');
        }
      }, maxBytes);

      const currentBinding = await observeBinding(request, target);
      const enrolled = plan(request);
      if (canonical(currentBinding) !== canonical(binding)
        || canonical(enrolled.journalRoot) !== canonical(target.journalRoot)
        || enrolled.journalAuthority !== target.journalAuthority || enrolled.journalKeyId !== target.journalKeyId
        || enrolled.verifyJournal !== target.verifyJournal || enrolled.targetAuthority !== target.targetAuthority
        || enrolled.authority.keyId !== target.authority.keyId || enrolled.authority.verify !== target.authority.verify
        || enrolled.protection !== target.protection || enrolled.verifyProtection !== target.verifyProtection
        || enrolled.readDatabase !== target.readDatabase || enrolled.root !== target.root || enrolled.offHost !== target.offHost
        || canonical(enrolled.scope) !== canonical(target.scope) || canonical(enrolled.identity) !== canonical(target.identity)) {
        throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
      }
      return result;
    },
  };
}

/** Durable control records only. Completion never grants runtime writer admission.
 * A crash after claim, including after library return but before terminal publication,
 * remains uncertain indefinitely. No automatic reconciliation or second invocation exists.
 */
export function createRecoveryOperations(options: {
  root: string; authority: RecoveryManifestAuthority; targets: Record<string, RecoveryOperationTarget>;
}) {
  async function bind(requested: RecoveryOperationRequest) {
    const request = checkedRequest(requested);
    const target = Object.hasOwn(options.targets, request.targetId) ? options.targets[request.targetId] : undefined;
    if (!target || !options.authority?.keyId || typeof options.authority.sign !== 'function' || typeof options.authority.verify !== 'function') {
      throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
    }
    const identity = checkedIdentity(target.identity);
    const backup = target.backup;
    const drill = target.drill;
    if (request.mode === 'backup') {
      if (!backup?.options.freeze || request.manifestHash !== undefined) throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
      const binding = await backupBinding(request, options.root, identity, { root: backup.options.root, scope: backup.scope,
        authority: backup.options.authority, offHost: Boolean(backup.options.offHost) });
      return { binding, target };
    }
    if (!drill || !backup || !/^[a-f0-9]{64}$/.test(request.manifestHash ?? '')) throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
    const roots = [await rootIdentity(options.root), await rootIdentity(drill.recoveryRoot), await rootIdentity(drill.isolationRoot)];
    for (const survivor of drill.survivors ?? []) roots.push(await rootIdentity(survivor.root));
    const set = await verifyRecoverySet(await containedPath(drill.recoveryRoot, backup.scope.setId), drill.authority, drill.versionLocks, drill.readDatabase);
    if (set.manifest.setId !== backup.scope.setId || set.manifestHash !== request.manifestHash
      || canonical(set.manifest.domains.map((domain) => domain.domain).sort()) !== canonical([...identity.domains].sort())) throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
    const configuration = { identity, setId: set.manifest.setId, manifestHash: set.manifestHash, versionLocks: drill.versionLocks,
      authority: drill.authority.keyId, survivors: drill.survivors ?? [], witness: Boolean(drill.witness), replay: Boolean(drill.replay),
      fence: Boolean(drill.fence), withdrawalLog: Boolean(drill.withdrawalLog) };
    const binding: Binding = { protocol: 'patrick-recovery-operation-v1', request, configuration, roots };
    return { binding, target };
  }
  async function publish(binding: Binding, kind: RecordPayload['kind'], outcome?: RecoveryOperationOutcome) {
    const payload: RecordPayload = { kind, binding, ...(outcome ? { outcome } : {}) };
    const signature = await options.authority.sign(Buffer.from(canonical(payload)));
    if (!await options.authority.verify(Buffer.from(canonical(payload)), signature, options.authority.keyId)) throw new Error('RECOVERY_OPERATION_RECORD_INVALID');
    const temporary = await containedPath(options.root, `.operation-${randomUUID()}`);
    await durableJson(temporary, { payload, keyId: options.authority.keyId, signature });
    try {
      try { await link(temporary, await recordPath(options.root, binding, kind)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
      await syncDirectory(options.root);
      return true;
    } finally { await unlink(temporary); }
  }
  function status(binding: Binding): Promise<RecoveryOperationStatus> {
    return readStatus(options.root, options.authority, binding, async (outcome) => {
      if (binding.request.mode === 'backup') {
        const backup = options.targets[binding.request.targetId].backup!;
        const set = await verifyRecoverySet(await containedPath(backup.options.root, backup.scope.setId),
          backup.options.authority, backup.scope.versionLocks, backup.options.readDatabase);
        verifyBackupOutcome(set, backup.scope, outcome);
      } else {
        const receipt = outcome.receipt;
        if (outcome.manifestHash !== binding.request.manifestHash || receipt?.manifestHash !== outcome.manifestHash
          || receipt?.setId !== options.targets[binding.request.targetId].backup!.scope.setId || receipt?.mode !== 'drill') {
          throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
        }
      }
    });
  }
  return {
    async reserve(request: RecoveryOperationRequest): Promise<RecoveryOperationStatus> {
      const { binding } = await bind(request);
      await status(binding);
      await publish(binding, 'reservation');
      return status(binding);
    },
    async read(request: RecoveryOperationRequest): Promise<RecoveryOperationStatus> {
      return status((await bind(request)).binding);
    },
    async run(request: RecoveryOperationRequest, beforeInvoke?: () => void): Promise<RecoveryOperationStatus> {
      const { binding, target } = await bind(request);
      const command = binding.request;
      const prior = await status(binding);
      if (prior.status === 'absent') throw new Error('RECOVERY_OPERATION_RESERVATION_REQUIRED');
      if (prior.status !== 'reserved') return prior;
      if (!await publish(binding, 'claim')) return status(binding);
      // Revalidate physical roots and source identity after the awaited durable claim.
      if (canonical((await bind(command)).binding) !== canonical(binding)) throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
      // A trusted synchronous guard may deny after the final awaited binding check.
      beforeInvoke?.();
      let outcome: RecoveryOperationOutcome;
      if (command.mode === 'backup') {
        const set = await createRecoveryBackup(target.backup!.options).captureRecoverySet(structuredClone(target.backup!.scope));
        outcome = { manifestHash: set.manifestHash };
      } else {
        const receipt = await createRecoveryRestorer(target.drill!).restoreRecoverySet(target.backup!.scope.setId, 'drill', command.manifestHash);
        outcome = { manifestHash: receipt.manifestHash, receipt };
      }
      await publish(binding, 'terminal', outcome);
      return status(binding);
    },
  };
}
