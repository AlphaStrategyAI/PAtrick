import { createPublicKey, verify } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync,
  realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { canonicalize, readRegularFile, sha256 } from '../lib/release.mjs';
import { deriveRuntimeStaging, leased, verifyEmittedRuntimeCandidate, withPublishedDeployment } from '../lib/emitted-release.mjs';
import type { AdmittedDeployment, DarwinTarget, EmittedReleaseExpectation, EmittedReleaseTrustPolicy, ExclusiveRuntimeStaging, RuntimeLease } from '../lib/emitted-release.mjs';
import { bindRegistration, projectIdentity, type HostIdentity } from '../lib/doctor.mjs';
import { isLifecycleRecordName } from './lifecycle-journal.js';

type Lease = RuntimeLease;

const format = 'patrick-installed-selection-v1' as const;
const maxRecords = 4096;
const maxInstallJournalFiles = 3;
const recordLimit = 8 * 1024;
const dataFiles = ['service.sqlite', 'answers.sqlite'] as const;
export const autoloopHubDatabase = 'hub.db';
export const legacyHubDatabase = 'hub.sqlite';
const dataDirectories = ['credentials', 'blobs', 'projections'] as const;
const storeDirectories = ['releases', 'packages', 'data', 'history'] as const;
type DataRole = typeof dataFiles[number] | typeof dataDirectories[number];
type Store = typeof storeDirectories[number];
type HubDatabaseRole = typeof autoloopHubDatabase | typeof legacyHubDatabase;

/** Provisioned outside the selected release. IDs are decimal strings from bigint lstat. */
export type GenerationNode = { device: string; inode: string; birthtimeNs: string };
export type InstalledGeneration = {
  id: string; schema: number; packageSha256: string;
  releaseRoot: GenerationNode; dataRoot: GenerationNode;
  roles: Record<DataRole, GenerationNode> & (
    Record<typeof autoloopHubDatabase, GenerationNode> & Partial<Record<typeof legacyHubDatabase, never>> |
    Record<typeof legacyHubDatabase, GenerationNode> & Partial<Record<typeof autoloopHubDatabase, never>>
  );
};
export type GenerationEnrollment = {
  installationId: string; hostId: string; identity: HostIdentity; target: DarwinTarget;
  root: string; rootNode: GenerationNode; stores: Record<Store, GenerationNode>;
  publicKey: string;
  releases: { expected: EmittedReleaseExpectation; policy: EmittedReleaseTrustPolicy }[];
  generations: InstalledGeneration[];
};
export type GenerationOrder = {
  format: typeof format; installationSha256: string; operationId: string;
  previous: string | null; generation: InstalledGeneration;
};
export type SignedGenerationOrder = { order: GenerationOrder; signature: string };
export type GenerationRecordSigner = { signRecord(bytes: Uint8Array): Promise<string> };
type RecordBody = { format: 'patrick-installed-selection-record-v1'; authorization: SignedGenerationOrder; node: GenerationNode };
type Entry = { order: GenerationOrder; sha256: string };
type UseConfirmation<T> = (current: Entry, deployment: AdmittedDeployment, guard: () => void) => Promise<T>;
/** current is the observed pointer. Any pending entry forbids a successor, including when
 * the new pointer is visible but its directory flush has no authenticated confirmation. */
type State = { current: Entry | null; pending: Entry | null; historical: Entry | null };

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error('GENERATION_BINDING_INVALID');
}

export function generationHubDatabase(roles: InstalledGeneration['roles']): HubDatabaseRole {
  return Object.hasOwn(roles, autoloopHubDatabase) ? autoloopHubDatabase : legacyHubDatabase;
}
function token(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value));
}
// Capture only data-backed methods and the complete lookup chain. Rechecking
// descriptors must never invoke an accessor installed while an operation waits.
function captureMethod<T extends object, K extends keyof T>(object: T, key: K) {
  requireValue(object && (typeof object === 'object' || typeof object === 'function'));
  const chain: Array<{ object: object; prototype: object | null }> = [];
  let descriptor: PropertyDescriptor | undefined;
  for (let current: object | null = object; current; current = Object.getPrototypeOf(current)) {
    chain.push({ object: current, prototype: Object.getPrototypeOf(current) });
    descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) break;
  }
  requireValue(descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function');
  const initial = descriptor;
  const value = initial.value as T[K];
  return { value, validate() {
    for (let index = 0; index < chain.length; index++) {
      const item = chain[index]!;
      requireValue(Object.getPrototypeOf(item.object) === item.prototype);
      const current = Object.getOwnPropertyDescriptor(item.object, key);
      if (index < chain.length - 1) requireValue(!current);
      else requireValue(current && Object.hasOwn(current, 'value') && Object.is(current.value, value) &&
        current.configurable === initial.configurable && current.enumerable === initial.enumerable && current.writable === initial.writable);
    }
  } };
}
function hash(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
}
const bytes = (value: unknown) => Buffer.from(canonicalize(value));
const digest = (value: unknown) => sha256(bytes(value));
const stat = (path: string) => lstatSync(path, { bigint: true });
const pin = (info: ReturnType<typeof stat>): GenerationNode => ({
  device: String(info.dev), inode: String(info.ino), birthtimeNs: String(info.birthtimeNs),
});
function checkNode(path: string, expected: GenerationNode, directory: boolean) {
  const info = stat(path);
  requireValue(realpathSync.native(path) === path && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1n) &&
    info.uid === BigInt(process.geteuid!()) && (info.mode & 0o022n) === 0n &&
    canonicalize(pin(info)) === canonicalize(expected));
  return info;
}
function syncDirectory(path: string, expected: GenerationNode) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    requireValue(canonicalize(pin(fstatSync(fd, { bigint: true }))) === canonicalize(expected));
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function canRestoreOldRelease(input: {
  snapshotVerified: unknown; writerStopped: unknown; writesSinceSwitch: unknown;
}): boolean {
  return input.snapshotVerified === true && input.writerStopped === true && input.writesSinceSwitch === 0;
}

/**
 * Installed-controller construction only. The separately registered owner must exclude
 * all writers/renames to this physical root and its ancestry until callback completion.
 * Registration and release policy never come from the command, pointer or selected tree.
 * The controller signs an exact order only after its command claim and applicable
 * migration, snapshot, role stop and witness checks. This storage API does no admission.
 */
function generationStorage(registration: GenerationEnrollment, owner: ExclusiveRuntimeStaging, signer?: GenerationRecordSigner) {
  const binding = bindRegistration(() => registration);
  const e = binding.value;
  const ownerMethod = captureMethod(owner, 'withExclusiveReadRoot');
  const signerMethod = signer === undefined ? undefined : captureMethod(signer, 'signRecord');
  const registeredSign = signerMethod?.value;
  function enrolled() {
    binding.validate();
    ownerMethod.validate();
    signerMethod?.validate();
  }
  enrolled();
  const key = createPublicKey(e.publicKey);
  requireValue(key.asymmetricKeyType === 'ed25519' && e.root !== sep && resolve(e.root) === e.root);
  token(e.installationId);
  token(e.hostId);
  const identity = projectIdentity(e.identity);
  requireValue(canonicalize(identity) === canonicalize(e.identity) && e.target.os === 'darwin' && ['arm64', 'x64'].includes(e.target.arch));
  const installationSha256 = digest({ format, installationId: e.installationId, hostId: e.hostId, identity,
    target: e.target, root: e.root, rootNode: e.rootNode, stores: e.stores,
    publicKeySha256: sha256(key.export({ format: 'der', type: 'spki' })) });
  const releases = new Map(e.releases.map(release => [release.expected.packageSha256, release]));
  const generations = new Map(e.generations.map(g => [g.id, g]));
  requireValue(releases.size === e.releases.length && new Set(e.generations.map(g => g.id.toLowerCase())).size === e.generations.length);
  const dataNodes = new Set<string>();
  for (const g of generations.values()) {
    token(g.id);
    hash(g.packageSha256);
    const r = releases.get(g.packageSha256)?.expected;
    requireValue(r?.profile === 'deployment-complete' && canonicalize(r.target) === canonicalize(e.target) &&
      Number.isSafeInteger(g.schema) && g.schema >= r.schema.min && g.schema <= r.schema.max);
    const hubName = generationHubDatabase(g.roles);
    requireValue(canonicalize(Object.keys(g.roles).sort()) === canonicalize([...dataFiles, hubName, ...dataDirectories].sort()));
    for (const node of [g.dataRoot, ...Object.values(g.roles)]) {
      const id = canonicalize(node);
      requireValue(!dataNodes.has(id));
      dataNodes.add(id);
    }
  }

  function order(operationId: string, previous: string | null, generationId: string): GenerationOrder {
    enrolled();
    token(operationId);
    if (previous !== null) hash(previous);
    const generation = generations.get(generationId);
    requireValue(generation);
    return { format, installationSha256, operationId, previous, generation: structuredClone(generation) };
  }
  function signatureValid(payload: Buffer, signature: string) {
    return typeof signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(signature) &&
      Buffer.from(signature, 'base64').toString('base64') === signature && verify(null, payload, key, Buffer.from(signature, 'base64'));
  }
  function authenticate(signed: SignedGenerationOrder): Entry {
    const { operationId, previous, generation } = signed.order;
    const exact = order(operationId, previous, generation.id);
    const payload = bytes(exact);
    requireValue(canonicalize(signed.order) === payload.toString() && signatureValid(payload, signed.signature) &&
      canonicalize(signed) === canonicalize({ order: exact, signature: signed.signature }) && bytes(signed).length <= recordLimit);
    return { order: exact, sha256: sha256(payload) };
  }
  function boundary(lease: Lease) {
    enrolled();
    lease.guard();
    requireValue(lease.root === e.root);
    checkNode(e.root, e.rootNode, true);
    for (const name of storeDirectories) checkNode(join(e.root, name), e.stores[name], true);
    requireValue(e.rootNode.device === e.stores.history.device);
  }
  function physical(g: InstalledGeneration) {
    checkNode(join(e.root, 'releases', g.packageSha256), g.releaseRoot, true);
    const path = join(e.root, 'data', g.id);
    checkNode(path, g.dataRoot, true);
    const hubName = generationHubDatabase(g.roles);
    const alternate = hubName === autoloopHubDatabase ? legacyHubDatabase : autoloopHubDatabase;
    requireValue(!lstatSync(join(path, alternate), { throwIfNoEntry: false }));
    checkNode(join(path, hubName), g.roles[hubName]!, false);
    for (const name of dataFiles) checkNode(join(path, name), g.roles[name], false);
    for (const name of dataDirectories) checkNode(join(path, name), g.roles[name], true);
  }
  async function withGeneration<T>(lease: Lease, g: InstalledGeneration, use: (deployment: AdmittedDeployment) => Promise<T>) {
    boundary(lease);
    requireValue(process.platform === e.target.os && process.arch === e.target.arch);
    physical(g);
    const release = releases.get(g.packageSha256)!;
    // Borrow the already-held outer owner. Both verifier calls see the same
    // private port. They cannot re-enter or acquire a different native lock.
    const staging = deriveRuntimeStaging(lease, lease.root);
    const receipt = await verifyEmittedRuntimeCandidate(join(e.root, 'packages', g.packageSha256 + '.json'), {
      staging, expected: release.expected, policy: release.policy,
    });
    boundary(lease);
    return withPublishedDeployment(receipt, { staging, releasesRoot: join(e.root, 'releases') }, async installed => {
      requireValue(installed.packageSha256 === g.packageSha256 && installed.root === join(e.root, 'releases', g.packageSha256));
      boundary(lease);
      physical(g);
      try { return await use(installed); } finally { boundary(lease); physical(g); }
    });
  }
  const history = join(e.root, 'history');
  const currentPath = join(e.root, 'current');
  function completionBytes(entry: Entry, selected: GenerationNode) {
    return bytes({ format: 'patrick-installed-owner-flush-v1', installationSha256, operationId: entry.order.operationId,
      orderSha256: entry.sha256, selected });
  }
  function uncertain(operationId: string) {
    return Object.assign(new Error('GENERATION_SELECTION_UNCERTAIN'), { code: 'GENERATION_SELECTION_UNCERTAIN', operationId });
  }
  function selectionHistory() {
    const entries = readdirSync(history, { withFileTypes: true });
    requireValue(entries.length <= maxRecords * 2 + maxInstallJournalFiles);
    const selection = entries.filter(entry => !entry.isFile() || !isLifecycleRecordName(entry.name));
    requireValue(selection.length <= maxRecords * 2);
    return selection.map(entry => entry.name);
  }
  async function readState(lease: Lease, operationId?: string, unusedGeneration?: string, ownedScratch?: GenerationNode): Promise<State> {
    boundary(lease);
    const entries = selectionHistory();
    const names = entries.filter(name => name.endsWith('.json'));
    requireValue(names.length <= maxRecords);
    const completions = new Map<string, { path: string; signature: string }>();
    for (const name of entries) {
      if (name.endsWith('.json')) continue;
      const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.([a-f0-9]{128})\.durable$/.exec(name);
      requireValue(match && !completions.has(match[1]));
      completions.set(match[1], { path: join(history, name), signature: Buffer.from(match[2], 'hex').toString('base64') });
    }
    const children = new Map<string | null, Entry>();
    const usedGenerations = new Set<string>();
    const nodes = new Map<string, ReturnType<typeof stat>>();
    let historical: Entry | null = null;
    for (const name of names) {
      requireValue(name.endsWith('.json'));
      const id = name.slice(0, -5);
      token(id);
      if (operationId?.toLowerCase() === id.toLowerCase()) requireValue(operationId === id);
      const path = join(history, name);
      const info = stat(path);
      requireValue(realpathSync.native(path) === path && info.isFile() && info.uid === BigInt(process.geteuid!()) &&
        (info.mode & 0o7777n) === 0o600n && info.nlink >= 1n && info.nlink <= 3n);
      const raw = await readRegularFile(path, recordLimit, { root: e.root, validate: () => boundary(lease) });
      boundary(lease);
      const stored = JSON.parse(raw.toString()) as { body: RecordBody; signature: string };
      const record = authenticate(stored.body.authorization);
      const body: RecordBody = { format: 'patrick-installed-selection-record-v1', authorization: stored.body.authorization, node: pin(info) };
      requireValue(signatureValid(bytes(body), stored.signature) && raw.equals(bytes({ body, signature: stored.signature })) && id === record.order.operationId &&
        record.order.generation.id !== unusedGeneration && !children.has(record.order.previous) && !usedGenerations.has(record.order.generation.id));
      const completion = completions.get(id);
      if (completion) {
        const link = stat(completion.path);
        requireValue(realpathSync.native(completion.path) === completion.path && link.dev === info.dev && link.ino === info.ino &&
          signatureValid(completionBytes(record, pin(info)), completion.signature));
      }
      nodes.set(id, info);
      children.set(record.order.previous, record);
      usedGenerations.add(record.order.generation.id);
      if (id === operationId) historical = record;
    }
    for (const id of completions.keys()) requireValue(nodes.has(id));
    const chain: Entry[] = [];
    let predecessor: string | null = null;
    for (let i = 0; i < names.length; i++) {
      const entry = children.get(predecessor);
      requireValue(entry);
      chain.push(entry);
      predecessor = entry.sha256;
    }
    const tail = chain.at(-1) ?? null;
    const prior = chain.at(-2) ?? null;
    const observed = lstatSync(currentPath, { bigint: true, throwIfNoEntry: false });
    let current: Entry | null = null;
    if (observed) {
      requireValue(observed.isFile() && realpathSync.native(currentPath) === currentPath);
      // Current must be the very same inode as its authenticated retained record.
      for (const candidate of [tail, prior]) {
        if (!candidate) continue;
        const retained = nodes.get(candidate.order.operationId)!;
        if (retained.dev === observed.dev && retained.ino === observed.ino) current = candidate;
      }
      requireValue(current);
    } else requireValue(!prior);
    const pending = tail && !completions.has(tail.order.operationId) ? tail : null;
    // A confirmed tail must still own current. Earlier entries must have their
    // original completed links before a subsequent selection can be accepted.
    requireValue(pending || current === tail);
    for (const entry of chain) {
      const id = entry.order.operationId;
      const completed = completions.has(id);
      requireValue(completed || entry === pending);
      const info = nodes.get(id)!;
      const links = 1n + BigInt(completed) + BigInt(entry === current);
      if (entry === pending && entry !== current && info.nlink === links + 1n) {
        const scratch = stat(join(e.root, '.selection-' + id));
        requireValue(scratch.dev === info.dev && scratch.ino === info.ino);
      } else requireValue(info.nlink === links);
    }
    // A create may have succeeded even when its acknowledgement was lost.  A
    // scratch without its authenticated history link is not evidence of absence,
    // and it must block *all* later selections, not just the same operation ID.
    for (const name of readdirSync(e.root)) {
      if (!name.toLowerCase().startsWith('.selection-')) continue;
      const id = name.slice('.selection-'.length);
      if (name !== '.selection-' + id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) {
        throw uncertain(operationId ?? 'unknown');
      }
      const scratchPath = join(e.root, name);
      const scratch = lstatSync(scratchPath, { bigint: true, throwIfNoEntry: false });
      if (!scratch) throw uncertain(id);
      if (pending?.order.operationId === id) {
        const retained = nodes.get(id)!;
        if (scratch.dev !== retained.dev || scratch.ino !== retained.ino) throw uncertain(id);
      } else if (id === operationId && ownedScratch) {
        checkNode(scratchPath, ownedScratch, false);
      } else throw uncertain(id);
    }
    boundary(lease);
    return { current, pending, historical: historical === pending ? null : historical };
  }
  async function verifyObservation(lease: Lease, state: State, operationId?: string) {
    for (const entry of new Set([state.current, state.pending, state.historical])) {
      if (entry) await withGeneration(lease, entry.order.generation, async () => {});
      boundary(lease);
    }
    const observed = await readState(lease, operationId);
    boundary(lease);
    requireValue(canonicalize(observed) === canonicalize(state));
    return state;
  }
  async function observe(operationId?: string) {
    if (operationId !== undefined) token(operationId);
    enrolled();
    const result = await leased(owner, async lease => verifyObservation(lease, await readState(lease, operationId), operationId), true, enrolled);
    enrolled();
    return result;
  }
  async function useConfirmed<T>(use: UseConfirmation<T>) {
    return leased(owner, async lease => {
      const state = await readState(lease);
      const current = state.current;
      if (!current || state.pending) throw new Error('INSTALLED_ROLE_SELECTION_REQUIRED');
      const generation = current.order.generation;
      const selectedSha256 = current.sha256;
      return withGeneration(lease, generation, async deployment => {
        function guard() {
          boundary(lease);
          physical(generation);
        }
        async function assertCurrent() {
          guard();
          const observed = await readState(lease);
          guard();
          if (observed.current?.sha256 !== selectedSha256 || observed.pending) {
            throw new Error('INSTALLED_ROLE_SELECTION_REQUIRED');
          }
        }
        await assertCurrent();
        const result = await use(structuredClone(current), deployment, guard);
        await assertCurrent();
        return result;
      });
    }, true, enrolled);
  }
  async function select(envelope: string) {
    enrolled();
    requireValue(typeof envelope === 'string' && Buffer.byteLength(envelope) <= recordLimit);
    const signed = JSON.parse(envelope) as SignedGenerationOrder;
    requireValue(canonicalize(signed) === envelope);
    const next = authenticate(signed);
    const id = next.order.operationId;
    let attempted = false;
    try {
      const result = await leased(owner, async lease => {
        const state = await readState(lease, id);
        boundary(lease);
        if (state.pending?.sha256 === next.sha256) throw uncertain(id);
        if (state.historical) {
          requireValue(state.historical.sha256 === next.sha256);
          return verifyObservation(lease, state, id);
        }
        requireValue(!state.pending && (state.current?.sha256 ?? null) === next.order.previous);
        requireValue(selectionHistory().filter(name => name.endsWith('.json')).length < maxRecords);
        if (state.current) { await withGeneration(lease, state.current.order.generation, async () => {}); boundary(lease); }
        return withGeneration(lease, next.order.generation, async () => {
          const before = await readState(lease, id, next.order.generation.id);
          boundary(lease);
          requireValue(canonicalize(before) === canonicalize(state));
          const stage = join(e.root, '.selection-' + id);
          const record = join(history, id + '.json');
          requireValue(signer && registeredSign);
          attempted = true;
          const fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          try {
            const node = pin(fstatSync(fd, { bigint: true }));
            const body: RecordBody = { format: 'patrick-installed-selection-record-v1', authorization: signed, node };
            const signature = await Reflect.apply(registeredSign, signer, [bytes(body)]);
            boundary(lease);
            const envelope = bytes({ body, signature });
            requireValue(signatureValid(bytes(body), signature) && envelope.length <= recordLimit);
            const confirmed = await readState(lease, id, next.order.generation.id, node);
            boundary(lease);
            requireValue(canonicalize(confirmed) === canonicalize(state));
            checkNode(stage, node, false);
            writeFileSync(fd, envelope);
            fsyncSync(fd);
          } finally { closeSync(fd); }
          boundary(lease);
          linkSync(stage, record);
          syncDirectory(history, e.stores.history);
          // After this point the record forbids a second attempt even on restart.
          renameSync(stage, currentPath);
          syncDirectory(e.root, e.rootNode);
          // Only a successful owner fsync can issue this signature. Its create-only
          // history name is a third link to the same authenticated inode. A visible
          // signature proves the earlier pointer barrier even if the final history
          // flush loses its acknowledgement. Disappearance of the link fails closed.
          const visible = await readState(lease, id);
          boundary(lease);
          requireValue(visible.current?.sha256 === next.sha256 && visible.pending?.sha256 === next.sha256);
          const selected = pin(stat(currentPath));
          const payload = completionBytes(next, selected);
          const signature = await Reflect.apply(registeredSign, signer, [payload]);
          boundary(lease);
          const confirmed = await readState(lease, id);
          boundary(lease);
          requireValue(signatureValid(payload, signature) && canonicalize(confirmed) === canonicalize(visible));
          requireValue(canonicalize(pin(stat(currentPath))) === canonicalize(selected));
          boundary(lease);
          linkSync(currentPath, join(history, id + '.' + Buffer.from(signature, 'base64').toString('hex') + '.durable'));
          syncDirectory(history, e.stores.history);
          const observed = await readState(lease, id);
          boundary(lease);
          requireValue(observed.current?.sha256 === next.sha256 && !observed.pending);
          return observed;
        });
      }, true, enrolled);
      enrolled();
      return result;
    } catch (error) {
      if (attempted) throw uncertain(id);
      throw error;
    }
  }
  return Object.freeze({ order, observe, select, useConfirmed });
}

export function createGenerationStore(registration: GenerationEnrollment, owner: ExclusiveRuntimeStaging, signer: GenerationRecordSigner) {
  requireValue(signer && (typeof signer === 'object' || typeof signer === 'function'));
  return generationStorage(registration, owner, signer);
}

/** Public-only restart surface. The controller provisions read-only filesystem access for this process. */
export function createGenerationReader(registration: GenerationEnrollment, owner: ExclusiveRuntimeStaging) {
  const { observe } = generationStorage(registration, owner);
  return Object.freeze({ observe });
}

export function withConfirmedGeneration<T>(registration: GenerationEnrollment, owner: ExclusiveRuntimeStaging,
  use: UseConfirmation<T>): Promise<T> {
  return generationStorage(registration, owner).useConfirmed(use);
}
