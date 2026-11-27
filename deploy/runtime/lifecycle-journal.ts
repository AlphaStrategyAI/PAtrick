import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { canonical, digest } from '../../packages/host/src/recovery/files.ts';
import type { RecoveryJournalRoot } from '../../packages/host/src/recovery/operations.js';
import type { RecoveryManifestAuthority } from '../../packages/host/src/recovery/types.js';
import { bindRegistration, projectIdentity, type HostIdentity } from '../lib/doctor.mjs';

const commands = ['init', 'install', 'start', 'stop', 'upgrade', 'uninstall'] as const;
type Command = typeof commands[number];
export type LifecycleRequest = {
  operationId: string; command: Command; targetId: string; planSha256: string; expectedGeneration: string | null;
};
type Plan = Omit<LifecycleRequest, 'operationId'> & { nextGeneration: string | null; releaseSha256: string | null };
type Binding = {
  protocol: 'patrick-installed-lifecycle-v1'; operationId: string; root: RecoveryJournalRoot;
  identity: HostIdentity & { installationId: string }; plan: Plan; journalKeyId: string; evidenceVersion: string;
};
export type LifecycleEvidenceSubject = { binding: Binding; claimSha256: string };
export type LifecycleReceipt = { evidenceId: string; claimSha256: string; evidenceSha256: string };
/** The installed controller selects this registration independently of command input.
 * planSha256 is its digest of the validated, normalized command plan. Its controlled
 * journal ancestry and append-only records must be protected from third-party writers.
 * observe reads proof for this exact operation and claim, including historical readback.
 */
export type LifecycleRegistration = {
  root: RecoveryJournalRoot; identity: Binding['identity']; plan: Plan;
  authority: Pick<RecoveryManifestAuthority, 'keyId' | 'verify'>;
  evidence: { version: string; observe(subject: LifecycleEvidenceSubject, evidenceId: string): Promise<LifecycleReceipt> };
};
type Signer = Pick<RecoveryManifestAuthority, 'sign'>;
export type LifecycleStatus = { status: 'absent' | 'reserved' | 'running_or_uncertain' }
  | { status: 'completed'; receipt: LifecycleReceipt };
declare const owner: unique symbol;
export type LifecycleClaimToken = { readonly [owner]: true };
type ClaimResult = LifecycleStatus | { status: 'claimed'; token: LifecycleClaimToken; subject: LifecycleEvidenceSubject };
const recordPrefix = 'lifecycle-v1';
const recordKinds = ['reservation', 'claim', 'terminal'] as const;
type Kind = typeof recordKinds[number];
type Payload = { kind: Kind; binding: Binding; nonce: string; parentSha256: string | null; receipt?: LifecycleReceipt };
type Observed = { dev: number; ino: number; bytes: Buffer; sha256: string };
const maxBytes = 32 * 1024;
const boundedName = (value: unknown): value is string => typeof value === 'string' && value.length <= 80
  && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && value.length === 64;
const generation = (value: unknown) => value === null || boundedName(value);

export function lifecycleRecordName(operationId: string, kind: Kind) {
  requireState(boundedName(operationId), 'REQUEST');
  return `${recordPrefix}.${operationId}.${kind}.json`;
}

export function isLifecycleRecordName(name: string) {
  const [prefix, operationId, kind, extension, ...extra] = name.split('.');
  return prefix === recordPrefix && boundedName(operationId) && recordKinds.some(value => value === kind)
    && extension === 'json' && extra.length === 0;
}

function requireState(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`LIFECYCLE_JOURNAL_${code}`);
}
function exactKeys(value: unknown, keys: string[]) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function checkedRequest(input: LifecycleRequest) {
  requireState(exactKeys(input, ['operationId', 'command', 'targetId', 'expectedGeneration', 'planSha256']), 'REQUEST');
  const request = { ...input };
  requireState(boundedName(request.operationId) && commands.includes(request.command) && boundedName(request.targetId)
    && generation(request.expectedGeneration) && hash(request.planSha256), 'REQUEST');
  return request;
}
function checkRoot(root: RecoveryJournalRoot) {
  requireState(typeof root.path === 'string' && root.path.length <= 4096 && isAbsolute(root.path)
    && resolve(root.path) === root.path && parse(root.path).root !== root.path
    && realpathSync.native(root.path) === root.path, 'ROOT');
  const stat = lstatSync(root.path);
  requireState(stat.isDirectory() && stat.dev === root.device && stat.ino === root.inode
    && (stat.mode & 0o022) === 0 && (stat.uid === process.geteuid?.() || stat.uid === 0), 'ROOT');
}
function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }) {
  return left.dev === right.dev && left.ino === right.ino;
}
function readEntry(path: string): Observed | undefined {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    requireState(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, 'RECORD');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break;
      size += count;
    }
    const named = lstatSync(path);
    requireState(size === stat.size && named.isFile() && sameFile(named, stat)
      && named.size === size && named.mtimeMs === stat.mtimeMs, 'RECORD');
    const content = bytes.subarray(0, size);
    return { dev: stat.dev, ino: stat.ino, bytes: content, sha256: digest(content) };
  } finally { closeSync(fd); }
}
function receiptFor(value: LifecycleReceipt, claimSha256: string, evidenceId?: string): LifecycleReceipt {
  requireState(exactKeys(value, ['evidenceId', 'claimSha256', 'evidenceSha256']), 'EVIDENCE');
  const receipt = { ...value };
  requireState(boundedName(receipt.evidenceId) && (!evidenceId || receipt.evidenceId === evidenceId)
    && receipt.claimSha256 === claimSha256 && hash(receipt.evidenceSha256), 'EVIDENCE');
  return receipt;
}

function enrollment(current: () => LifecycleRegistration) {
  const original = current();
  const registered = bindRegistration(() => original);
  const { identity, plan, authority, evidence } = registered.value;
  const root = { ...registered.value.root };
  requireState(exactKeys(root, ['path', 'device', 'inode']) && Number.isSafeInteger(root.device) && Number.isSafeInteger(root.inode)
    && exactKeys(plan, ['command', 'targetId', 'expectedGeneration', 'nextGeneration', 'releaseSha256', 'planSha256']), 'ENROLLMENT');
  requireState(exactKeys(original, ['root', 'identity', 'plan', 'authority', 'evidence'])
    && exactKeys(original.root, ['path', 'device', 'inode'])
    && exactKeys(original.identity, ['installationId', 'accountId', 'scopeId', 'deviceId', 'configRevision', 'domains']), 'ENROLLMENT');
  const verifier = original.authority;
  const evidenceReader = original.evidence;
  const verify = verifier.verify;
  const observe = evidenceReader.observe;
  requireState(typeof verify === 'function' && typeof observe === 'function' && boundedName(authority.keyId)
    && boundedName(evidence.version) && boundedName(identity.installationId), 'ENROLLMENT');
  const trustedIdentity = { ...projectIdentity(identity), installationId: identity.installationId };
  trustedIdentity.domains.sort();
  const { command, targetId, expectedGeneration, nextGeneration, releaseSha256, planSha256 } = plan;
  const trustedPlan = { command, targetId, expectedGeneration, nextGeneration, releaseSha256, planSha256 };
  requireState(commands.includes(command) && boundedName(targetId) && hash(planSha256) && generation(expectedGeneration)
    && generation(nextGeneration) && (hash(releaseSha256) || (releaseSha256 === null && command !== 'install' && command !== 'upgrade')), 'ENROLLMENT');
  const keyId = authority.keyId;
  const version = evidence.version;
  let revoked = false;
  function validate() {
    revoked ||= current() !== original;
    requireState(!revoked, 'ENROLLMENT');
    registered.validate();
    requireState(original.authority === verifier && verifier.verify === verify && verifier.keyId === keyId
      && original.evidence === evidenceReader && evidenceReader.observe === observe && evidenceReader.version === version, 'ENROLLMENT');
    checkRoot(root);
  }
  function bind(input: LifecycleRequest): Binding {
    const request = checkedRequest(input);
    validate();
    requireState(request.command === command && request.targetId === targetId && request.planSha256 === planSha256
      && request.expectedGeneration === expectedGeneration, 'BINDING');
    return { protocol: 'patrick-installed-lifecycle-v1', operationId: request.operationId,
      root: { path: root.path, device: root.device, inode: root.inode }, identity: trustedIdentity, plan: trustedPlan,
      journalKeyId: keyId, evidenceVersion: version };
  }
  function path(binding: Binding, kind: Kind) {
    return join(root.path, lifecycleRecordName(binding.operationId, kind));
  }
  async function authenticate(record: Observed, binding: Binding, kind: Kind, parent: string | null): Promise<Payload> {
    const envelope = JSON.parse(record.bytes.toString('utf8'));
    requireState(exactKeys(envelope, ['keyId', 'signature', 'payload']) && envelope.keyId === keyId
      && typeof envelope.signature === 'string' && envelope.signature.length > 0 && envelope.signature.length <= 4096, 'RECORD');
    const payload: Payload = envelope.payload;
    requireState(exactKeys(payload, ['kind', 'binding', 'nonce', 'parentSha256', ...(kind === 'terminal' ? ['receipt'] : [])])
      && payload.kind === kind && boundedName(payload.nonce) && payload.parentSha256 === parent, 'RECORD');
    requireState(canonical(payload.binding) === canonical(binding), 'BINDING');
    requireState(record.bytes.equals(Buffer.from(canonical(envelope)))
      && await verify.call(verifier, Buffer.from(canonical(payload)), envelope.signature, keyId) === true, 'RECORD');
    validate();
    return payload;
  }
  async function proof(subject: LifecycleEvidenceSubject, id: string) {
    requireState(boundedName(id), 'EVIDENCE');
    validate();
    const result = await observe.call(evidenceReader, structuredClone(subject), id);
    validate();
    return receiptFor(result, subject.claimSha256, id);
  }
  async function inspect(binding: Binding) {
    validate();
    // Newest first: a concurrent append cannot appear to lack its predecessor.
    const terminal = readEntry(path(binding, 'terminal'));
    const claim = readEntry(path(binding, 'claim'));
    const reservation = readEntry(path(binding, 'reservation'));
    function confirm() {
      validate();
      for (const [kind, seen] of Object.entries({ reservation, claim, terminal })) {
        if (!seen) continue;
        const actual = readEntry(path(binding, kind as Kind));
        requireState(actual && sameFile(seen, actual) && actual.sha256 === seen.sha256, 'RECORD');
      }
      validate();
    }
    requireState((!terminal || claim) && (!claim || reservation), 'RECORD');
    if (reservation) await authenticate(reservation, binding, 'reservation', null);
    if (claim) await authenticate(claim, binding, 'claim', reservation!.sha256);
    let status: LifecycleStatus = { status: claim ? 'running_or_uncertain' : reservation ? 'reserved' : 'absent' };
    if (terminal) {
      const payload = await authenticate(terminal, binding, 'terminal', claim!.sha256);
      const saved = receiptFor(payload.receipt!, claim!.sha256);
      const observed = await proof({ binding, claimSha256: claim!.sha256 }, saved.evidenceId);
      requireState(canonical(saved) === canonical(observed), 'EVIDENCE');
      status = { status: 'completed', receipt: saved };
    }
    return { status, claim, reservation, terminal, confirm };
  }
  return { bind, inspect, validate, path, proof, verify: verify.bind(verifier),
    async read(request: LifecycleRequest) {
      const observed = await inspect(bind(request));
      observed.confirm();
      return observed.status;
    },
    async readClaim(request: LifecycleRequest): Promise<LifecycleEvidenceSubject | undefined> {
      const binding = bind(request);
      const observed = await inspect(binding);
      observed.confirm();
      if (observed.status.status === 'running_or_uncertain' && observed.claim) {
        return structuredClone({ binding, claimSha256: observed.claim.sha256 });
      }
    } };
}

/** A reconstructed reader requires only public journal verification and independently enrolled evidence readback. */
export function createLifecycleJournalReader(current: () => LifecycleRegistration) {
  const { read, readClaim } = enrollment(current);
  return { read, readClaim };
}

export function createLifecycleJournal(current: () => LifecycleRegistration, signer: Signer) {
  const journal = enrollment(current);
  const sign = signer.sign;
  const owners = new WeakMap<LifecycleClaimToken, LifecycleEvidenceSubject>();

  async function publish(binding: Binding, kind: Kind, previous: Awaited<ReturnType<typeof journal.inspect>>, receipt?: LifecycleReceipt) {
    const parentSha256 = kind === 'reservation' ? null : kind === 'claim' ? previous.reservation!.sha256 : previous.claim!.sha256;
    const payload: Payload = { kind, binding, nonce: randomUUID(), parentSha256, ...(receipt ? { receipt } : {}) };
    const bytes = Buffer.from(canonical(payload));
    requireState(typeof sign === 'function' && signer.sign === sign, 'SIGNER');
    const signature = await sign.call(signer, Buffer.from(bytes));
    requireState(typeof signature === 'string' && signature.length > 0 && signature.length <= 4096
      && await journal.verify(bytes, signature, binding.journalKeyId) === true, 'SIGNER');
    const encoded = Buffer.from(canonical({ payload, keyId: binding.journalKeyId, signature }));
    requireState(encoded.length <= maxBytes, 'RECORD');
    requireState(signer.sign === sign, 'SIGNER');
    previous.confirm();
    const destination = journal.path(binding, kind);
    // An interrupted writer may leave an unreferenced temporary. Never remove a
    // predecessor or repair a broken chain to make a subsequent claim possible.
    if ((kind === 'reservation' && readEntry(journal.path(binding, 'claim')))
      || (kind !== 'terminal' && readEntry(journal.path(binding, 'terminal')))) return undefined;
    const temporary = join(binding.root.path, `.lifecycle-${randomUUID()}`);
    const dir = openSync(binding.root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const rootStat = fstatSync(dir);
      requireState(rootStat.dev === binding.root.device && rootStat.ino === binding.root.inode, 'ROOT');
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, encoded);
        fsyncSync(fd);
        // Read the exact evidence after disk preparation. Recheck all local
        // publication identities after this final call to an independent port.
        if (receipt) {
          const fresh = await journal.proof({ binding, claimSha256: receipt.claimSha256 }, receipt.evidenceId);
          requireState(canonical(fresh) === canonical(receipt), 'EVIDENCE');
        }
        previous.confirm();
        requireState(signer.sign === sign, 'SIGNER');
        const file = fstatSync(fd);
        const prepared = readEntry(temporary);
        requireState(prepared && sameFile(file, prepared) && prepared.bytes.equals(encoded), 'RECORD');
        try { linkSync(temporary, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
          throw error;
        }
        fsyncSync(dir);
        journal.validate();
        requireState(sameFile(file, lstatSync(destination)), 'RECORD');
        return digest(encoded);
      } finally {
        try {
          journal.validate();
          requireState(sameFile(fstatSync(fd), lstatSync(temporary)), 'RECORD');
          unlinkSync(temporary);
        } finally { closeSync(fd); }
      }
    } finally { closeSync(dir); }
  }
  async function checkClaim(subject: LifecycleEvidenceSubject) {
    const before = await journal.inspect(subject.binding);
    before.confirm();
    requireState(signer.sign === sign, 'SIGNER');
    requireState(before.status.status === 'running_or_uncertain' && before.claim?.sha256 === subject.claimSha256, 'OWNER');
    return before;
  }
  return {
    read: journal.read,
    async reserve(request: LifecycleRequest): Promise<LifecycleStatus> {
      const binding = journal.bind(request);
      const before = await journal.inspect(binding);
      before.confirm();
      if (before.status.status !== 'absent') return before.status;
      await publish(binding, 'reservation', before);
      const after = await journal.inspect(binding);
      after.confirm();
      requireState(after.reservation, 'RECORD');
      return after.status;
    },
    async claim(request: LifecycleRequest): Promise<ClaimResult> {
      const binding = journal.bind(request);
      const before = await journal.inspect(binding);
      before.confirm();
      if (before.status.status !== 'reserved') return before.status;
      const published = await publish(binding, 'claim', before);
      const after = await journal.inspect(binding);
      after.confirm();
      requireState(after.claim, 'RECORD');
      if (!published) return after.status;
      requireState(signer.sign === sign, 'SIGNER');
      requireState(after.claim.sha256 === published && after.status.status === 'running_or_uncertain', 'RECORD');
      const subject = { binding, claimSha256: published };
      const token = Object.freeze({}) as LifecycleClaimToken;
      owners.set(token, subject);
      return { status: 'claimed', token, subject: structuredClone(subject) };
    },
    /** Revalidate the existing local claim before a controller step. This cannot reissue a token. */
    async readOwnedClaim(token: LifecycleClaimToken): Promise<LifecycleEvidenceSubject> {
      const subject = owners.get(token);
      requireState(subject, 'OWNER');
      const before = await checkClaim(subject);
      before.confirm();
      requireState(owners.get(token) === subject, 'OWNER');
      return structuredClone(subject);
    },
    async markCompleted(token: LifecycleClaimToken, evidenceId: string): Promise<LifecycleStatus> {
      const subject = owners.get(token);
      requireState(subject, 'OWNER');
      owners.delete(token);
      const before = await checkClaim(subject);
      const receipt = await journal.proof(subject, evidenceId);
      const published = await publish(subject.binding, 'terminal', before, receipt);
      requireState(published, 'OWNER');
      const after = await journal.inspect(subject.binding);
      after.confirm();
      requireState(after.terminal?.sha256 === published && after.status.status === 'completed'
        && canonical(after.status.receipt) === canonical(receipt), 'RECORD');
      return after.status;
    },
    async reconcileCompleted(request: LifecycleRequest, evidenceId: string): Promise<LifecycleStatus> {
      const binding = journal.bind(request);
      const before = await journal.inspect(binding);
      before.confirm();
      if (before.status.status !== 'running_or_uncertain') return before.status;
      const receipt = await journal.proof({ binding, claimSha256: before.claim!.sha256 }, evidenceId);
      const published = await publish(binding, 'terminal', before, receipt);
      const after = await journal.inspect(binding);
      after.confirm();
      requireState((published === undefined || after.terminal?.sha256 === published) && after.status.status === 'completed' &&
        canonical(after.status.receipt) === canonical(receipt), 'RECORD');
      return after.status;
    },
  };
}
