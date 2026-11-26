import { createPublicKey, verify } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import type { Socket } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { bindRegistration, projectIdentity, type HostIdentity } from '../lib/doctor.mjs';
import { canonicalize, sha256 } from '../lib/release.mjs';
import { generationHubDatabase, serviceDataDirectory, type GenerationNode, type InstalledGeneration } from './lifecycle-generation.js';
import type { SelectedRuntimePaths } from './role-launch.js';

export type ServiceHandoffAuthority = Readonly<{
  publicKey: string;
  signSelection(bytes: Uint8Array): string | Promise<string>;
}>;

export type SupervisedServiceRegistration = Readonly<{
  root: string;
  rootNode: GenerationNode;
  installationId: string;
  hostId: string;
  identity: HostIdentity;
  captureHost: string;
  uid: number;
  gid: number;
  publicKey: string;
}>;

export type ServiceSelection = {
  format: 'patrick-service-selection-v1';
  challenge: string;
  session: string;
  installationId: string;
  hostId: string;
  identitySha256: string;
  rootNode: GenerationNode;
  uid: number;
  gid: number;
  selectionSha256: string;
  generation: InstalledGeneration;
};

export type SignedServiceSelection = { version: 1; type: 'selection'; selection: ServiceSelection; signature: string };

export const serviceHandoffError = () => new Error('INSTALLED_SERVICE_SUPERVISOR_PROTOCOL_INVALID');
export const serviceReady = Object.freeze({ version: 1, type: 'ready' });
const maxFrame = 8192;
const hex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const accountId = (value: number) => Number.isInteger(value) && value > 0 && value <= 0x7fffffff;

export function serviceFrame(socket: Socket) {
  const stream = socket.iterator({ destroyOnReturn: false }) as AsyncIterator<Buffer>;
  let pending = Buffer.alloc(0);
  async function readOrEnd(): Promise<unknown> {
    for (;;) {
      const end = pending.indexOf(10);
      if (end >= 0) {
        if (end > maxFrame) throw serviceHandoffError();
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        const value: unknown = JSON.parse(line.toString('utf8'));
        if (!line.equals(Buffer.from(canonicalize(value)))) throw serviceHandoffError();
        return value;
      }
      if (pending.length > maxFrame) throw serviceHandoffError();
      const next = await stream.next();
      if (next.done) {
        if (pending.length || !socket.readableEnded) throw serviceHandoffError();
        return undefined;
      }
      if (pending.length + next.value.length > 2 * (maxFrame + 1)) throw serviceHandoffError();
      pending = Buffer.concat([pending, next.value]);
    }
  }
  return {
    readOrEnd,
    async read() {
      const value = await readOrEnd();
      if (value === undefined) throw serviceHandoffError();
      return value;
    },
    async expectEnd() {
      if (pending.length || !(await stream.next()).done || !socket.readableEnded) throw serviceHandoffError();
    },
    write(value: unknown) {
      const line = canonicalize(value);
      if (Buffer.byteLength(line) > maxFrame || socket.destroyed || socket.writableEnded) throw serviceHandoffError();
      socket.write(line + '\n');
    },
  };
}

function fields(value: unknown, keys: string): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(' ') === keys);
}

export function serviceChallenge(frame: unknown): string {
  if (!fields(frame, 'challenge type version') || frame.version !== 1 || frame.type !== 'hello' ||
      !hex(frame.challenge, 64)) throw serviceHandoffError();
  return frame.challenge;
}

type ServiceStatus = 'stop' | 'drained' | 'worker-tick' | 'worker-tick-completed' | 'worker-tick-unavailable';

export function serviceStatus(type: ServiceStatus, { session, selectionSha256 }: ServiceSelection) {
  return { version: 1, type, session, selectionSha256 };
}

export function matchesServiceStatus(frame: unknown, type: ServiceStatus, selection: ServiceSelection) {
  return canonicalize(frame) === canonicalize(serviceStatus(type, selection));
}

export function serviceHandoffKey(value: string) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('-----BEGIN PUBLIC KEY-----')) throw serviceHandoffError();
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw serviceHandoffError();
  return key;
}

export const serviceSelectionBytes = (selection: ServiceSelection) => Buffer.from(canonicalize(selection));
export const serviceIdentityDigest = (identity: HostIdentity) => sha256(Buffer.from(canonicalize(projectIdentity(identity))));

export function verifyServiceSelection(frame: unknown, key: ReturnType<typeof serviceHandoffKey>): SignedServiceSelection {
  if (!fields(frame, 'selection signature type version') || frame.version !== 1 || frame.type !== 'selection' ||
      typeof frame.signature !== 'string' || frame.signature.length !== 88 ||
      !fields(frame.selection, 'challenge format generation gid hostId identitySha256 installationId rootNode selectionSha256 session uid') ||
      frame.selection.format !== 'patrick-service-selection-v1') throw serviceHandoffError();
  const signed = frame as SignedServiceSelection;
  const signature = Buffer.from(signed.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== signed.signature ||
      !verify(null, serviceSelectionBytes(signed.selection), key, signature)) throw serviceHandoffError();
  return signed;
}

function checkNode(path: string, pin: GenerationNode, directory: boolean, uid: number, gid?: number, mode?: number) {
  const info = lstatSync(path, { bigint: true });
  if (!pin || realpathSync.native(path) !== path || info.uid !== BigInt(uid) ||
      (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n) ||
      String(info.dev) !== pin.device || String(info.ino) !== pin.inode || String(info.birthtimeNs) !== pin.birthtimeNs ||
      (info.mode & 0o7022n) !== 0n || (gid !== undefined && info.gid !== BigInt(gid)) ||
      (mode !== undefined && (info.mode & 0o7777n) !== BigInt(mode))) throw serviceHandoffError();
}

export function validateSupervisedServiceAccount(registration: SupervisedServiceRegistration) {
  const { root, captureHost, uid, gid } = registration;
  if (process.platform !== 'darwin' || !accountId(uid) || !accountId(gid) ||
      process.getuid?.() !== uid || process.geteuid?.() !== uid ||
      process.getgid?.() !== gid || process.getegid?.() !== gid || captureHost !== hostname() ||
      typeof root !== 'string' || root === sep || resolve(root) !== root ||
      !identifier(registration.installationId) || !identifier(registration.hostId)) throw serviceHandoffError();
  checkNode(root, registration.rootNode, true, 0);
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    const info = lstatSync(ancestor);
    if (!info.isDirectory() || info.uid !== 0 || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) {
      throw serviceHandoffError();
    }
    if (ancestor === sep) break;
  }
}

export function admitSupervisedServiceSelection(registration: SupervisedServiceRegistration, challenge: string, frame: unknown) {
  const binding = bindRegistration(() => registration);
  const fixed = binding.value;
  validateSupervisedServiceAccount(fixed);
  const signed = verifyServiceSelection(frame, serviceHandoffKey(fixed.publicKey));
  const { selection } = signed;
  const { generation, selectionSha256, session, uid, gid } = selection;
  if (!hex(challenge, 64) || selection.challenge !== challenge || !hex(session, 32) || !hex(selectionSha256, 64) ||
      selection.hostId !== fixed.hostId || selection.installationId !== fixed.installationId ||
      selection.identitySha256 !== serviceIdentityDigest(fixed.identity) ||
      canonicalize(selection.rootNode) !== canonicalize(fixed.rootNode) || uid !== fixed.uid || gid !== fixed.gid ||
      !generation || !identifier(generation.id) || !hex(generation.packageSha256, 64) || !generation.roles?.service) {
    throw serviceHandoffError();
  }
  const releaseRoot = join(fixed.root, 'releases', generation.packageSha256);
  const generationRoot = join(fixed.root, 'data', generation.id);
  const dataRoot = join(generationRoot, serviceDataDirectory);
  const identity = projectIdentity(fixed.identity);
  Object.freeze(identity.domains);
  Object.freeze(identity);
  const paths: SelectedRuntimePaths = Object.freeze({
    role: 'service', identity, installationId: fixed.installationId, generationId: generation.id, selectionSha256,
    packageSha256: generation.packageSha256, dataRoot, databasePath: join(dataRoot, 'service.sqlite'),
    localAnswersPath: join(dataRoot, 'answers.sqlite'), credentialDirectory: join(dataRoot, 'credentials'),
    operationalHubPath: join(generationRoot, generationHubDatabase(generation.roles)),
  });
  const selectedPaths = bindRegistration(() => generation);
  function assertCurrent() {
    binding.validate();
    selectedPaths.validate();
    validateSupervisedServiceAccount(fixed);
    for (const store of ['data', 'releases']) {
      const path = join(fixed.root, store);
      const info = lstatSync(path);
      if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o7022) !== 0) throw serviceHandoffError();
    }
    checkNode(releaseRoot, generation.releaseRoot, true, 0);
    const runtimeRoot = join(releaseRoot, 'runtime');
    const runtime = lstatSync(runtimeRoot, { bigint: true });
    const mode = runtime.mode & 0o7777n;
    if (!runtime.isDirectory() || runtime.uid !== 0n || (mode !== 0o711n && (mode !== 0o710n || runtime.gid !== BigInt(gid)))) {
      throw serviceHandoffError();
    }
    for (const entry of ['composition.mjs', 'service.mjs']) {
      const info = lstatSync(join(runtimeRoot, entry), { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.uid !== 0n || (info.mode & 0o7777n) !== 0o644n) throw serviceHandoffError();
    }
    checkNode(generationRoot, generation.dataRoot, true, 0, undefined, 0o711);
    checkNode(dataRoot, generation.roles.service!, true, uid, gid, 0o700);
    for (const name of ['service.sqlite', 'answers.sqlite', 'credentials', 'blobs', 'projections'] as const) {
      const directory = !name.endsWith('.sqlite');
      checkNode(join(dataRoot, name), generation.roles[name], directory, uid, gid, directory ? 0o700 : 0o600);
    }
  }
  assertCurrent();
  return { signed, paths, releaseRoot, assertCurrent };
}
