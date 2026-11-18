import { execFileSync } from 'node:child_process';
import { accessSync, constants, lstatSync, opendirSync, realpathSync, statfsSync } from 'node:fs';
import { request } from 'node:https';
import { hostname, machine } from 'node:os';
import { dirname, join } from 'node:path';
import type { GenerationNode } from './lifecycle-generation.js';
import { projectIdentity, type HostIdentity } from '../lib/doctor.mjs';
import { renderDeploymentTemplates, deploymentPaths, type DeploymentRegistration } from '../lib/deployment-templates.mjs';
import { leased, verifyEmittedRuntimeCandidate, type ExclusiveRuntimeStaging,
  type EmittedReleaseExpectation, type EmittedReleaseTrustPolicy } from '../lib/emitted-release.mjs';
import { admitReadRoot, canonicalize, readRegularFile, sha256 } from '../lib/release.mjs';

interface Lease { root: string; guard(): void }
declare module '../lib/emitted-release.mjs' {
  export function leased<T>(owner: ExclusiveRuntimeStaging, use: (lease: Lease) => Promise<T>, joinWork: boolean): Promise<T>;
}

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
  deployment: DeploymentRegistration; templates: Record<'caddy' | 'service' | 'hub' | 'worker', string>;
  tls: { rpId: string; caSha256: string };
  session?: { bootstrapPlanSha256: string; ca: string; callerId: string; authEpoch: number; credentialRevision: string;
    readBearer(signal: AbortSignal): Promise<string> };
};

const bootstrapRequirements = ['schema-bootstrap', 'fixed-origin-tls', 'owner-passkey', 'authenticated-session'] as const;
type LocalPlan = {
  installationId: string; releaseId: string; packageSha256: string; planSha256: string;
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
function exactDirectory(path: string, expected: readonly string[]) {
  const remaining = new Set(expected);
  const dir = opendirSync(path);
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) requireFact(remaining.delete(entry.name));
    requireFact(!remaining.size);
  } finally { dir.closeSync(); }
}
function layout(e: InstallPreviewEnrollment, root: string, empty: boolean) {
  requireFact(root === e.root && e.deployment.instanceRoot === root);
  physical(root, e.rootNode, e.uid);
  if (empty) exactDirectory(root, stores);
  for (const name of stores) {
    const path = join(root, name);
    physical(path, e.stores[name], e.uid);
    if (empty) exactDirectory(path, name === 'packages' ? [e.expected.packageSha256 + '.json'] : []);
  }
}
type VolumeReading = { device: string; required: bigint; available: bigint };
/** Pure arithmetic. Distinct Darwin device IDs cannot prove separate APFS allocation pools. */
export function budgetInstallVolume(readings: Record<Budget, VolumeReading>) {
  const device = readings.releases.device;
  let available = readings.releases.available;
  let required = 0n;
  for (const role of budgets) {
    const reading = readings[role];
    requireFact(reading.device === device && reading.available >= 0n && reading.required > 0n);
    required += reading.required;
    if (reading.available < available) available = reading.available;
  }
  requireFact(required <= available);
  return [{ roles: [...budgets], requiredBytes: String(required) }];
}
function capacity(e: InstallPreviewEnrollment, materialBytes: bigint) {
  const read = (role: Budget): VolumeReading => {
    const reserve = e.reserveBytes[role];
    requireFact(Number.isSafeInteger(reserve) && reserve > 0);
    const disk = statfsSync(join(e.root, role), { bigint: true });
    requireFact(disk.bsize > 0n && disk.bavail >= 0n);
    return { device: e.stores[role].device, required: BigInt(reserve) + (role === 'releases' ? materialBytes : 0n),
      available: disk.bsize * disk.bavail };
  };
  return budgetInstallVolume({ releases: read('releases'), data: read('data'), lima: read('lima') });
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
    const descriptor = () => {
      for (let at: object | null = object; at; at = Object.getPrototypeOf(at)) {
        const found = Object.getOwnPropertyDescriptor(at, key);
        if (found) return found;
      }
    };
    const first = descriptor();
    requireFact(first ? Object.hasOwn(first, 'value') : optional);
    checks.push(() => {
      const live = descriptor();
      requireFact(first ? live && Object.hasOwn(live, 'value') && Object.is(live.value, first.value) : !live);
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
  const owner = field(original, 'owner');
  trackPrototype(owner);
  const readRoot = field(owner, 'withExclusiveReadRoot');
  requireFact(typeof readRoot === 'function');
  const session = field(original, 'session', true);
  let credential: InstallPreviewEnrollment['session'];
  if (session !== undefined) {
    trackPrototype(session);
    const metadata = dataFields(session, ['bootstrapPlanSha256', 'ca', 'callerId', 'authEpoch', 'credentialRevision']);
    const readBearer = field(session, 'readBearer');
    requireFact(typeof readBearer === 'function');
    credential = { ...metadata, readBearer: signal => Reflect.apply(readBearer, session, [signal]) };
  }
  const value: InstallPreviewEnrollment = { ...data, session: credential, owner: {
    withExclusiveReadRoot<T>(read: (root: string) => Promise<T>) { return Reflect.apply(readRoot<T>, owner, [read]); },
  } };
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
    const { value: e, validate } = bindInstallPreviewEnrollment(current);
    requireFact(e && id(e.installationId) && id(releaseId) && releaseId === e.releaseId);
    const identity = projectIdentity(e.identity);
    identity.domains.sort();
    requireFact(e.expected.profile === 'deployment-complete' && /^[a-f0-9]{64}$/.test(e.expected.packageSha256) &&
      Number.isSafeInteger(e.targetSchema) && e.targetSchema >= e.expected.activeSchema &&
      e.targetSchema >= e.expected.schema.min && e.targetSchema <= e.expected.schema.max);
    stage = 'HOST';
    nativeHost(e);
    stage = 'LEASE';
    const result = await leased(e.owner, async lease => {
      const guard = () => { validate(); lease.guard(); };
      guard();
      stage = 'LAYOUT';
      layout(e, lease.root, phase === 'bootstrap');
      stage = 'HOST';
      const nodeRoot = admitReadRoot(dirname(e.node.path));
      const binary = stat(e.node.path);
      requireFact(binary.isFile() && (binary.mode & 0o111n) !== 0n && (binary.mode & 0o022n) === 0n &&
        sha256(await readRegularFile(e.node.path, 256 * 1024 * 1024, nodeRoot)) === e.node.sha256);
      stage = 'PACKAGE';
      const staging: ExclusiveRuntimeStaging = { async withExclusiveReadRoot(read) {
        guard();
        try { return await read(lease.root); } finally { guard(); }
      } };
      const archive = join(e.root, 'packages', e.expected.packageSha256 + '.json');
      const artifact = stat(archive);
      const receipt = await verifyEmittedRuntimeCandidate(archive,
        { staging, expected: e.expected, policy: e.policy });
      const materialBytes = receipt.materials.reduce((total, file) => total + BigInt(file.bytes), 0n);
      stage = 'CAPACITY';
      const volumes = capacity(e, materialBytes);
      stage = 'DEPLOYMENT';
      const source = (role: keyof typeof e.templates) => Buffer.from(e.templates[role]);
      const rendered = renderDeploymentTemplates({ caddy: source('caddy'), service: source('service'),
        hub: source('hub'), worker: source('worker') }, e.deployment);
      const descriptors = Object.values(deploymentPaths).map(path => {
        const row = receipt.materials.find(file => file.path === path);
        requireFact(row);
        return row;
      });
      requireFact(new URL(e.deployment.origin).hostname === e.tls.rpId && /^[0-9a-f]{64}$/.test(e.tls.caSha256));
      const planSha256 = digest({ format: 'patrick-first-install-preview-v2', installationId: e.installationId, releaseId,
        identity, uid: e.uid, hostname: e.hostname, node: e.node, root: e.root, rootNode: e.rootNode, stores: e.stores,
        policy: e.policy, expected: e.expected, manifestSha256: receipt.manifestSha256, targetSchema: e.targetSchema,
        reserveBytes: e.reserveBytes, volumes, deployment: e.deployment, renderedSha256: digest(rendered), descriptors,
        required: bootstrapRequirements, tls: e.tls });
      let credentialBindingSha256: string | undefined;
      if (phase === 'authenticated-session') {
        stage = 'SESSION';
        const credential = e.session;
        requireFact(credential && credential.bootstrapPlanSha256 === planSha256);
        guard();
        await checkSession(e, credential, guard);
        credentialBindingSha256 = digest({ planSha256, callerId: credential.callerId, authEpoch: credential.authEpoch,
          credentialRevision: credential.credentialRevision });
      }
      stage = 'LAYOUT';
      layout(e, lease.root, phase === 'bootstrap');
      stage = 'HOST';
      nativeHost(e);
      nodeRoot.validate();
      const checked = stat(archive);
      requireFact(checked.dev === artifact.dev && checked.ino === artifact.ino && checked.ctimeNs === artifact.ctimeNs);
      const now = stat(e.node.path);
      requireFact(now.dev === binary.dev && now.ino === binary.ino && now.ctimeNs === binary.ctimeNs);
      stage = 'CAPACITY';
      capacity(e, materialBytes);
      stage = 'LEASE';
      guard();
      const local = { installationId: e.installationId, releaseId, packageSha256: receipt.packageSha256,
        planSha256, activeSchema: e.expected.activeSchema, targetSchema: e.targetSchema, volumes,
        activationAuthorized: false as const, delegationAuthorized: false as const };
      if (credentialBindingSha256 !== undefined) return { ...local, status: 'session-observed' as const,
        phase: 'authenticated-session' as const, credentialBindingSha256, observed: ['fixed-origin-tls', 'authenticated-session'] as const,
        outstanding: ['schema-bootstrap', 'owner-passkey'] as const };
      return { ...local, status: 'preview' as const, phase: 'bootstrap' as const, outstanding: [...bootstrapRequirements] as const };
    }, true);
    validate();
    return result;
  } catch { return { status: 'blocked', code: `INSTALL_PREVIEW_${stage}` }; }
}
