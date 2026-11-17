import { randomUUID } from 'node:crypto';
import { link, lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { createRecoveryBackup, verifyRecoverySet, type RecoveryBackupOptions } from './backup.js';
import { createRecoveryRestorer, type RecoveryRestoreOptions } from './restore.js';
import { assertName, canonical, containedPath, durableJson, syncDirectory } from './files.js';
import type { RecoveryManifestAuthority, RecoveryRestoreReceipt, RecoveryScope } from './types.js';

export type RecoveryOperationRequest = { operationId: string; targetId: string; mode: 'backup' | 'drill'; manifestHash?: string };
export type RecoveryOperationTarget = {
  identity: { accountId: string; scopeId: string; domains: string[]; deviceId: string; configRevision: string };
  backup?: { options: RecoveryBackupOptions; scope: RecoveryScope };
  drill?: Omit<RecoveryRestoreOptions, 'activation'>;
};
export type RecoveryOperationOutcome = { manifestHash: string; receipt?: RecoveryRestoreReceipt };
export type RecoveryOperationStatus = { status: 'absent' | 'reserved' | 'running_or_uncertain' }
  | { status: 'completed'; outcome: RecoveryOperationOutcome };
type Binding = { protocol: 'patrick-recovery-operation-v1'; request: RecoveryOperationRequest; configuration: unknown; roots: unknown };
type RecordPayload = { kind: 'reservation' | 'claim' | 'terminal'; binding: Binding; outcome?: RecoveryOperationOutcome };

// Every root must already be provisioned by the host. Retain both spelling and physical identity.
async function rootIdentity(path: string) {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('RECOVERY_SYMLINK_FORBIDDEN');
  }
  const stat = await lstat(absolute);
  if (!stat.isDirectory()) throw new Error('RECOVERY_PATH_INVALID');
  return { path: absolute, physical: await realpath(absolute), device: stat.dev, inode: stat.ino };
}

/** Durable control records only. Completion never grants runtime writer admission.
 * A crash after claim, including after library return but before terminal publication,
 * remains uncertain indefinitely. No automatic reconciliation or second invocation exists.
 */
export function createRecoveryOperations(options: {
  root: string; authority: RecoveryManifestAuthority; targets: Record<string, RecoveryOperationTarget>;
}) {
  async function bind(requested: RecoveryOperationRequest) {
    const request = structuredClone(requested);
    assertName(request.operationId); assertName(request.targetId);
    if (!['backup', 'drill'].includes(request.mode) || Object.keys(request).some((key) => !['operationId', 'targetId', 'mode', 'manifestHash'].includes(key))) {
      throw new Error('RECOVERY_OPERATION_REQUEST_INVALID');
    }
    const target = Object.hasOwn(options.targets, request.targetId) ? options.targets[request.targetId] : undefined;
    if (!target || !options.authority?.keyId || typeof options.authority.sign !== 'function' || typeof options.authority.verify !== 'function') {
      throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
    }
    const identity = structuredClone(target.identity);
    if (!identity || !identity.accountId || !identity.scopeId || !identity.deviceId || !identity.configRevision || !identity.domains.length
      || identity.domains.some((domain) => !domain) || new Set(identity.domains).size !== identity.domains.length) throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
    const roots = [await rootIdentity(options.root)];
    const backup = target.backup;
    const drill = target.drill;
    let configuration: unknown;
    if (request.mode === 'backup') {
      if (!backup?.options.freeze || request.manifestHash !== undefined) throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
      const scope = structuredClone(backup.scope);
      assertName(scope.setId);
      if (canonical(scope.domains.map((domain) => domain.domain).sort()) !== canonical([...identity.domains].sort())) throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
      roots.push(await rootIdentity(backup.options.root));
      for (const resource of scope.resources) roots.push(await rootIdentity(resource.root));
      configuration = { identity, scope, authority: backup.options.authority.keyId, offHost: Boolean(backup.options.offHost) };
    } else {
      if (!drill || !backup || !/^[a-f0-9]{64}$/.test(request.manifestHash ?? '')) throw new Error('RECOVERY_OPERATION_UNAVAILABLE');
      roots.push(await rootIdentity(drill.recoveryRoot), await rootIdentity(drill.isolationRoot));
      for (const survivor of drill.survivors ?? []) roots.push(await rootIdentity(survivor.root));
      const set = await verifyRecoverySet(await containedPath(drill.recoveryRoot, backup.scope.setId), drill.authority, drill.versionLocks, drill.readDatabase);
      if (set.manifest.setId !== backup.scope.setId || set.manifestHash !== request.manifestHash
        || canonical(set.manifest.domains.map((domain) => domain.domain).sort()) !== canonical([...identity.domains].sort())) throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
      configuration = { identity, setId: set.manifest.setId, manifestHash: set.manifestHash, versionLocks: drill.versionLocks,
        authority: drill.authority.keyId, survivors: drill.survivors ?? [], witness: Boolean(drill.witness), replay: Boolean(drill.replay),
        fence: Boolean(drill.fence), withdrawalLog: Boolean(drill.withdrawalLog) };
    }
    const binding: Binding = { protocol: 'patrick-recovery-operation-v1', request, configuration, roots };
    return { binding, target };
  }
  async function path(binding: Binding, kind: RecordPayload['kind']) {
    return containedPath(options.root, `${binding.request.operationId}.${kind}.json`);
  }
  async function readRecord(binding: Binding, kind: RecordPayload['kind']): Promise<RecordPayload | undefined> {
    let text: string;
    try { text = await readFile(await path(binding, kind), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    let record: { payload: RecordPayload; keyId: string; signature: string };
    try {
      record = JSON.parse(text) as typeof record;
      if (Object.keys(record).sort().join(',') !== 'keyId,payload,signature' || record.keyId !== options.authority.keyId
        || !await options.authority.verify(Buffer.from(canonical(record.payload)), record.signature, options.authority.keyId)
        || record.payload.kind !== kind || record.payload.binding.protocol !== 'patrick-recovery-operation-v1'
        || (kind === 'terminal' && !record.payload.outcome)) throw new Error('invalid');
    } catch { throw new Error('RECOVERY_OPERATION_RECORD_INVALID'); }
    if (canonical(record.payload.binding) !== canonical(binding)) throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
    return record.payload;
  }
  async function publish(binding: Binding, kind: RecordPayload['kind'], outcome?: RecoveryOperationOutcome) {
    const payload: RecordPayload = { kind, binding, ...(outcome ? { outcome } : {}) };
    const signature = await options.authority.sign(Buffer.from(canonical(payload)));
    if (!await options.authority.verify(Buffer.from(canonical(payload)), signature, options.authority.keyId)) throw new Error('RECOVERY_OPERATION_RECORD_INVALID');
    const temporary = await containedPath(options.root, `.operation-${randomUUID()}`);
    await durableJson(temporary, { payload, keyId: options.authority.keyId, signature });
    try {
      try { await link(temporary, await path(binding, kind)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
      await syncDirectory(options.root);
      return true;
    } finally { await unlink(temporary); }
  }
  async function status(binding: Binding): Promise<RecoveryOperationStatus> {
    // Read newest publication first so concurrent forward progress cannot look like a missing predecessor.
    const terminal = await readRecord(binding, 'terminal');
    const claim = await readRecord(binding, 'claim');
    const reservation = await readRecord(binding, 'reservation');
    if ((!reservation && (claim || terminal)) || (terminal && !claim)) throw new Error('RECOVERY_OPERATION_RECORD_INVALID');
    if (terminal) {
      if (binding.request.mode === 'backup') {
        const backup = options.targets[binding.request.targetId].backup!;
        const set = await verifyRecoverySet(await containedPath(backup.options.root, backup.scope.setId),
          backup.options.authority, backup.scope.versionLocks, backup.options.readDatabase);
        if (set.manifest.setId !== backup.scope.setId || set.manifestHash !== terminal.outcome!.manifestHash) {
          throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
        }
      } else {
        const outcome = terminal.outcome!;
        const receipt = outcome.receipt;
        if (outcome.manifestHash !== binding.request.manifestHash || receipt?.manifestHash !== outcome.manifestHash
          || receipt?.setId !== options.targets[binding.request.targetId].backup!.scope.setId || receipt?.mode !== 'drill') {
          throw new Error('RECOVERY_OPERATION_BINDING_MISMATCH');
        }
      }
      return { status: 'completed', outcome: terminal.outcome! };
    }
    if (claim) return { status: 'running_or_uncertain' };
    return { status: reservation ? 'reserved' : 'absent' };
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
