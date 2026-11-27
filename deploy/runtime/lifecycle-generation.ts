import { execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync,
  readFileSync, realpathSync, renameSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, readRegularFile, sha256 } from '../lib/release.mjs';
import { createInstalledRootOwner, deriveRuntimeStaging, leased, publishStagedDeployment, stageVerifiedEmittedRuntime,
  verifyEmittedRuntimeCandidate, withPublishedDeployment } from '../lib/emitted-release.mjs';
import type { AdmittedDeployment, DarwinTarget, EmittedReleaseExpectation, EmittedReleaseTrustPolicy, ExclusiveRuntimeStaging, RuntimeLease } from '../lib/emitted-release.mjs';
import { bindRegistration, projectIdentity, type HostIdentity } from '../lib/doctor.mjs';
import { isLifecycleRecordName } from './lifecycle-journal.js';
import type { createMaintenanceCutReader, MaintenanceCutReadbackRegistration } from './maintenance-readback.js';

type Lease = RuntimeLease;

const format = 'patrick-installed-selection-v1' as const;
const maxRecords = 4096;
const maxInstallJournalFiles = 3;
const recordLimit = 8 * 1024;
const dataFiles = ['service.sqlite', 'answers.sqlite'] as const;
export const serviceDataDirectory = 'service';
export const autoloopHubDirectory = 'hub';
export const autoloopHubDatabase = 'hub/hub.db';
export const flatAutoloopHubDatabase = 'hub.db';
export const legacyHubDatabase = 'hub.sqlite';
const dataDirectories = ['credentials', 'blobs', 'projections'] as const;
const storeDirectories = ['releases', 'packages', 'data', 'history'] as const;
type DataRole = typeof dataFiles[number] | typeof dataDirectories[number];
type Store = typeof storeDirectories[number];
type HubDatabaseRole = typeof autoloopHubDatabase | typeof flatAutoloopHubDatabase | typeof legacyHubDatabase;

/** Provisioned outside the selected release. IDs are decimal strings from bigint lstat. */
export type GenerationNode = { device: string; inode: string; birthtimeNs: string };
export type InstalledGeneration = {
  id: string; schema: number; packageSha256: string;
  releaseRoot: GenerationNode; dataRoot: GenerationNode;
  roles: Record<DataRole, GenerationNode> & Partial<Record<HubDatabaseRole | typeof autoloopHubDirectory |
    typeof serviceDataDirectory, GenerationNode>>;
};
export type GenerationEnrollment = {
  installationId: string; hostId: string; identity: HostIdentity; target: DarwinTarget;
  root: string; rootNode: GenerationNode; stores: Record<Store, GenerationNode>;
  ownerLockNode?: GenerationNode;
  hubOwner?: Readonly<{ uid: number; gid: number }>;
  hubRole?: Readonly<{ rootNode: GenerationNode; lockNode: GenerationNode; writerNode: GenerationNode }>;
  serviceRole?: Readonly<{ uid: number; gid: number; rootNode: GenerationNode; writerNode: GenerationNode; controllerOwned?: true }>;
  publicKey: string;
  releases: { expected: EmittedReleaseExpectation; policy: EmittedReleaseTrustPolicy }[];
  generations: InstalledGeneration[];
};
export type GenerationOrder = {
  format: typeof format; installationSha256: string; operationId: string;
  previous: string | null; generation: InstalledGeneration; hubRoleSha256?: string; serviceRoleSha256?: string;
};
export type SignedGenerationOrder = { order: GenerationOrder; signature: string };
export type GenerationRecordSigner = { signRecord(bytes: Uint8Array): Promise<string> };
export type UpgradePreview = Readonly<{
  installationId: string; currentGenerationId: string; currentSelectionSha256: string; currentPackageSha256: string;
  currentSchema: number; targetSchema: number; packageSha256: string; manifestSha256: string;
  planSha256: string; activationAuthorized: false;
}>;
export type UpgradeReleaseEnrollment = Readonly<{
  enrollment: GenerationEnrollment;
  owner?: ExclusiveRuntimeStaging;
  cut: MaintenanceCutReadbackRegistration;
  targetSchema: number;
  stagingNode: GenerationNode;
}>;
type UpgradeCutPlan = Omit<MaintenanceCutReadbackRegistration['subject'], 'claimSha256' | 'planSha256'>;
type UpgradeCutReader = ReturnType<typeof createMaintenanceCutReader>;
export type UpgradeReleaseReceipt = Readonly<{ packageSha256: string; manifestSha256: string; cutManifestSha256: string }>;
type UpgradePreviewStorage = Readonly<{ dataRoot: string; databasePath: string; credentialDirectory: string }>;
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
  if (Object.hasOwn(roles, autoloopHubDatabase)) return autoloopHubDatabase;
  return Object.hasOwn(roles, flatAutoloopHubDatabase) ? flatAutoloopHubDatabase : legacyHubDatabase;
}
export function generationServiceData(path: string, roles: InstalledGeneration['roles']) {
  return Object.hasOwn(roles, serviceDataDirectory) ? join(path, serviceDataDirectory) : path;
}
export function hubControlRoot(root: string) {
  return join(root, 'runtime', 'hub-control');
}
export function hubWriterFencePath(root: string) {
  return join(hubControlRoot(root), 'writer.sqlite');
}
export function generationHubRoleDigest(enrollment: GenerationEnrollment) {
  if (!enrollment.hubRole) return undefined;
  const owner = enrollment.hubOwner ?? { uid: process.geteuid!(), gid: process.getegid!() };
  return digest({ role: enrollment.hubRole, owner });
}
export function createInstalledHubRoleOwner(root: string, role: NonNullable<GenerationEnrollment['hubRole']>) {
  const runtime = join(root, 'runtime');
  const info = stat(runtime);
  requireValue(realpathSync.native(runtime) === runtime && info.isDirectory() &&
    info.uid === BigInt(process.geteuid!()) && (info.mode & 0o022n) === 0n);
  return createInstalledRootOwner({ root: hubControlRoot(root), rootNode: role.rootNode, lockNode: role.lockNode });
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
function checkNode(path: string, expected: GenerationNode, directory: boolean, owner: number = process.geteuid!()) {
  const info = stat(path);
  requireValue(realpathSync.native(path) === path && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1n) &&
    info.uid === BigInt(owner) && (info.mode & 0o022n) === 0n &&
    canonicalize(pin(info)) === canonicalize(expected));
  return info;
}

function serviceRoleDigest(role: GenerationEnrollment['serviceRole']) {
  if (role === undefined) return undefined;
  const fields = role?.controllerOwned === true ? 'controllerOwned gid rootNode uid writerNode' : 'gid rootNode uid writerNode';
  requireValue(role && Object.keys(role).sort().join(' ') === fields &&
    [role.uid, role.gid].every(value => Number.isInteger(value) && value >= 0 && value <= 0x7fffffff));
  if (role.controllerOwned) requireValue(role.uid > 0 && role.gid > 0);
  for (const node of [role.rootNode, role.writerNode]) {
    requireValue(node && Object.keys(node).sort().join(' ') === 'birthtimeNs device inode' &&
      Object.values(node).every(value => typeof value === 'string' && /^\d{1,32}$/.test(value)));
  }
  return digest(role);
}

function checkControllerWriterPath(root: string, control: string, writer: string) {
  const paths = [writer, control];
  for (let parent = dirname(control); ; parent = dirname(parent)) {
    const info = stat(parent);
    requireValue(info.isDirectory() && info.uid === 0n && realpathSync.native(parent) === parent &&
      ((info.mode & 0o022n) === 0n || (parent !== root && !parent.startsWith(root + sep) && (info.mode & 0o1000n) !== 0n)));
    paths.push(parent);
    if (parent === sep) break;
  }
  requireValue(paths.every(path => Array.from(path).every(character => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  })));
  const permissions = execFileSync('/bin/ls', ['-ldneq', ...paths], {
    env: { LC_ALL: 'C' }, encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024,
  }).trimEnd().split('\n');
  const entries = permissions.filter(line => /^[d-][rwxStTs-]{9}[@+]? +\d+ /.test(line));
  requireValue(entries.length === paths.length && permissions.every(line => entries.includes(line) ||
    /^ +\d+: [a-zA-Z0-9:_-]+ (inherited )?deny [a-z_,]+$/.test(line)));
}

type ServiceWriterEnrollment = Pick<GenerationEnrollment, 'root' | 'rootNode' | 'serviceRole'>;
type ServiceWriterPurpose = 'selection' | 'foreground' | 'other';

export function reserveServiceWriter(enrollment: ServiceWriterEnrollment, purpose: ServiceWriterPurpose) {
  return openServiceWriter(enrollment, purpose);
}

export function reserveControllerServiceSession(enrollment: ServiceWriterEnrollment) {
  const fence = openServiceWriter(enrollment, 'supervisor');
  if (!fence.authorize) throw new Error('INSTALLED_SERVICE_CONTROLLER_REQUIRED');
  return { ...fence, authorize: fence.authorize };
}

function openServiceWriter(enrollment: ServiceWriterEnrollment, purpose: ServiceWriterPurpose | 'supervisor') {
  const binding = bindRegistration(() => enrollment);
  const { root, rootNode, serviceRole: role } = binding.value;
  const roleSha256 = serviceRoleDigest(role);
  const runtime = join(root, 'runtime');
  const control = join(runtime, 'service-control');
  const path = join(control, 'writer.sqlite');
  const activePath = join(control, 'active-session.json');
  if (purpose === 'supervisor' && role?.controllerOwned !== true) throw new Error('INSTALLED_SERVICE_CONTROLLER_REQUIRED');
  if (!role) {
    const guard = () => {
      binding.validate();
      if (lstatSync(control, { throwIfNoEntry: false })) throw new Error('INSTALLED_SERVICE_REGISTRATION_REQUIRED');
    };
    guard();
    return { roleSha256, guard, release() {} };
  }
  const controllerOwned = role.controllerOwned === true;
  const uid = controllerOwned ? 0 : role.uid;
  const gid = controllerOwned ? 0 : role.gid;
  if (controllerOwned) {
    if ((purpose !== 'selection' && purpose !== 'supervisor') || process.platform !== 'darwin' ||
        process.getuid!() !== 0 || process.geteuid!() !== 0) {
      throw new Error('INSTALLED_SERVICE_CONTROLLER_REQUIRED');
    }
  } else {
    if (purpose === 'other') throw new Error('INSTALLED_SERVICE_FOREGROUND_REQUIRED');
    if (process.geteuid!() !== uid) throw new Error('INSTALLED_SERVICE_CROSS_UID_UNSUPPORTED');
    if (purpose === 'foreground' && process.getegid!() !== gid) throw new Error('INSTALLED_SERVICE_REGISTRATION_REQUIRED');
  }
  const checkPath = () => {
    binding.validate();
    checkNode(root, rootNode, true, uid);
    const parent = stat(runtime);
    requireValue(realpathSync.native(runtime) === runtime && parent.isDirectory() &&
      parent.uid === BigInt(uid) && (parent.mode & 0o022n) === 0n);
    const dir = checkNode(control, role.rootNode, true, uid);
    requireValue((dir.mode & 0o7777n) === 0o700n);
    const writer = checkNode(path, role.writerNode, false, uid);
    requireValue(writer.gid === BigInt(gid) && (writer.mode & 0o7777n) === 0o600n);
    if (controllerOwned) checkControllerWriterPath(root, control, path);
  };
  let active: { node: GenerationNode; contents: Buffer } | undefined;
  let issued = false;
  function checkActive() {
    if (!controllerOwned) return;
    if (!active) {
      if (lstatSync(activePath, { throwIfNoEntry: false })) throw new Error('INSTALLED_SERVICE_DRAIN_REQUIRED');
      return;
    }
    const info = checkNode(activePath, active.node, false, 0);
    requireValue((info.mode & 0o7777n) === 0o600n && info.size === BigInt(active.contents.length));
    requireValue(readFileSync(activePath).equals(active.contents));
  }
  let database: DatabaseSync | undefined;
  try {
    checkPath();
    database = new DatabaseSync(path, { timeout: 0 });
    checkPath();
    database.exec('BEGIN IMMEDIATE');
    requireValue(database.prepare('PRAGMA journal_mode').get()?.journal_mode === 'delete' &&
      database.prepare('PRAGMA user_version').get()?.user_version === 1);
    checkPath();
    checkActive();
  } catch (error) {
    database?.close();
    if (error instanceof Error && error.message === 'INSTALLED_SERVICE_DRAIN_REQUIRED') throw error;
    const code = (error as { errcode?: number }).errcode;
    throw new Error(code !== undefined && [5, 6].includes(code & 0xff) ?
      'INSTALLED_SERVICE_WRITER_BUSY' : 'INSTALLED_SERVICE_WRITER_FENCE_INVALID', { cause: error });
  }
  const fence = database;
  function guard() {
    try { checkPath(); checkActive(); requireValue(fence.isTransaction); }
    catch (error) { throw new Error('INSTALLED_SERVICE_WRITER_FENCE_INVALID', { cause: error }); }
  }
  function authorize(selectionSha256: string, session: string) {
    guard();
    requireValue(!issued && /^[a-f0-9]{32}$/.test(session));
    hash(selectionSha256);
    issued = true;
    const contents = bytes({ format: 'patrick-service-session-v1', selectionSha256, session });
    const descriptor = openSync(activePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(descriptor, contents);
      fsyncSync(descriptor);
      active = { contents, node: pin(fstatSync(descriptor, { bigint: true })) };
    } finally { closeSync(descriptor); }
    syncDirectory(control, role!.rootNode);
    guard();
    return () => {
      requireValue(active);
      guard();
      unlinkSync(activePath);
      active = undefined;
      syncDirectory(control, role!.rootNode);
      guard();
    };
  }
  return { roleSha256, guard, release() { fence.close(); }, ...(purpose === 'supervisor' ? { authorize } : {}) };
}

function syncDirectory(path: string, expected: GenerationNode) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    requireValue(canonicalize(pin(fstatSync(fd, { bigint: true }))) === canonicalize(expected));
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function recordUpgradePublication(path: string, contents: Buffer, parent: GenerationNode, guard: () => void) {
  const scratch = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(scratch, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const node = pin(fstatSync(fd, { bigint: true }));
    writeFileSync(fd, contents);
    fsyncSync(fd);
    guard();
    checkNode(scratch, node, false);
    requireValue(!lstatSync(path, { throwIfNoEntry: false }));
    renameSync(scratch, path);
    syncDirectory(dirname(path), parent);
  } finally { closeSync(fd); }
}

export function canRestoreOldRelease(input: {
  snapshotVerified: unknown; writerStopped: unknown; writesSinceSwitch: unknown;
}): boolean {
  return input.snapshotVerified === true && input.writerStopped === true && input.writesSinceSwitch === 0;
}

export function installedUpgradePlanSha256(previewSha256: string, nextGeneration: string, cut: UpgradeCutPlan) {
  hash(previewSha256);
  token(nextGeneration);
  return digest({ format: 'patrick-installed-upgrade-plan-v1', previewSha256, nextGeneration, cut });
}

function describeUpgrade(installationId: string, current: Entry, targetSchema: number,
  candidate: Awaited<ReturnType<typeof verifyEmittedRuntimeCandidate>>): UpgradePreview {
  const generation = current.order.generation;
  const { min, max } = candidate.schema;
  requireValue(generation.schema >= min && Number.isSafeInteger(targetSchema) &&
    targetSchema >= generation.schema && targetSchema <= max);
  const plan = {
    installationId, currentGenerationId: generation.id, currentSelectionSha256: current.sha256,
    currentPackageSha256: generation.packageSha256, currentSchema: generation.schema, targetSchema,
    packageSha256: candidate.packageSha256, manifestSha256: candidate.manifestSha256, activationAuthorized: false as const,
  };
  return { ...plan, planSha256: digest({ format: 'patrick-upgrade-preview-v1', ...plan }) };
}

/**
 * Installed-controller construction only. The separately registered owner must exclude
 * all writers/renames to this physical root and its ancestry until callback completion.
 * Registration and release policy never come from the command, pointer or selected tree.
 * The controller signs an exact order only after its command claim and applicable
 * migration, snapshot, role stop and witness checks. This storage API does no admission.
 */
function generationStorage(registration: GenerationEnrollment, suppliedOwner?: ExclusiveRuntimeStaging, signer?: GenerationRecordSigner,
  validateRegistration?: () => void) {
  const binding = bindRegistration(() => registration);
  const e = binding.value;
  requireValue((suppliedOwner === undefined) !== (e.ownerLockNode === undefined));
  const owner = suppliedOwner ?? createInstalledRootOwner({ root: e.root, rootNode: e.rootNode, lockNode: e.ownerLockNode! });
  const ownerMethod = captureMethod(owner, 'withExclusiveReadRoot');
  const signerMethod = signer === undefined ? undefined : captureMethod(signer, 'signRecord');
  const registeredSign = signerMethod?.value;
  function enrolled() {
    validateRegistration?.();
    binding.validate();
    ownerMethod.validate();
    signerMethod?.validate();
  }
  enrolled();
  const key = createPublicKey(e.publicKey);
  requireValue(key.asymmetricKeyType === 'ed25519' && e.root !== sep && resolve(e.root) === e.root);
  token(e.installationId);
  token(e.hostId);
  if (e.hubOwner !== undefined) {
    requireValue(e.hubRole && canonicalize(Object.keys(e.hubOwner).sort()) === '["gid","uid"]' &&
      [e.hubOwner.uid, e.hubOwner.gid].every(value => Number.isInteger(value) && value > 0 && value <= 0x7fffffff));
  }
  const hubRoleOwner = e.hubRole && createInstalledHubRoleOwner(e.root, e.hubRole);
  const hubRoleSha256 = generationHubRoleDigest(e);
  const serviceRoleSha256 = serviceRoleDigest(e.serviceRole);
  const serviceOwner = e.serviceRole?.controllerOwned ? e.serviceRole : undefined;
  if (serviceOwner) requireValue(serviceOwner.uid !== e.hubOwner?.uid);
  const identity = projectIdentity(e.identity);
  requireValue(canonicalize(identity) === canonicalize(e.identity) && e.target.os === 'darwin' && ['arm64', 'x64'].includes(e.target.arch));
  const installationSha256 = digest({ format, installationId: e.installationId, hostId: e.hostId, identity,
    target: e.target, root: e.root, rootNode: e.rootNode, stores: e.stores,
    ...(e.ownerLockNode === undefined ? {} : { ownerLockNode: e.ownerLockNode }),
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
    const directories = hubName === autoloopHubDatabase ? [...dataDirectories, autoloopHubDirectory] : dataDirectories;
    const nestedService = Object.hasOwn(g.roles, serviceDataDirectory);
    requireValue(!nestedService || serviceOwner);
    const roles = [...dataFiles, hubName, ...directories, ...(nestedService ? [serviceDataDirectory] : [])];
    requireValue(canonicalize(Object.keys(g.roles).sort()) === canonicalize(roles.sort()));
    for (const node of [g.dataRoot, ...Object.values(g.roles)]) {
      const id = canonicalize(node);
      requireValue(!dataNodes.has(id));
      dataNodes.add(id);
    }
  }

  function buildOrder(operationId: string, previous: string | null, generationId: string,
    hubDigest: string | undefined, serviceDigest: string | undefined): GenerationOrder {
    enrolled();
    token(operationId);
    if (previous !== null) hash(previous);
    const generation = generations.get(generationId);
    requireValue(generation);
    if (hubDigest !== undefined) hash(hubDigest);
    if (serviceDigest !== undefined) hash(serviceDigest);
    return { format, installationSha256, operationId, previous, generation: structuredClone(generation),
      ...(hubDigest === undefined ? {} : { hubRoleSha256: hubDigest }),
      ...(serviceDigest === undefined ? {} : { serviceRoleSha256: serviceDigest }) };
  }
  function order(operationId: string, previous: string | null, generationId: string) {
    return buildOrder(operationId, previous, generationId, hubRoleSha256, serviceRoleSha256);
  }
  function signatureValid(payload: Buffer, signature: string) {
    return typeof signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(signature) &&
      Buffer.from(signature, 'base64').toString('base64') === signature && verify(null, payload, key, Buffer.from(signature, 'base64'));
  }
  function authenticate(signed: SignedGenerationOrder): Entry {
    const { operationId, previous, generation } = signed.order;
    const exact = buildOrder(operationId, previous, generation.id, signed.order.hubRoleSha256, signed.order.serviceRoleSha256);
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
    const dataRoot = checkNode(path, g.dataRoot, true);
    const servicePath = generationServiceData(path, g.roles);
    const dataOwner = servicePath === path ? undefined : serviceOwner;
    if (dataOwner) {
      requireValue((dataRoot.mode & 0o7777n) === 0o711n);
      const serviceDirectory = checkNode(servicePath, g.roles.service!, true, dataOwner.uid);
      requireValue(serviceDirectory.gid === BigInt(dataOwner.gid) && (serviceDirectory.mode & 0o7777n) === 0o700n);
    } else requireValue(!lstatSync(join(path, serviceDataDirectory), { throwIfNoEntry: false }));
    const hubName = generationHubDatabase(g.roles);
    const hubEntry = hubName === autoloopHubDatabase ? autoloopHubDirectory : hubName;
    for (const entry of [autoloopHubDirectory, flatAutoloopHubDatabase, legacyHubDatabase]) {
      if (entry !== hubEntry) requireValue(!lstatSync(join(path, entry), { throwIfNoEntry: false }));
    }
    if (hubEntry === autoloopHubDirectory) {
      const hubDirectory = checkNode(join(path, hubEntry), g.roles[hubEntry]!, true, e.hubOwner?.uid);
      const hubDatabase = checkNode(join(path, hubName), g.roles[hubName]!, false, e.hubOwner?.uid);
      requireValue((hubDirectory.mode & 0o7777n) === 0o700n &&
        (e.hubOwner === undefined || (hubDirectory.gid === BigInt(e.hubOwner.gid) &&
          hubDatabase.gid === BigInt(e.hubOwner.gid) && (hubDatabase.mode & 0o7777n) === 0o600n)));
    } else {
      checkNode(join(path, hubName), g.roles[hubName]!, false);
    }
    for (const name of [...dataFiles, ...dataDirectories]) {
      const directory = name !== 'service.sqlite' && name !== 'answers.sqlite';
      const node = checkNode(join(servicePath, name), g.roles[name], directory, dataOwner?.uid);
      if (dataOwner) {
        requireValue(node.gid === BigInt(dataOwner.gid) && (node.mode & 0o7777n) === (directory ? 0o700n : 0o600n) &&
          !lstatSync(join(path, name), { throwIfNoEntry: false }));
      }
    }
  }
  async function withGeneration<T>(lease: Lease, g: InstalledGeneration, use: (deployment: AdmittedDeployment) => Promise<T>,
    signal?: AbortSignal) {
    boundary(lease);
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    const deploymentOptions = { staging, releasesRoot: join(e.root, 'releases'), hubGroup: e.hubOwner?.gid,
      serviceGroup: g.roles.service ? serviceOwner?.gid : undefined };
    return withPublishedDeployment(receipt, deploymentOptions, async installed => {
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
  async function useConfirmed<T>(use: UseConfirmation<T>, signal?: AbortSignal) {
    return leased(owner, async lease => {
      signal?.throwIfAborted();
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
        signal?.throwIfAborted();
        const result = await use(structuredClone(current), deployment, guard);
        await assertCurrent();
        return result;
      }, signal);
    }, true, enrolled);
  }
  async function previewUpgrade(packageSha256: string, targetSchema: number, storage: UpgradePreviewStorage): Promise<UpgradePreview> {
    const release = releases.get(packageSha256);
    requireValue(release?.expected.profile === 'deployment-complete' &&
      canonicalize(release.expected.target) === canonicalize(e.target));
    return leased(owner, async lease => {
      const state = await readState(lease);
      const { current } = state;
      requireValue(current && !state.pending);
      const generation = current.order.generation;
      const dataRoot = generationServiceData(join(e.root, 'data', generation.id), generation.roles);
      requireValue(packageSha256 !== generation.packageSha256 && storage.dataRoot === dataRoot &&
        storage.databasePath === join(dataRoot, 'service.sqlite') && storage.credentialDirectory === join(dataRoot, 'credentials'));
      const candidate = await verifyEmittedRuntimeCandidate(join(e.root, 'packages', packageSha256 + '.json'),
        { ...release, staging: deriveRuntimeStaging(lease, lease.root) });
      await verifyObservation(lease, state);
      return describeUpgrade(e.installationId, current, targetSchema, candidate);
    }, true, enrolled);
  }
  async function prepareUpgradeRelease(targetSchema: number, stagingNode: GenerationNode,
    cut: MaintenanceCutReadbackRegistration, action: 'execute' | 'readback', backup: UpgradeCutReader) {
    const { claimSha256, planSha256, ...cutPlan } = cut.subject;
    const { installationId, generationId, selectionSha256, releaseSha256, upgradeOperationId } = cutPlan;
    const nextGeneration = cut.lifecycle.plan.nextGeneration;
    token(nextGeneration);
    token(upgradeOperationId);
    hash(claimSha256);
    requireValue(installationId === e.installationId && canonicalize(projectIdentity(cut.target.identity)) === canonicalize(identity));
    const release = releases.get(releaseSha256);
    requireValue(release?.expected.profile === 'deployment-complete');
    const stagingRoot = join(e.root, 'staging');
    const releasesRoot = join(e.root, 'releases');
    const destination = join(stagingRoot, '.upgrade-' + upgradeOperationId);
    const publicationRecord = destination + '.published.json';
    const published = join(releasesRoot, releaseSha256);
    let attempted = false;
    try {
      const prepare = (checkWriters: () => void) => leased(owner, async lease => {
        const guard = () => {
          checkWriters();
          boundary(lease);
          const info = checkNode(stagingRoot, stagingNode, true);
          requireValue(stagingNode.device === e.stores.releases.device && (info.mode & 0o7777n) === 0o700n);
        };
        const state = await readState(lease);
        const { current } = state;
        guard();
        requireValue(current && !state.pending && current.sha256 === selectionSha256 &&
          current.order.generation.id === generationId && current.order.generation.packageSha256 !== releaseSha256 &&
          generationId.toLowerCase() !== nextGeneration.toLowerCase());
        await withGeneration(lease, current.order.generation, async () => {});
        const staging = deriveRuntimeStaging(lease, lease.root, { stagingRoot, releasesRoot });
        const candidate = await verifyEmittedRuntimeCandidate(join(e.root, 'packages', releaseSha256 + '.json'), { ...release, staging });
        const preview = describeUpgrade(installationId, current, targetSchema, candidate);
        requireValue(installedUpgradePlanSha256(preview.planSha256, nextGeneration, cutPlan) === planSha256);
        const observeCut = async () => {
          const observed = await readState(lease);
          requireValue(observed.current?.sha256 === selectionSha256 && !observed.pending);
          const observedCut = await backup.read();
          guard();
          physical(current.order.generation);
          return observedCut;
        };
        const initialCut = await observeCut();
        const confirmCut = async () => requireValue(canonicalize(await observeCut()) === canonicalize(initialCut));
        const access = { hubGroup: e.hubOwner?.gid, serviceGroup: serviceOwner?.gid };
        if (lstatSync(destination, { throwIfNoEntry: false })) return { status: 'interrupted' as const };
        if (!lstatSync(published, { throwIfNoEntry: false })) {
          requireValue(!lstatSync(publicationRecord, { throwIfNoEntry: false }));
          if (action === 'readback') return { status: 'pending' as const };
          const free = statfsSync(stagingRoot, { bigint: true });
          const needed = candidate.materials.reduce((total, file) => total + BigInt(file.bytes), 0n);
          requireValue(free.bsize > 0n && free.bavail * free.bsize >= needed);
          attempted = true;
          const stage = await stageVerifiedEmittedRuntime(candidate, { staging, destination, ...access });
          await publishStagedDeployment(candidate, stage, guard, confirmCut);
        }
        const receipt = { packageSha256: releaseSha256, manifestSha256: candidate.manifestSha256, cutManifestSha256: initialCut.manifestHash };
        const result = await withPublishedDeployment(candidate, { staging, releasesRoot, ...access }, async () => {
          await confirmCut();
          guard();
          const releaseNode = pin(stat(published));
          const effectiveReceipt = bytes({
            format: 'patrick-upgrade-publication-v1', claimSha256, planSha256,
            fenceReceiptId: initialCut.fenceReceiptId, releaseNode, receipt,
          });
          const existing = lstatSync(publicationRecord, { bigint: true, throwIfNoEntry: false });
          if (existing) {
            requireValue((checkNode(publicationRecord, pin(existing), false).mode & 0o7777n) === 0o600n);
            const observed = await readRegularFile(publicationRecord, recordLimit, { root: stagingRoot, validate: guard });
            requireValue(observed.equals(effectiveReceipt));
            if (action === 'execute') {
              attempted = true;
              syncDirectory(stagingRoot, stagingNode);
            }
            return { status: 'published' as const, receipt };
          }
          if (action === 'readback') return { status: 'interrupted' as const };
          attempted = true;
          syncDirectory(stagingRoot, stagingNode);
          syncDirectory(releasesRoot, e.stores.releases);
          checkNode(published, releaseNode, true);
          recordUpgradePublication(publicationRecord, effectiveReceipt, stagingNode, guard);
          return { status: 'published' as const, receipt };
        });
        await confirmCut();
        return result;
      }, true, enrolled);
      return await (action === 'execute' ? withStoppedWriters(prepare) : prepare(() => {}));
    } catch (error) {
      if (attempted) return { status: 'interrupted' as const };
      throw error;
    }
  }
  async function selectReserved(envelope: string, checkRole?: () => void) {
    enrolled();
    requireValue(typeof envelope === 'string' && Buffer.byteLength(envelope) <= recordLimit);
    const signed = JSON.parse(envelope) as SignedGenerationOrder;
    requireValue(canonicalize(signed) === envelope);
    const next = authenticate(signed);
    const id = next.order.operationId;
    let attempted = false;
    function checkSelection(lease: Lease) {
      checkRole?.();
      boundary(lease);
    }
    try {
      const result = await leased(owner, async lease => {
        const state = await readState(lease, id);
        checkSelection(lease);
        if (state.pending?.sha256 === next.sha256) throw uncertain(id);
        if (state.historical) {
          requireValue(state.historical.sha256 === next.sha256);
          return verifyObservation(lease, state, id);
        }
        requireValue(!state.pending && (state.current?.sha256 ?? null) === next.order.previous);
        const currentRoleSha256 = state.current?.order.hubRoleSha256;
        if ((currentRoleSha256 !== undefined && currentRoleSha256 !== hubRoleSha256) ||
            next.order.hubRoleSha256 !== hubRoleSha256) throw new Error('INSTALLED_HUB_REGISTRATION_REQUIRED');
        const currentServiceRoleSha256 = state.current?.order.serviceRoleSha256;
        if (state.current && currentServiceRoleSha256 === undefined && serviceRoleSha256 !== undefined) {
          throw new Error('INSTALLED_SERVICE_FENCE_REQUIRES_FRESH_INSTALL');
        }
        if ((currentServiceRoleSha256 !== undefined && currentServiceRoleSha256 !== serviceRoleSha256) ||
            next.order.serviceRoleSha256 !== serviceRoleSha256) throw new Error('INSTALLED_SERVICE_REGISTRATION_REQUIRED');
        requireValue(selectionHistory().filter(name => name.endsWith('.json')).length < maxRecords);
        if (state.current) { await withGeneration(lease, state.current.order.generation, async () => {}); checkSelection(lease); }
        return withGeneration(lease, next.order.generation, async () => {
          const before = await readState(lease, id, next.order.generation.id);
          checkSelection(lease);
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
            checkSelection(lease);
            const envelope = bytes({ body, signature });
            requireValue(signatureValid(bytes(body), signature) && envelope.length <= recordLimit);
            const confirmed = await readState(lease, id, next.order.generation.id, node);
            checkSelection(lease);
            requireValue(canonicalize(confirmed) === canonicalize(state));
            checkNode(stage, node, false);
            writeFileSync(fd, envelope);
            fsyncSync(fd);
          } finally { closeSync(fd); }
          checkSelection(lease);
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
          checkSelection(lease);
          requireValue(visible.current?.sha256 === next.sha256 && visible.pending?.sha256 === next.sha256);
          const selected = pin(stat(currentPath));
          const payload = completionBytes(next, selected);
          const signature = await Reflect.apply(registeredSign, signer, [payload]);
          checkSelection(lease);
          const confirmed = await readState(lease, id);
          checkSelection(lease);
          requireValue(signatureValid(payload, signature) && canonicalize(confirmed) === canonicalize(visible));
          requireValue(canonicalize(pin(stat(currentPath))) === canonicalize(selected));
          checkSelection(lease);
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
  async function withStoppedHubWriter<T>(use: (guard: () => void) => Promise<T>): Promise<T> {
    if (!hubRoleOwner) {
      const guard = () => {
        if (lstatSync(hubControlRoot(e.root), { throwIfNoEntry: false })) throw new Error('INSTALLED_HUB_REGISTRATION_REQUIRED');
      };
      guard();
      return use(guard);
    }
    return leased(hubRoleOwner, async lease => {
      const path = hubWriterFencePath(e.root);
      const writerNode = e.hubRole!.writerNode;
      function checkWriter() {
        lease.guard();
        const info = checkNode(path, writerNode, false, e.hubOwner?.uid);
        requireValue((info.mode & 0o7777n) === 0o600n);
      }
      checkWriter();
      const fence = new DatabaseSync(path, { timeout: 0 });
      try {
        checkWriter();
        try { fence.exec('BEGIN IMMEDIATE'); }
        catch (error) {
          const code = (error as { errcode?: number })?.errcode;
          if (code !== undefined && [5, 6].includes(code & 0xff)) {
            throw new Error('INSTALLED_HUB_WRITER_BUSY', { cause: error });
          }
          throw error;
        }
        requireValue(fence.prepare('PRAGMA journal_mode').get()?.journal_mode === 'delete' &&
          fence.prepare('PRAGMA user_version').get()?.user_version === 1);
        return await use(() => { checkWriter(); requireValue(fence.isTransaction); });
      } finally { fence.close(); }
    }, true, enrolled);
  }
  async function withStoppedWriters<T>(use: (guard: () => void) => Promise<T>): Promise<T> {
    enrolled();
    const service = reserveServiceWriter(e, 'selection');
    try {
      return await withStoppedHubWriter(checkHub => use(() => { service.guard(); checkHub(); }));
    }
    finally { service.release(); }
  }
  function select(envelope: string) {
    return withStoppedWriters(guard => selectReserved(envelope, guard));
  }
  return { store: Object.freeze({ order, observe, select, useConfirmed }), previewUpgrade, prepareUpgradeRelease, withStoppedWriters };
}

export function runInstalledUpgradeRelease(registration: UpgradeReleaseEnrollment, action: 'execute' | 'readback',
  validate: () => void, backup: UpgradeCutReader) {
  requireValue(action === 'execute' || action === 'readback');
  validate();
  const { enrollment, owner, cut, targetSchema, stagingNode } = registration;
  return generationStorage(enrollment, owner, undefined, validate).prepareUpgradeRelease(targetSchema, stagingNode, cut, action, backup);
}

export function createGenerationStore(registration: GenerationEnrollment, owner: ExclusiveRuntimeStaging | undefined, signer: GenerationRecordSigner) {
  requireValue(signer && (typeof signer === 'object' || typeof signer === 'function'));
  return generationStorage(registration, owner, signer).store;
}

/** Public-only restart surface. The controller provisions read-only filesystem access for this process. */
export function createGenerationReader(registration: GenerationEnrollment, owner?: ExclusiveRuntimeStaging) {
  const { observe } = generationStorage(registration, owner).store;
  return Object.freeze({ observe });
}

export function withConfirmedGeneration<T>(registration: GenerationEnrollment, owner: ExclusiveRuntimeStaging | undefined,
  use: UseConfirmation<T>, signal?: AbortSignal): Promise<T> {
  return generationStorage(registration, owner).store.useConfirmed(use, signal);
}

export function withStoppedGenerationWriters<T>(registration: GenerationEnrollment, use: (guard: () => void) => Promise<T>,
  owner?: ExclusiveRuntimeStaging): Promise<T> {
  return generationStorage(registration, owner).withStoppedWriters(use);
}

export function createInstalledUpgradePreview(registration: GenerationEnrollment, owner: ExclusiveRuntimeStaging | undefined,
  storage: UpgradePreviewStorage, successorSchemas: Readonly<Record<string, number>>, validateRegistration: () => void) {
  const ownerMethod = owner === undefined ? undefined : captureMethod(owner, 'withExclusiveReadRoot');
  const releases = new Map(registration.releases.map(({ expected }) => [expected.packageSha256, expected]));
  const successors = new Map(Object.entries(successorSchemas));
  for (const [packageSha256, targetSchema] of successors) {
    hash(packageSha256);
    const expected = releases.get(packageSha256);
    requireValue(expected?.profile === 'deployment-complete' &&
      canonicalize(expected.target) === canonicalize(registration.target) &&
      Number.isSafeInteger(targetSchema) && targetSchema >= 0 && targetSchema >= expected.schema.min && targetSchema <= expected.schema.max);
  }
  function validate() {
    validateRegistration();
    ownerMethod?.validate();
  }
  return async (packageSha256: string): Promise<UpgradePreview | undefined> => {
    const targetSchema = successors.get(packageSha256);
    if (targetSchema === undefined) return;
    validate();
    try {
      return await generationStorage(registration, owner, undefined, validate).previewUpgrade(packageSha256, targetSchema, storage);
    } finally { validate(); }
  };
}
