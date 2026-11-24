import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readFileSync, realpathSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { stripTypeScriptTypes } from 'node:module';
import { hostname, machine } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalHubPort } from '@patrick/integrations/autoloop/answers';
import { openDatabase } from '@patrick/storage';
import { autoloopHubDatabase, legacyHubDatabase, type GenerationNode, type InstalledGeneration } from './lifecycle-generation.js';
import { projectIdentity, type HostIdentity } from '../lib/doctor.mjs';
import { renderDeploymentTemplates, deploymentPaths, type DeploymentRegistration } from '../lib/deployment-templates.mjs';
import {
  deriveRuntimeStaging, leased, verifyEmittedRuntimeCandidate, stageVerifiedEmittedRuntime, publishStagedDeployment, withPublishedDeployment,
  type AdmittedDeployment, type ExclusiveRuntimeStaging, type RuntimeLease, type EmittedReleaseExpectation, type EmittedReleaseTrustPolicy,
} from '../lib/emitted-release.mjs';
import { admitReadRoot, canonicalize, readRegularFile, sha256 } from '../lib/release.mjs';
import { createLifecycleJournal, createLifecycleJournalReader, lifecycleRecordName,
  type LifecycleRegistration, type LifecycleRequest, type LifecycleStatus } from './lifecycle-journal.ts';

const stores = ['packages', 'releases', 'data', 'history', 'lima'] as const;
const budgets = ['releases', 'data', 'lima'] as const;
type Store = typeof stores[number];
type Budget = typeof budgets[number];
type Stage = 'REGISTRATION' | 'HOST' | 'LAYOUT' | 'PACKAGE' | 'CAPACITY' | 'DEPLOYMENT' | 'SESSION' | 'LEASE';

/** Installed-controller input. The owner excludes changes to the registered installation and
 * its ancestry until the awaited callback ends. Session credentials are selected independently
 * for this origin and scope only after bootstrap. The enrollment pins the intended CA
 * digest, RP and deployment configuration before the endpoint exists. */
export type InstallPreviewEnrollment = {
  installationId: string; releaseId: string; identity: HostIdentity; hostname: string; uid: number;
  root: string; rootNode: GenerationNode; stores: Record<Store, GenerationNode>; owner: ExclusiveRuntimeStaging;
  node: { path: string; sha256: string }; expected: EmittedReleaseExpectation; policy: EmittedReleaseTrustPolicy;
  targetSchema: number; reserveBytes: Record<Budget, number>;
  firstGenerationId?: string;
  deployment: DeploymentRegistration; templates: Record<'caddy' | 'service' | 'hub' | 'worker', string>;
  tls: { rpId: string; caSha256: string };
  session?: { bootstrapPlanSha256: string; ca: string; callerId: string; authEpoch: number; credentialRevision: string;
    readBearer(signal: AbortSignal): Promise<string> };
};

export const installBootstrapRequirements = Object.freeze(['schema-bootstrap', 'fixed-origin-tls', 'owner-passkey', 'authenticated-session'] as const);
const bootstrapRequirements = installBootstrapRequirements;
export type InstallReleaseEnrollment = {
  releaseId: string; planSha256: string; journalPublicKey: string; journalKeyId: string; approvalPublicKey: string;
  approval?: string; signJournal?(bytes: Uint8Array): Promise<string>;
  generation?: { id: string; kernelPath?: string };
};
type LocalPlan = {
  installationId: string; releaseId: string; packageSha256: string; planSha256: string;
  firstGenerationId?: string;
  activeSchema: number; targetSchema: number; volumes: { roles: Budget[]; requiredBytes: string }[];
  activationAuthorized: false; delegationAuthorized: false;
};
export type InstallPreviewResult = { status: 'blocked'; code: `INSTALL_PREVIEW_${Stage}` } |
  LocalPlan & ({ status: 'preview'; phase: 'bootstrap'; outstanding: typeof bootstrapRequirements } |
    { status: 'session-observed'; phase: 'authenticated-session'; credentialBindingSha256: string;
      observed: readonly ['fixed-origin-tls', 'authenticated-session']; outstanding: readonly ['schema-bootstrap', 'owner-passkey'] });

function requireFact(value: unknown): asserts value {
  if (!value) throw new Error('unconfirmed');
}
const digest = (value: unknown) => sha256(Buffer.from(canonicalize(value)));
const id = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const stat = (path: string) => lstatSync(path, { bigint: true });
function physical(path: string, pin: GenerationNode, uid: number) {
  const info = stat(path);
  requireFact(path !== '/' && realpathSync.native(path) === path && info.isDirectory() &&
    info.uid === BigInt(uid) && (info.mode & 0o022n) === 0n && info.dev.toString() === pin.device &&
    info.ino.toString() === pin.inode && info.birthtimeNs.toString() === pin.birthtimeNs);
  accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
}
function syncStore(path: string, pin: GenerationNode, uid: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd, { bigint: true });
    requireFact(info.uid === BigInt(uid) && (info.mode & 0o022n) === 0n && String(info.dev) === pin.device &&
      String(info.ino) === pin.inode && String(info.birthtimeNs) === pin.birthtimeNs);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function exactDirectory(path: string, expected: readonly string[]) {
  const remaining = new Set(expected);
  const dir = opendirSync(path);
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) requireFact(remaining.delete(entry.name));
    requireFact(!remaining.size);
  } finally { dir.closeSync(); }
}
function layout(e: InstallPreviewEnrollment, root: string, empty: boolean, history: readonly string[] = []) {
  requireFact(root === e.root && e.deployment.instanceRoot === root);
  physical(root, e.rootNode, e.uid);
  if (empty) exactDirectory(root, stores);
  for (const name of stores) {
    const path = join(root, name);
    physical(path, e.stores[name], e.uid);
    if (empty) exactDirectory(path, name === 'packages' ? [e.expected.packageSha256 + '.json'] : name === 'history' ? history : []);
  }
}
type VolumeReading = { device: string; required: bigint; available: bigint };
/** Pure arithmetic. Distinct Darwin device IDs cannot prove separate APFS allocation pools. */
export function budgetInstallVolume(readings: Record<Budget, VolumeReading>, checkAvailable = true) {
  const device = readings.releases.device;
  let available = readings.releases.available;
  let required = 0n;
  for (const role of budgets) {
    const reading = readings[role];
    requireFact(reading.device === device && reading.available >= 0n && reading.required > 0n);
    required += reading.required;
    if (reading.available < available) available = reading.available;
  }
  if (checkAvailable) requireFact(required <= available);
  return [{ roles: [...budgets], requiredBytes: String(required) }];
}
function capacity(e: InstallPreviewEnrollment, materialBytes: bigint, checkAvailable: boolean) {
  const read = (role: Budget): VolumeReading => {
    const reserve = e.reserveBytes[role];
    requireFact(Number.isSafeInteger(reserve) && reserve > 0);
    const disk = statfsSync(join(e.root, role), { bigint: true });
    requireFact(disk.bsize > 0n && disk.bavail >= 0n);
    return { device: e.stores[role].device, required: BigInt(reserve) + (role === 'releases' ? materialBytes : 0n),
      available: disk.bsize * disk.bavail };
  };
  return budgetInstallVolume({ releases: read('releases'), data: read('data'), lima: read('lima') }, checkAvailable);
}
function nativeHost(e: InstallPreviewEnrollment) {
  requireFact(process.platform === 'darwin' && e.expected.target.os === process.platform &&
    e.expected.target.arch === process.arch && machine() === (process.arch === 'x64' ? 'x86_64' : 'arm64') &&
    e.expected.runtime.node === process.version &&
    e.expected.runtime.modules === process.versions.modules && hostname() === e.hostname &&
    process.geteuid?.() === e.uid && realpathSync.native(process.execPath) === e.node.path);
  // A translated x64 process cannot attest an Intel installation.
  if (process.arch === 'x64') requireFact(['', '0'].includes(
    execFileSync('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 2000 }).trim()));
}
async function checkSession(e: InstallPreviewEnrollment, credential: NonNullable<InstallPreviewEnrollment['session']>, guard: () => void) {
  const { origin } = e.deployment;
  const { ca, callerId, authEpoch } = credential;
  const { rpId, caSha256 } = e.tls;
  const url = new URL(origin);
  requireFact(url.origin === origin && url.protocol === 'https:' && url.hostname === rpId &&
    id(callerId) && id(credential.credentialRevision) && Number.isSafeInteger(authEpoch) && authEpoch >= 0 &&
    typeof ca === 'string' && ca.length > 0 && ca.length <= 64 * 1024 && sha256(Buffer.from(ca)) === caSha256);
  const signal = AbortSignal.timeout(5000);
  guard();
  const token = await Promise.race([credential.readBearer(signal), new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true }))]);
  guard();
  requireFact(typeof token === 'string' && /^[A-Za-z0-9._~-]{1,2048}$/.test(token));
  // A single verified HTTPS connection carries the credential and identity response.
  // No redirect, alternate origin, proxy, custom verifier or caller-supplied readiness port.
  const body = await new Promise<Buffer>((resolve, reject) => {
    const req = request(new URL('/api/v1/session', origin), { ca, rejectUnauthorized: true, minVersion: 'TLSv1.2',
      agent: false, method: 'GET', signal, headers: { authorization: 'Bearer ' + token, 'cache-control': 'no-store' } }, res => {
      const chunks: Buffer[] = [];
      let length = 0;
      res.on('error', reject);
      if (res.statusCode !== 200) { req.destroy(new Error('session')); return; }
      res.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 64 * 1024) req.destroy(new Error('limit'));
        else chunks.push(chunk);
      });
      res.once('end', () => resolve(Buffer.concat(chunks)));
    });
    req.once('error', reject);
    req.end();
  });
  guard();
  const { schema_version, scope, data } = JSON.parse(body.toString('utf8'));
  requireFact(schema_version === '1.0' && scope.account_id === e.identity.accountId && scope.permission_epoch === authEpoch &&
    data.account_id === e.identity.accountId && data.caller_id === callerId && data.auth_epoch === authEpoch &&
    Array.isArray(data.domains) && scope.data_domain === data.domains[0] &&
    canonicalize([...data.domains].sort()) === canonicalize([...e.identity.domains].sort()));
}

/** Computes a deterministic digest for later independent rederivation. A preview is never
 * authorization to activate a release, create a generation or dispatch native jobs. */
type Registry = () => InstallPreviewEnrollment | undefined;
/**
 * Snapshot the plan's data fields as detached records, including fields on class-backed
 * registrations. Nested records use their own enumerable data fields. Only the two
 * executable ports keep their original method receivers.
 * Accessor-backed fields cannot provide a repeatable registration observation.
 */
export function bindInstallPreviewEnrollment(current: Registry) {
  const original = current();
  requireFact(original);
  const checks: (() => void)[] = [];
  function trackPrototype(object: object) {
    const prototype = Object.getPrototypeOf(object);
    checks.push(() => requireFact(Object.getPrototypeOf(object) === prototype));
  }
  trackPrototype(original);
  function field<T extends object, K extends keyof T>(object: T, key: K, optional = false): T[K] {
    const chain: Array<{ object: object; prototype: object | null }> = [];
    let first: PropertyDescriptor | undefined;
    for (let at: object | null = object; at; at = Object.getPrototypeOf(at)) {
      chain.push({ object: at, prototype: Object.getPrototypeOf(at) });
      first = Object.getOwnPropertyDescriptor(at, key);
      if (first) break;
    }
    requireFact(first ? Object.hasOwn(first, 'value') : optional);
    const initial = first;
    checks.push(() => {
      for (let index = 0; index < chain.length; index++) {
        const item = chain[index]!;
        requireFact(Object.getPrototypeOf(item.object) === item.prototype);
        const live = Object.getOwnPropertyDescriptor(item.object, key);
        if (index < chain.length - 1 || !initial) requireFact(!live);
        else requireFact(live && Object.hasOwn(live, 'value') && Object.is(live.value, initial.value) &&
          live.enumerable === initial.enumerable && live.configurable === initial.configurable && live.writable === initial.writable);
      }
    });
    return first?.value;
  }
  function copy<T>(value: T, depth = 0): T {
    if (value === null || typeof value !== 'object') {
      requireFact(typeof value !== 'function');
      return value;
    }
    requireFact(depth < 32);
    trackPrototype(value);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    checks.push(() => {
      const currentKeys = Object.keys(record).sort();
      requireFact(currentKeys.length === keys.length && keys.every((key, i) => currentKeys[i] === key));
    });
    if (Array.isArray(value)) {
      const length = field(value, 'length');
      requireFact(keys.length === length);
      return Array.from({ length }, (_, i) => {
        requireFact(Object.hasOwn(value, i));
        return copy(field(value, i), depth + 1);
      }) as T;
    }
    return Object.fromEntries(keys.map(key => [key, copy(field(record, key), depth + 1)])) as T;
  }
  function dataFields<T extends object, K extends keyof T>(object: T, keys: readonly K[]): Pick<T, K> {
    return Object.fromEntries(keys.map(key => [key, copy(field(object, key))])) as Pick<T, K>;
  }
  const data = dataFields(original, ['installationId', 'releaseId', 'identity', 'hostname', 'uid', 'root', 'rootNode',
    'stores', 'node', 'expected', 'policy', 'targetSchema', 'reserveBytes', 'deployment', 'templates', 'tls']);
  const firstGenerationId = field(original, 'firstGenerationId', true);
  const owner = field(original, 'owner');
  trackPrototype(owner);
  requireFact(typeof field(owner, 'withExclusiveReadRoot') === 'function');
  const session = field(original, 'session', true);
  let credential: InstallPreviewEnrollment['session'];
  if (session !== undefined) {
    trackPrototype(session);
    const metadata = dataFields(session, ['bootstrapPlanSha256', 'ca', 'callerId', 'authEpoch', 'credentialRevision']);
    const readBearer = field(session, 'readBearer');
    requireFact(typeof readBearer === 'function');
    credential = { ...metadata, readBearer: signal => Reflect.apply(readBearer, session, [signal]) };
  }
  const value: InstallPreviewEnrollment = { ...data, firstGenerationId, session: credential, owner };
  function validate() {
    requireFact(current() === original);
    for (const check of checks) check();
  }
  validate();
  return { value, validate };
}
export function previewFirstInstall(current: Registry, releaseId: string) {
  return inspectInstall(current, releaseId, 'bootstrap');
}
/** Read back the TLS endpoint and principal against a separately retained bootstrap plan.
 * Recheck the immutable installation, stores and package; their contents can now include
 * bootstrap data. This read makes no claim about that data, native jobs or passkey ownership. */
export function observeInstallSession(current: Registry, releaseId: string) {
  return inspectInstall(current, releaseId, 'authenticated-session');
}
async function inspectInstall(current: Registry, releaseId: string, phase: 'bootstrap' | 'authenticated-session'): Promise<InstallPreviewResult> {
  let stage: Stage = 'REGISTRATION';
  try {
    const reportStage = (next: Stage) => { stage = next; };
    return await withInstallLease(current, releaseId, reportStage, async (e, lease, guard) => {
      const bootstrap = phase === 'bootstrap';
      const { local, confirm } = await inspectLeasedInstall(e, lease, guard, reportStage, { empty: bootstrap, checkAvailable: bootstrap });
      if (phase === 'authenticated-session') {
        stage = 'SESSION';
        const credential = e.session;
        requireFact(credential && credential.bootstrapPlanSha256 === local.planSha256);
        await checkSession(e, credential, guard);
        guard();
        const credentialBindingSha256 = digest({ planSha256: local.planSha256, callerId: credential.callerId, authEpoch: credential.authEpoch,
          credentialRevision: credential.credentialRevision });
        confirm();
        return { ...local, status: 'session-observed' as const,
          phase: 'authenticated-session' as const, credentialBindingSha256, observed: ['fixed-origin-tls', 'authenticated-session'] as const,
          outstanding: ['schema-bootstrap', 'owner-passkey'] as const };
      }
      return { ...local, status: 'preview' as const, phase: 'bootstrap' as const, outstanding: [...bootstrapRequirements] as const };
    });
  } catch { return { status: 'blocked', code: `INSTALL_PREVIEW_${stage}` }; }
}

async function withInstallLease<T>(current: Registry, releaseId: string, reportStage: (stage: Stage) => void,
  work: (enrollment: InstallPreviewEnrollment, lease: RuntimeLease, guard: () => void) => Promise<T>): Promise<T> {
  const { value: e, validate } = bindInstallPreviewEnrollment(current);
  requireFact(e && id(e.installationId) && id(releaseId) && releaseId === e.releaseId);
  projectIdentity(e.identity);
  requireFact(e.expected.profile === 'deployment-complete' && /^[a-f0-9]{64}$/.test(e.expected.packageSha256) &&
    Number.isSafeInteger(e.targetSchema) && e.targetSchema >= e.expected.activeSchema &&
    e.targetSchema >= e.expected.schema.min && e.targetSchema <= e.expected.schema.max);
  reportStage('HOST');
  nativeHost(e);
  reportStage('LEASE');
  const result = await leased(e.owner, async lease => {
    const guard = () => { validate(); lease.guard(); };
    guard();
    const outcome = await work(e, lease, guard);
    guard();
    return outcome;
  }, true, validate);
  validate();
  return result;
}

async function inspectLeasedInstall(e: InstallPreviewEnrollment, lease: RuntimeLease, guard: () => void,
  reportStage: (stage: Stage) => void, options: { empty: boolean; history?: readonly string[]; checkAvailable?: boolean;
    publication?: NonNullable<ExclusiveRuntimeStaging['publication']> }) {
  reportStage('LAYOUT');
  layout(e, lease.root, options.empty, options.history);
  reportStage('HOST');
  const nodeRoot = admitReadRoot(dirname(e.node.path));
  const binary = stat(e.node.path);
  requireFact(binary.isFile() && (binary.mode & 0o111n) !== 0n && (binary.mode & 0o022n) === 0n);
  const nodeBytes = await readRegularFile(e.node.path, 256 * 1024 * 1024,
    { root: nodeRoot.root, validate() { guard(); nodeRoot.validate(); } });
  guard();
  requireFact(sha256(nodeBytes) === e.node.sha256);
  reportStage('PACKAGE');
  const staging = deriveRuntimeStaging(lease, lease.root, options.publication);
  const archive = join(e.root, 'packages', e.expected.packageSha256 + '.json');
  const artifact = stat(archive);
  const receipt = await verifyEmittedRuntimeCandidate(archive, { staging, expected: e.expected, policy: e.policy });
  guard();
  const materialBytes = receipt.materials.reduce((total, file) => total + BigInt(file.bytes), 0n);
  reportStage('CAPACITY');
  const volumes = capacity(e, materialBytes, options.checkAvailable ?? true);
  reportStage('DEPLOYMENT');
  const source = (role: keyof typeof e.templates) => Buffer.from(e.templates[role]);
  const rendered = renderDeploymentTemplates({ caddy: source('caddy'), service: source('service'),
    hub: source('hub'), worker: source('worker') }, e.deployment);
  const descriptors = Object.values(deploymentPaths).map(path => {
    const row = receipt.materials.find(file => file.path === path);
    requireFact(row);
    return row;
  });
  requireFact(new URL(e.deployment.origin).hostname === e.tls.rpId && /^[0-9a-f]{64}$/.test(e.tls.caSha256));
  const identity = projectIdentity(e.identity);
  identity.domains.sort();
  const { installationId, releaseId } = e;
  requireFact(e.firstGenerationId === undefined || id(e.firstGenerationId));
  const planSha256 = digest({ format: 'patrick-first-install-preview-v2', installationId, releaseId,
    identity, uid: e.uid, hostname: e.hostname, node: e.node, root: e.root, rootNode: e.rootNode, stores: e.stores,
    policy: e.policy, expected: e.expected, manifestSha256: receipt.manifestSha256, targetSchema: e.targetSchema,
    reserveBytes: e.reserveBytes, volumes, deployment: e.deployment, renderedSha256: digest(rendered), descriptors,
    required: bootstrapRequirements, tls: e.tls,
    ...(e.firstGenerationId === undefined ? {} : { firstGenerationId: e.firstGenerationId, autoloopKernelSha256 }) });
  const confirm = () => {
    reportStage('LAYOUT');
    layout(e, lease.root, options.empty, options.history);
    reportStage('HOST');
    nativeHost(e);
    nodeRoot.validate();
    const checked = stat(archive);
    requireFact(checked.dev === artifact.dev && checked.ino === artifact.ino && checked.ctimeNs === artifact.ctimeNs);
    const now = stat(e.node.path);
    requireFact(now.dev === binary.dev && now.ino === binary.ino && now.ctimeNs === binary.ctimeNs);
    reportStage('CAPACITY');
    capacity(e, materialBytes, options.checkAvailable ?? true);
    reportStage('LEASE');
    guard();
  };
  confirm();
  const local: LocalPlan = { installationId, releaseId, planSha256, packageSha256: receipt.packageSha256,
    activeSchema: e.expected.activeSchema, targetSchema: e.targetSchema, volumes,
    ...(e.firstGenerationId === undefined ? {} : { firstGenerationId: e.firstGenerationId }),
    activationAuthorized: false, delegationAuthorized: false };
  return { local, staging, receipt, confirm };
}

export function installReleaseApproval(input: Pick<LocalPlan, 'installationId' | 'releaseId' | 'planSha256'>, operationId: string) {
  const { installationId, releaseId, planSha256 } = input;
  return Buffer.from(canonicalize({ format: 'patrick-install-release-approval-v1', installationId, releaseId, operationId, planSha256 }));
}

function installVerificationKey(key: string) {
  requireFact(typeof key === 'string' && key.length <= 2048);
  const publicKey = createPublicKey(key);
  requireFact(publicKey.asymmetricKeyType === 'ed25519');
  return publicKey;
}

function verifyInstallSignature(publicKey: ReturnType<typeof installVerificationKey>, bytes: Uint8Array, signature: string) {
  if (typeof signature !== 'string' || signature.length !== 88) return false;
  const decoded = Buffer.from(signature, 'base64');
  return decoded.length === 64 && decoded.toString('base64') === signature && verify(null, bytes, publicKey, decoded);
}

export async function runFirstInstallRelease(current: Registry, releaseId: string, operationId: string,
  action: 'execute' | 'readback', operation: InstallReleaseEnrollment, validateOperation: () => void):
Promise<LifecycleStatus | { status: 'approval-required' }> {
  requireFact(action === 'execute' || action === 'readback');
  return runInstallOperation(current, releaseId, operationId, action, operation, validateOperation);
}

async function runInstallOperation<T = never>(current: Registry, releaseId: string, operationId: string,
  action: 'execute' | 'readback' | 'prepare-generation', operation: InstallReleaseEnrollment, validateOperation: () => void,
  prepare?: (e: InstallPreviewEnrollment, release: AdmittedDeployment, guard: () => void) => Promise<T>):
Promise<LifecycleStatus | { status: 'approval-required' } | T> {
  const { planSha256, journalKeyId, approval, signJournal } = operation;
  requireFact(id(operationId) && id(journalKeyId) && operation.releaseId === releaseId &&
    typeof planSha256 === 'string' && /^[0-9a-f]{64}$/.test(planSha256));
  const approvalKey = installVerificationKey(operation.approvalPublicKey);
  const journalKey = installVerificationKey(operation.journalPublicKey);
  requireFact(!approvalKey.equals(journalKey));
  if (action === 'execute' && (typeof signJournal !== 'function' || approval === undefined)) return { status: 'approval-required' };
  let attempted = false;
  try {
    return await withInstallLease(() => { validateOperation(); return current(); }, releaseId, () => {}, async (e, lease, guard) => {
      if (action === 'execute') {
        requireFact(approval && verifyInstallSignature(approvalKey,
          installReleaseApproval({ installationId: e.installationId, releaseId, planSha256 }, operationId), approval));
      }
      layout(e, lease.root, false);
      const history = join(e.root, 'history');
      const destination = join(history, `.release-${operationId}`);
      const releasesRoot = join(e.root, 'releases');
      const publication = { stagingRoot: history, releasesRoot };
      const req: LifecycleRequest = { operationId, command: 'install', targetId: releaseId, planSha256, expectedGeneration: null };
      const evidenceId = 'published-release';
      let material: Awaited<ReturnType<typeof inspectLeasedInstall>> | undefined;
      let reconciling = false;
      async function inspect(empty: boolean, records?: readonly string[]) {
        const checked = await inspectLeasedInstall(e, lease, guard, () => {}, { empty, history: records, publication, checkAvailable: empty });
        requireFact(checked.local.planSha256 === planSha256);
        return checked;
      }
      const registration: LifecycleRegistration = {
        root: { path: history, device: Number(e.stores.history.device), inode: Number(e.stores.history.inode) },
        identity: { ...projectIdentity(e.identity), installationId: e.installationId },
        plan: { command: 'install', targetId: releaseId, planSha256, expectedGeneration: null,
          nextGeneration: null, releaseSha256: e.expected.packageSha256 },
        authority: { keyId: journalKeyId, async verify(bytes, signature, id) {
          return id === journalKeyId && verifyInstallSignature(journalKey, bytes, signature);
        } },
        evidence: { version: 'install-release-v1', async observe(subject, expectedId) {
          guard();
          requireFact(expectedId === evidenceId);
          const { receipt, staging } = material ??= await inspect(false);
          return await withPublishedDeployment(receipt, { staging, releasesRoot }, async () => {
            guard();
            if (reconciling) {
              requireFact(!lstatSync(destination, { throwIfNoEntry: false }));
              exactDirectory(releasesRoot, [receipt.packageSha256]);
              syncStore(releasesRoot, e.stores.releases, e.uid);
              syncStore(history, e.stores.history, e.uid);
            }
            return { evidenceId, claimSha256: subject.claimSha256,
              evidenceSha256: digest({ subject, packageSha256: receipt.packageSha256, manifestSha256: receipt.manifestSha256,
                materialSha256: receipt.materialSha256 }) };
          });
        } },
      };
      const journalRegistration = () => { guard(); return registration; };
      const previous = await createLifecycleJournalReader(journalRegistration).read(req);
      if (action === 'prepare-generation') {
        requireFact(previous.status === 'completed' && prepare);
        const checked = material ?? await inspect(false);
        return withPublishedDeployment(checked.receipt, { staging: checked.staging, releasesRoot }, async release => {
          checked.confirm();
          return prepare(e, release, guard);
        });
      }
      if (action === 'readback' || previous.status === 'completed') return previous;
      requireFact(e.stores.history.device === e.stores.releases.device);
      const journal = createLifecycleJournal(journalRegistration, { sign: signJournal! });
      if (previous.status === 'running_or_uncertain') {
        attempted = true;
        reconciling = true;
        return await journal.reconcileCompleted(req, evidenceId);
      }
      const reservation = lifecycleRecordName(operationId, 'reservation');
      await inspect(true, previous.status === 'reserved' ? [reservation] : []);
      const reserved = await journal.reserve(req);
      if (reserved.status !== 'reserved') return reserved;
      attempted = true;
      const claim = await journal.claim(req);
      if (claim.status !== 'claimed') return claim;
      material = await inspect(true, [reservation, lifecycleRecordName(operationId, 'claim')]);
      const { receipt, staging, confirm } = material;
      await journal.readOwnedClaim(claim.token);
      confirm();
      const stage = await stageVerifiedEmittedRuntime(receipt, { staging, destination });
      await journal.readOwnedClaim(claim.token);
      await publishStagedDeployment(receipt, stage);
      return await journal.markCompleted(claim.token, evidenceId);
    });
  } catch (error) {
    if (attempted) return { status: 'running_or_uncertain' };
    throw error;
  }
}

const autoloopKernelSha256 = '3c0e567212af6939f43d570420f54091015900b7886ced793de373e488886116';
const firstDatabases = ['service.sqlite', autoloopHubDatabase, 'answers.sqlite'] as const;
const firstDirectories = ['credentials', 'blobs', 'projections'] as const;
const generationReceiptName = '.patrick-bootstrap.json';
const interruptedGeneration = 'INSTALL_GENERATION_INTERRUPTED';

function initialNode(path: string, uid: number, directory: boolean): GenerationNode {
  const info = stat(path);
  requireFact(realpathSync.native(path) === path && info.uid === BigInt(uid) &&
    (info.mode & 0o7777n) === (directory ? 0o700n : 0o600n) &&
    (directory ? info.isDirectory() : info.isFile() && info.nlink === 1n));
  return { device: String(info.dev), inode: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
}

function configureInitialDatabases(root: string, migrationsDir: string, initializeHub: (database: DatabaseSync) => void) {
  for (const name of firstDatabases) closeSync(openSync(join(root, name), 'wx', 0o600));
  openDatabase(join(root, 'service.sqlite'), { migrationsDir }).close();
  createLocalHubPort(join(root, 'answers.sqlite')).close();
  const hub = new DatabaseSync(join(root, autoloopHubDatabase));
  try { initializeHub(hub); } finally { hub.close(); }
  for (const name of firstDatabases) {
    const database = new DatabaseSync(join(root, name));
    try { database.exec('PRAGMA journal_mode = DELETE'); } finally { database.close(); }
  }
}

function verifyInitialSchemas(root: string, migrationsDir: string, uid: number) {
  const manifest = JSON.parse(readFileSync(join(migrationsDir, 'manifest.json'), 'utf8'));
  for (const name of firstDatabases) {
    const path = join(root, name);
    initialNode(path, uid, false);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      requireFact(database.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok' &&
        database.prepare('PRAGMA journal_mode').get()?.journal_mode === 'delete');
      if (name === 'service.sqlite') {
        const history = database.prepare('SELECT file, sha256 FROM schema_migrations ORDER BY position').all()
          .map(({ file, sha256 }) => ({ file, sha256 }));
        requireFact(canonicalize(history) === canonicalize(manifest));
        database.prepare('SELECT seq FROM domain_events LIMIT 0').all();
      } else if (name === autoloopHubDatabase) {
        requireFact(!database.prepare('SELECT seq, fact FROM facts LIMIT 1').get());
        database.prepare('SELECT id, seq, next, format FROM projection_meta LIMIT 0').all();
        database.prepare('SELECT collection, key, data FROM projections LIMIT 0').all();
        database.prepare('SELECT collection, key, seq FROM projection_refs LIMIT 0').all();
        database.prepare('SELECT key, card_id, channel FROM projection_pending LIMIT 0').all();
      } else {
        requireFact(!database.prepare('SELECT question_id, card_id, body_json, answer_event_id FROM hub_answers LIMIT 1').get());
      }
    } finally { database.close(); }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

async function observeGenerationFiles(root: string, uid: number, existing: boolean, guard: () => void) {
  const retainedLegacy = existing && !lstatSync(join(root, autoloopHubDatabase), { throwIfNoEntry: false });
  const databases = retainedLegacy ? ['service.sqlite', legacyHubDatabase, 'answers.sqlite'] as const : firstDatabases;
  exactDirectory(root, [...databases, ...firstDirectories, ...(existing ? [generationReceiptName] : [])]);
  const roles = {} as InstalledGeneration['roles'];
  const databaseSha256: Record<string, string> = {};
  for (const name of databases) {
    const path = join(root, name);
    roles[name] = initialNode(path, uid, false);
    databaseSha256[name] = sha256(await readRegularFile(path, 64 * 1024 * 1024, { root, validate: guard }));
  }
  for (const name of firstDirectories) {
    const path = join(root, name);
    roles[name] = initialNode(path, uid, true);
    exactDirectory(path, []);
    syncStore(path, roles[name], uid);
  }
  return { roles, databaseSha256 };
}

async function loadAutoloopInitializer(kernelPath: string, guard: () => void) {
  const root = admitReadRoot(dirname(kernelPath));
  const source = await readRegularFile(kernelPath, 64 * 1024, { root: root.root, validate() {
    guard();
    root.validate();
  } });
  if (sha256(source) !== autoloopKernelSha256) throw new Error('AUTOLOOP_BOOTSTRAP_SOURCE_INVALID');
  const code = Buffer.from(stripTypeScriptTypes(source.toString('utf8'))).toString('base64');
  const { initialize } = await import('data:text/javascript;base64,' + code) as { initialize(database: DatabaseSync): void };
  guard();
  return initialize;
}

export async function prepareFirstInstallGeneration(current: Registry, releaseId: string, operationId: string,
  operation: InstallReleaseEnrollment, validateOperation: () => void): Promise<InstalledGeneration> {
  validateOperation();
  const generationId = operation.generation?.id;
  const kernelPath = operation.generation?.kernelPath;
  requireFact(typeof generationId === 'string' && id(generationId));
  let writing = false;
  try {
    const prepared = await runInstallOperation(current, releaseId, operationId, 'prepare-generation', operation, validateOperation,
      async (e, release, guard) => {
        requireFact(e.firstGenerationId === generationId);
        requireFact(!lstatSync(join(e.root, 'current'), { throwIfNoEntry: false }));
        exactDirectory(join(e.root, 'history'), [
          lifecycleRecordName(operationId, 'reservation'), lifecycleRecordName(operationId, 'claim'), lifecycleRecordName(operationId, 'terminal'),
        ]);
        const data = join(e.root, 'data');
        const path = join(data, generationId);
        const migrations = join(release.root, 'migrations');
        const existing = lstatSync(path, { throwIfNoEntry: false });
        const stagingPath = join(data, '.bootstrap-' + generationId);
        if (lstatSync(stagingPath, { throwIfNoEntry: false })) throw new Error(interruptedGeneration);
        exactDirectory(data, existing ? [generationId] : []);
        const stage = existing ? path : stagingPath;
        const journalKey = installVerificationKey(operation.journalPublicKey);
        guard();
        if (!existing) {
          if (typeof operation.signJournal !== 'function') throw new Error('INSTALL_GENERATION_SIGNER_REQUIRED');
          requireFact(typeof kernelPath === 'string');
          const initialize = await loadAutoloopInitializer(kernelPath, guard);
          const disk = statfsSync(data, { bigint: true });
          requireFact(disk.bsize > 0n && disk.bavail * disk.bsize >= BigInt(e.reserveBytes.data));
          writing = true;
          mkdirSync(stage, { mode: 0o700 });
          for (const name of firstDirectories) mkdirSync(join(stage, name), { mode: 0o700 });
          configureInitialDatabases(stage, migrations, initialize);
          verifyInitialSchemas(stage, migrations, e.uid);
        }
        const dataRoot = initialNode(stage, e.uid, true);
        const { roles, databaseSha256 } = await observeGenerationFiles(stage, e.uid, !!existing, guard);
        const generation: InstalledGeneration = { id: generationId, schema: e.targetSchema, packageSha256: release.packageSha256,
          dataRoot, roles, releaseRoot: initialNode(release.root, e.uid, true) };
        const body = { format: 'patrick-first-generation-v1', operationId, planSha256: operation.planSha256, generation, databaseSha256 };
        const payload = Buffer.from(canonicalize(body));
        const receipt = join(stage, generationReceiptName);
        if (existing) {
          initialNode(receipt, e.uid, false);
          const retained = await readRegularFile(receipt, 8192, { root: stage, validate: guard });
          const { signature } = JSON.parse(retained.toString());
          requireFact(verifyInstallSignature(journalKey, payload, signature) && retained.equals(Buffer.from(canonicalize({ body, signature }))));
        } else {
          const signature = await operation.signJournal!(payload);
          guard();
          requireFact(verifyInstallSignature(journalKey, payload, signature));
          const fd = openSync(receipt, 'wx', 0o600);
          try {
            writeFileSync(fd, canonicalize({ body, signature }));
            fsyncSync(fd);
          } finally { closeSync(fd); }
        }
        syncStore(stage, dataRoot, e.uid);
        guard();
        if (!existing) renameSync(stage, path);
        syncStore(data, e.stores.data, e.uid);
        physical(path, dataRoot, e.uid);
        return generation;
      });
    requireFact('id' in prepared);
    return prepared;
  } catch (error) {
    if (writing) throw new Error(interruptedGeneration, { cause: error });
    throw error;
  }
}
