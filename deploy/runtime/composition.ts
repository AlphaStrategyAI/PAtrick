import { createLifecycleJournalReader } from './lifecycle-journal.js';
import { closeSync, existsSync, openSync, readdirSync, realpathSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPatrickCli, type CliResult } from '../cli/patrick.mjs';
import { sameIdentity, type HostIdentity, type RegisteredHost } from '../lib/doctor.mjs';
import { createObsidianDoctor } from '../obsidian/doctor.mjs';
import { createVaultKitInstaller } from '../obsidian/install.mjs';
import { ServiceStartupError, createServiceRuntime, type CreateAppOptions, type ServiceCloseHold } from '@patrick/service/factory';
import { validateBrowserAuthority } from '../../apps/service/src/auth.js';
import { createLocalHubPort } from '@patrick/integrations/autoloop/answers';
import { PINNED_HUB_COMMIT, type HubKeys } from '@patrick/integrations/autoloop/client';
import { createRecoveryBackupReader, createRecoveryOperations } from '../../packages/host/src/recovery/operations.js';
import { assertDatabaseIntegrity, verifyRecoverySet } from '../../packages/host/src/recovery/backup.js';
import { assertName, canonical, containedPath, fileHash } from '../../packages/host/src/recovery/files.js';
import type { RecoveryDatabaseReader, RecoveryFreezePort, RecoveryManifestAuthority, RecoveryOffHostPort, RecoveryScope } from '../../packages/host/src/recovery/types.js';
import { createNetworkInspector } from '../../packages/host/src/network/probes.js';
import { createNodeNetworkProbePorts } from '../../packages/host/src/network/node-probes.js';
import {
  openDatabase,
  recoveryWriteAllowed,
  type SqliteDatabase, type RecoveryRuntimeAdmission,
} from '@patrick/storage';

export type RuntimeListenerRegistration = Readonly<{
  host: '127.0.0.1' | '::1';
  port: number;
  origin: string;
}>;

export type RuntimeRegistration = Readonly<{
  identity: HostIdentity;
  captureHost: string;
  serviceUid: number;
  profile: string;
  dataRoot: string;
  minimumFreeBytes: number;
  origin: string;
  rpId: string;
  listener: RuntimeListenerRegistration;
  operationalHub?: Readonly<{ origin: string; commit: string }>;
}>;

type HostCapabilities = Omit<RegisteredHost,
  'identity' | 'captureHost' | 'serviceUid' | 'profile' | 'dataRoot' | 'minimumFreeBytes' |
  'origin' | 'rpId' | 'runtime'>;

export type OperationalRecoveryHubBinding = Readonly<{
  identity: HostIdentity;
  database: SqliteDatabase;
  physicalPath: string;
  readDatabase: RecoveryDatabaseReader;
}>;

export type RuntimeProvisioningInput = Readonly<{
  registration: RuntimeRegistration;
  hostCapabilities?: HostCapabilities;
  operationalRecoveryHub?: OperationalRecoveryHubBinding;
  maintenance?: MaintenanceRegistration;
  service: Readonly<Pick<CreateAppOptions,
    'databasePath' | 'credentialDirectory' | 'recoveryRuntime' | 'bindRecoveryOperations' |
    'networkRepair' | 'feishuCredentials' | 'feishuTestOutbound' | 'httpSources' |
    'settingsHandlers' | 'prDeliveryWorker' | 'productViewHub' | 'notificationMaintenance' |
    'workStopSupervisor' | 'httpSourceWorker'>>;
  worker?: Readonly<{
    keys: Readonly<HubKeys>;
    backend?: NonNullable<CreateAppOptions['consultationWorker']>['backend'];
  }>;
}>;

export type RuntimeProvisioning = Readonly<{
  registration: RuntimeRegistration;
  host: RegisteredHost;
}>;

type RuntimeStorageOptions = Pick<CreateAppOptions, 'databasePath' | 'credentialDirectory' | 'recoveryRuntime' | 'assertStartupAllowed' | 'openMain' | 'signal'>;

type ProvisionedPorts = Readonly<{
  storageOptions: RuntimeStorageOptions;
  serviceOptions: CreateAppOptions;
  assertCliRecoveryCurrent(): void;
  worker?: RuntimeProvisioningInput['worker'];
}>;

const provisioned = new WeakMap<RuntimeProvisioning, ProvisionedPorts>();

export function requireRuntimeProvisioning(provisioning: RuntimeProvisioning): ProvisionedPorts {
  const ports = provisioned.get(provisioning);
  if (!ports) throw new Error('TRUSTED_PROVISIONING_REQUIRED');
  return ports;
}

function validToken(value: unknown, maximum = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function validateIdentity(identity: HostIdentity): void {
  if (!identity || !validToken(identity.accountId) || !validToken(identity.scopeId) ||
      !validToken(identity.deviceId) || !validToken(identity.configRevision) ||
      !Array.isArray(identity.domains) || identity.domains.length < 1 || identity.domains.length > 16 ||
      identity.domains.some((domain) => !validToken(domain, 80)) ||
      new Set(identity.domains).size !== identity.domains.length) {
    throw new Error('HOST_IDENTITY_INVALID');
  }
}

function validateNestedIdentities(host: HostCapabilities | undefined, identity: HostIdentity): void {
  const candidates: HostIdentity[] = [];
  if (host?.network?.identity) candidates.push(host.network.identity);
  for (const target of Object.values(host?.recovery?.targets ?? {})) candidates.push(target.identity);
  for (const target of Object.values(host?.backupReadback?.targets ?? {})) candidates.push(target.identity);
  for (const vault of Object.values(host?.vaults ?? {})) candidates.push(vault.identity);
  for (const release of Object.values(host?.releases ?? {})) candidates.push(release.identity);
  for (const readiness of Object.values(host?.readiness ?? {})) {
    if (readiness?.identity) candidates.push(readiness.identity);
  }
  if (candidates.some((candidate) => !sameIdentity(identity, candidate))) {
    throw new Error('HOST_IDENTITY_MISMATCH');
  }
}

function validateListener(listener: RuntimeListenerRegistration, profile: string, origin: string): void {
  if (!listener || !['127.0.0.1', '::1'].includes(listener.host) ||
      !Number.isSafeInteger(listener.port) || listener.port < 0 || listener.port > 65535 ||
      (listener.port === 0 && profile !== 'test')) {
    throw new Error('LISTENER_REGISTRATION_INVALID');
  }
  if (listener.origin !== origin) throw new Error('LISTENER_ORIGIN_INVALID');
}

function validateOperationalHub(registration: RuntimeRegistration, worker: RuntimeProvisioningInput['worker']): void {
  const hub = registration.operationalHub;
  if (!hub && !worker) return;
  if (!hub || hub.commit !== PINNED_HUB_COMMIT || !validToken(hub.origin, 512)) {
    throw new Error('OPERATIONAL_HUB_REGISTRATION_REQUIRED');
  }
  let origin: URL;
  try { origin = new URL(hub.origin); }
  catch { throw new Error('OPERATIONAL_HUB_ORIGIN_INVALID'); }
  if (origin.origin !== hub.origin || origin.origin === registration.origin ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Error('OPERATIONAL_HUB_ORIGIN_INVALID');
  }
  const keys = worker && [worker.keys?.owner, worker.keys?.worker, worker.keys?.source];
  if (!keys || keys.some((key) => !validToken(key, 4096) || /\s/.test(key)) || new Set(keys).size !== keys.length) {
    throw new Error('OPERATIONAL_HUB_ROLE_KEYS_REQUIRED');
  }
}

type DatabaseFile = { physical: string; device: bigint; inode: bigint };
type RecoveryConfiguration = Parameters<typeof createRecoveryOperations>[0];

function fileIdentity(path: string): DatabaseFile | undefined {
  try {
    const physical = realpathSync(path);
    const stat = statSync(physical, { bigint: true });
    if (stat.isFile()) return { physical, device: stat.dev, inode: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  }
  throw new Error('OPERATIONAL_RECOVERY_STORAGE_MISMATCH');
}

function sameFile(left: DatabaseFile | undefined, right: DatabaseFile): boolean {
  return !!left && left.device === right.device && left.inode === right.inode;
}

function liveDatabaseFile(database: SqliteDatabase): DatabaseFile {
  if (database?.open) {
    const rows = database.pragma('database_list') as Array<{ name: string; file: string }>;
    const main = rows.filter((row) => row.name === 'main');
    if (main.length === 1 && isAbsolute(main[0].file)) {
      const result = fileIdentity(main[0].file);
      if (result) return result;
    }
  }
  throw new Error('OPERATIONAL_RECOVERY_STORAGE_MISMATCH');
}

function createRecoveryTargetBinding(
  identity: HostIdentity, databasePath: string, input?: OperationalRecoveryHubBinding,
) {
  let operational: Readonly<{ database: SqliteDatabase; readDatabase: RecoveryDatabaseReader; file: DatabaseFile }> | undefined;
  if (input) {
    if (!sameIdentity(identity, input.identity)) throw new Error('HOST_IDENTITY_MISMATCH');
    if (typeof input.readDatabase !== 'function') throw new Error('OPERATIONAL_RECOVERY_HUB_REQUIRED');
    const file = liveDatabaseFile(input.database);
    if (file.physical !== input.physicalPath) throw new Error('OPERATIONAL_RECOVERY_STORAGE_MISMATCH');
    operational = { database: input.database, readDatabase: input.readDatabase, file };
    assertHubFile(operational);
  }

  function assertHubFile(bound: NonNullable<typeof operational>, answer?: SqliteDatabase) {
    const current = liveDatabaseFile(bound.database);
    const answerPath = databasePath + '.hub';
    if (current.physical !== bound.file.physical || !sameFile(current, bound.file) ||
        current.physical === databasePath || current.physical === answerPath ||
        sameFile(fileIdentity(databasePath), current) || sameFile(fileIdentity(answerPath), current) ||
        (answer && sameFile(liveDatabaseFile(answer), current))) {
      throw new Error('OPERATIONAL_RECOVERY_STORAGE_MISMATCH');
    }
    return current;
  }

  function captureServiceFile(database: SqliteDatabase) {
    const file = liveDatabaseFile(database);
    let stale = false;
    return {
      database, file,
      assertCurrent() {
        if (!stale) {
          try {
            const current = liveDatabaseFile(database);
            if (current.physical === file.physical && sameFile(current, file) &&
                sameFile(fileIdentity(databasePath), file)) return;
          } catch {
            // Unavailable storage cannot authenticate the existing connection.
          }
          stale = true;
        }
        throw new Error('RECOVERY_SERVICE_HANDLE_MISMATCH');
      },
    };
  }

  // The installed CLI may be constructed more than once from the same provisioning.
  // Only initial provisioning can bind its original live handles and file identities.
  const cliServiceFiles = new Map<string, ReturnType<typeof captureServiceFile>>();
  function assertCliRecoveryCurrent() {
    for (const file of cliServiceFiles.values()) file.assertCurrent();
  }

  function bindTargets<T extends RecoveryConfiguration>(
    configuration: T, resources?: { database: SqliteDatabase; hubDatabase: SqliteDatabase }, captureCli = false,
  ): T {
    const targets = Object.fromEntries(Object.entries(configuration.targets).map(([name, target]) => {
      if (!sameIdentity(identity, target.identity)) throw new Error('HOST_IDENTITY_MISMATCH');
      const backup = target.backup;
      if (!backup) return [name, Object.freeze({ ...target, identity })];
      const { options } = backup;
      const { service, hub } = options.databases;
      if (!operational || operational.database !== hub || operational.readDatabase !== options.readDatabase) {
        throw new Error('OPERATIONAL_RECOVERY_HUB_REQUIRED');
      }
      if (resources && service !== resources.database) throw new Error('RECOVERY_SERVICE_HANDLE_MISMATCH');
      const bound = operational;
      const serviceBinding = resources || captureCli ? captureServiceFile(service) : cliServiceFiles.get(name);
      if (!serviceBinding || serviceBinding.database !== service) throw new Error('RECOVERY_SERVICE_HANDLE_MISMATCH');
      const registeredService = serviceBinding;
      function assertLiveFiles() {
        registeredService.assertCurrent();
        const hubFile = assertHubFile(bound, resources?.hubDatabase);
        if (sameFile(registeredService.file, hubFile)) throw new Error('RECOVERY_SERVICE_HANDLE_MISMATCH');
      }
      assertLiveFiles();
      if (captureCli) cliServiceFiles.set(name, registeredService);
      const freeze = options.freeze;
      const guardedFreeze = freeze && !captureCli ? Object.freeze({
        async acquire(domains: readonly string[]) {
          assertLiveFiles();
          const lease = await freeze.acquire(domains);
          try {
            assertLiveFiles();
            return lease;
          } catch (error) {
            await lease.release();
            throw error;
          }
        },
      }) : freeze;
      const boundOptions = Object.freeze({
        ...options,
        databases: Object.freeze({ service, hub }),
        ...(guardedFreeze ? { freeze: guardedFreeze } : {}),
      });
      return [name, Object.freeze({
        ...target, identity, backup: Object.freeze({ ...backup, scope: structuredClone(backup.scope), options: boundOptions }),
      })];
    }));
    return Object.freeze({ ...configuration, targets: Object.freeze(targets) });
  }

  return { bindTargets, assertCliRecoveryCurrent };
}

type RecoveryAttachment = Parameters<NonNullable<CreateAppOptions['recoveryRuntime']>['attach']>[0];
type CutPhase = 'joining' | 'fencing' | 'capturing' | 'closing';
type CutFile = Readonly<{ path: string; device: string; inode: string }>;
type DomainWriter = Readonly<{ domain: string; writerId: string; writerEpoch: string; witnessRevision: string; activationId: string }>;
type CutRole = Readonly<{ ownerId: string; uid: number }>;
type CutPlan = {
  installationId: string; generationId: string; operationId: string; cutId: string; targetId: string;
  roles: Record<'service' | 'worker' | 'hub', CutRole>;
  writers: DomainWriter[]; scope: RecoveryScope;
  journalRoot: string; setRoot: string; handoffRoot: string;
  protection: 'local_only' | 'off_host_required';
};

export type MaintenanceBinding = Readonly<CutPlan & {
  identity: HostIdentity; captureHost: string; signerId: string;
  files: Record<'service' | 'worker' | 'operationalHub' | 'localAnswers', CutFile>;
  roots: CutFile[];
  runtime: Pick<RuntimeRegistration, 'dataRoot' | 'profile' | 'origin' | 'rpId' | 'listener' | 'operationalHub'>;
}>;
export type MaintenanceObservation =
  | Readonly<{ status: 'absent' | 'blocked'; code: string }>
  | Readonly<{ status: 'unresolved'; phase: CutPhase; code: string }>
  | Readonly<{ status: 'verified'; operationId: string; setId: string; cutId: string; manifestHash: string; fenceReceiptId: string }>;

export type InstalledMaintenanceCut = Readonly<{
  capture(input: { operationId: string; timeoutMs?: number }): Promise<MaintenanceObservation>;
  read(operationId: string): MaintenanceObservation;
}>;

/** An independently enrolled controller denies restarts, new effects and credential handoffs
 * synchronously in begin. Its fence outlives the T22 freeze and any caller timeout. */
export type MaintenanceRegistration = Readonly<{
  plan: CutPlan;
  storage: MaintenanceStorage;
  generation: Readonly<{
    /** The enrolled controller signals withdrawal before permitting a contrary business effect. */
    withdrawal: AbortSignal;
    cleared(binding: MaintenanceBinding, role: 'service' | 'worker'): boolean;
    stop(binding: MaintenanceBinding): void;
  }>;
  signer: RecoveryManifestAuthority;
  offHost?: RecoveryOffHostPort;
  verifyProtection?(binding: MaintenanceBinding, manifestHash: string, receipt: unknown): Promise<boolean>;
  authorize(binding: MaintenanceBinding): boolean;
  begin(binding: MaintenanceBinding): {
    joinWorkerAndFence(): Promise<void>;
    /** False is definitive loss. An unavailable current probe can throw or return undefined. */
    current(binding: MaintenanceBinding): boolean | undefined;
    acquireInner: RecoveryFreezePort['acquire'];
    finish(binding: MaintenanceBinding, closed: boolean, manifestHash?: string): Promise<void>;
  };
  /** Independently verified continuous fence, exact closed owners and required protection. */
  readClose(binding: MaintenanceBinding, manifestHash: string): string | false | undefined;
}>;

function requireCut(condition: unknown): asserts condition {
  if (!condition) throw new Error('MAINTENANCE_BINDING_UNAVAILABLE');
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) immutable(nested);
    Object.freeze(value);
  }
  return value;
}

function pinPath(path: string, directory = false): CutFile {
  const stat = statSync(path, { bigint: true });
  requireCut(isAbsolute(path) && realpathSync(path) === path && (directory ? stat.isDirectory() : stat.isFile()));
  return Object.freeze({ path, device: String(stat.dev), inode: String(stat.ino) });
}

type StorageRole = 'service' | 'worker' | 'localAnswers' | 'operationalHub';
type OpeningEnrollment = Readonly<{
  installationId: string; generationId: string; identity: HostIdentity;
  roles: CutPlan['roles']; files: MaintenanceBinding['files']; ancestors: CutFile[];
}>;
type MaintenanceStorage = Readonly<{ openOperationalHub(): SqliteDatabase }>;
type OwnedDatabase = { db: SqliteDatabase; file: CutFile; assertLive(): void };
type OpeningOwner = {
  enrollment: OpeningEnrollment;
  lookup(role: StorageRole, database: SqliteDatabase): OwnedDatabase;
  main(role: 'service' | 'worker', path: string, checkGeneration: () => void): SqliteDatabase;
  answers(path: string, own: ((db: SqliteDatabase) => void) | undefined,
    checkGeneration: () => void): ReturnType<typeof createLocalHubPort>;
};
const openingOwners = new WeakMap<MaintenanceStorage, OpeningOwner>();
const provisionedStorage = new WeakSet<MaintenanceStorage>();

/** Register the actual opening owner. The enrolled authority holds exclusive pathname
 * ownership while SQLite opens the connection. SQLite's filename alone cannot identify
 * an externally opened pager. All references originate inside these fixed constructors. */
export function createMaintenanceStorage(input: {
  enrollment: OpeningEnrollment;
  acquire(enrollment: OpeningEnrollment, role: StorageRole): { current(): boolean; release(): void };
}): MaintenanceStorage {
  const enrollment = immutable(structuredClone(input.enrollment));
  const acquire = input.acquire.bind(input);
  const opened = new Map<StorageRole, OwnedDatabase>();
  let custodyLost = false;
  const required = new Set<string>();
  for (const file of Object.values(enrollment.files)) {
    requireCut(isAbsolute(file.path));
    for (let path = dirname(file.path); !required.has(path); path = dirname(path)) required.add(path);
  }
  requireCut(canonical([...required].sort()) === canonical(enrollment.ancestors.map((file) => file.path).sort()));
  requireCut(canonical(enrollment.files.service) === canonical(enrollment.files.worker));
  const distinct = [enrollment.files.service, enrollment.files.localAnswers, enrollment.files.operationalHub];
  requireCut(new Set(distinct.map((file) => file.device + ':' + file.inode)).size === 3);

  function open<T>(role: StorageRole, path: string, create: (own: (db: SqliteDatabase) => void) => T,
    checkGeneration?: () => void): T {
    const file = enrollment.files[role];
    requireCut(!custodyLost && path === file.path && !opened.has(role));
    function currentPath() {
      requireCut(!custodyLost);
      try {
        for (const parent of enrollment.ancestors) requireCut(canonical(pinPath(parent.path, true)) === canonical(parent));
        requireCut(canonical(pinPath(path)) === canonical(file));
      } catch (error) { custodyLost = true; throw error; }
    }
    const lease = acquire(enrollment, role);
    let database: SqliteDatabase | undefined;
    try {
      let result: T;
      try {
        checkGeneration?.();
        requireCut(lease.current() === true);
        currentPath();
        result = create((db) => { requireCut(!database); database = db; });
        checkGeneration?.();
        currentPath();
        requireCut(lease.current() === true && database?.open);
      } finally { lease.release(); }
      const db = database!;
      const owner = { db, file, assertLive() { requireCut(db.open); currentPath(); } };
      opened.set(role, owner);
      return result;
    } catch (error) {
      custodyLost = true;
      if (database?.open) database.close();
      throw error;
    }
  }
  const capability = Object.freeze({ openOperationalHub() {
    const path = enrollment.files.operationalHub.path;
    return open('operationalHub', path, (own) => {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      own(db);
      return db;
    });
  } });
  openingOwners.set(capability, { enrollment,
    main(role, path, checkGeneration) {
      return open(role, path, (own) => { const db = openDatabase(path); own(db); return db; }, checkGeneration);
    },
    answers(path, onDatabase, checkGeneration) {
      return open('localAnswers', path, (own) => createLocalHubPort(path, (db) => { own(db); onDatabase?.(db); }), checkGeneration);
    },
    lookup(role, db) {
      const owner = opened.get(role);
      requireCut(owner && owner.db === db);
      owner.assertLive();
      return owner;
    },
  });
  return capability;
}

function disjoint(left: string, right: string) {
  const outside = (from: string, to: string) => {
    const path = relative(from, to);
    return path === '..' || path.startsWith('..' + sep) || isAbsolute(path);
  };
  return outside(left, right) && outside(right, left);
}

function createMaintenanceOwner(input: MaintenanceRegistration, registration: RuntimeRegistration,
  databasePath: string, hub: OperationalRecoveryHubBinding, attach: NonNullable<CreateAppOptions['recoveryRuntime']>['attach']) {
  const plan = immutable(structuredClone(input.plan));
  const { identity, captureHost, serviceUid } = registration;
  const { operationId, cutId, targetId, scope, journalRoot, setRoot, handoffRoot } = plan;
  const { setId } = scope;
  const { keyId } = input.signer;
  const signer = Object.freeze({ keyId, sign: input.signer.sign.bind(input.signer), verify: input.signer.verify.bind(input.signer) });
  const authorize = input.authorize.bind(input);
  const begin = input.begin.bind(input);
  const readClose = input.readClose.bind(input);
  const offHost = input.offHost && Object.freeze({ protect: input.offHost.protect.bind(input.offHost) });
  const verifyProtection = input.verifyProtection?.bind(input);
  requireCut(!offHost || verifyProtection);
  const { readDatabase } = hub;
  for (const name of [operationId, cutId, targetId, setId]) { requireCut(typeof name === 'string'); assertName(name); }
  requireCut(validToken(plan.installationId) && validToken(plan.generationId) && validToken(keyId));
  requireCut(plan.protection === (offHost ? 'off_host_required' : 'local_only'));
  requireCut(Object.keys(scope.versionLocks).length > 0 &&
    Object.entries(scope.versionLocks).every(([key, version]) => validToken(key) && validToken(version)));
  const domainNames = canonical([...identity.domains].sort());
  requireCut(domainNames === canonical(scope.domains.map((domain) => domain.domain).sort()) &&
    domainNames === canonical(plan.writers.map((writer) => writer.domain).sort()));
  for (const writer of plan.writers) {
    const domain = scope.domains.find((entry) => entry.domain === writer.domain)!;
    requireCut(Object.values(writer).every((value) => validToken(value)) && domain.writerEpoch === writer.writerEpoch &&
      writer.writerEpoch !== 'unregistered' && Number.isSafeInteger(domain.withdrawal.seq) && domain.withdrawal.seq >= 0 &&
      /^[a-f0-9]{64}$/.test(domain.withdrawal.hash));
  }
  const roles = [plan.roles.service, plan.roles.worker, plan.roles.hub];
  requireCut(roles.every((role) => validToken(role.ownerId) && Number.isSafeInteger(role.uid) && role.uid >= 0) &&
    new Set(roles.map((role) => role.ownerId)).size === roles.length &&
    plan.roles.service.uid === serviceUid && plan.roles.worker.uid === process.geteuid?.());
  const dedicated = [journalRoot, setRoot, handoffRoot];
  const ordinaryRoots = scope.resources.map((resource) => resource.root);
  requireCut(dedicated.every((path, index) =>
    [...dedicated.slice(index + 1), ...ordinaryRoots, databasePath, databasePath + '.hub', hub.physicalPath]
      .every((other) => disjoint(path, other))));
  const ancestry = new Map<string, CutFile>();
  for (let parent of [...dedicated, ...ordinaryRoots, databasePath, hub.physicalPath].map((path) => dirname(path))) {
    while (!ancestry.has(parent)) {
      ancestry.set(parent, pinPath(parent, true));
      if (dirname(parent) === parent) break;
      parent = dirname(parent);
    }
  }
  const answerPath = join(handoffRoot, 'local-answers.sqlite');
  const roots = [...dedicated, ...ordinaryRoots].map((path) => pinPath(path, true));
  function assertPrivateRoot() {
    for (const root of dedicated) {
      const stat = statSync(root);
      requireCut(stat.uid === serviceUid && (stat.mode & 0o077) === 0);
    }
  }
  assertPrivateRoot();
  const openingOwner = openingOwners.get(input.storage);
  requireCut(openingOwner);
  const opener: OpeningOwner = openingOwner;
  const enrollment = opener.enrollment;
  requireCut(enrollment.installationId === plan.installationId && enrollment.generationId === plan.generationId &&
    sameIdentity(identity, enrollment.identity) && canonical(enrollment.roles) === canonical(plan.roles) &&
    databasePath === enrollment.files.service.path && databasePath + '.hub' === enrollment.files.localAnswers.path &&
    hub.physicalPath === enrollment.files.operationalHub.path);
  const operational = opener.lookup('operationalHub', hub.database);
  const { dataRoot, profile, origin, rpId, listener, operationalHub } = registration;
  const subject: MaintenanceBinding = immutable({ ...plan, identity, captureHost, signerId: keyId, roots,
    runtime: { dataRoot, profile, origin, rpId, listener, operationalHub }, files: enrollment.files });
  const clearance = input.generation.cleared.bind(input.generation);
  const stopGeneration = input.generation.stop.bind(input.generation);
  const withdrawal = input.generation.withdrawal;
  requireCut(withdrawal instanceof AbortSignal);
  type Participant = OwnedDatabase & Pick<RecoveryAttachment, 'admission'> & {
    admitted: Map<string, RecoveryRuntimeAdmission>;
  };
  const attached: Partial<Record<'service' | 'worker', Participant>> = {};
  let answers: OwnedDatabase | undefined;
  let reserved = false;
  let stale = false;
  let withdrawn = false;
  let started = false;
  const shutdown = new AbortController();
  let joinStoppedOwners: (() => void) | undefined;

  function quiesce() {
    if (withdrawn) return;
    withdrawn = true;
    stale = true;
    for (const owner of Object.values(attached)) {
      for (const { domain } of plan.writers) owner.admission.revoke(domain);
    }
    shutdown.abort();
    if (started) {
      try { stopGeneration(subject); } catch { /* Unknown external stop; local exclusion is permanent. */ }
    }
    joinStoppedOwners?.();
  }
  withdrawal.addEventListener('abort', quiesce, { once: true });

  function assertClearance(role: 'service' | 'worker') {
    requireCut(!reserved && !withdrawn);
    try {
      for (const root of [...roots, ...ancestry.values()]) requireCut(canonical(pinPath(root.path, true)) === canonical(root));
      assertPrivateRoot();
      requireCut(clearance(subject, role) === true && !withdrawn);
      // These three private roots are dedicated to this one old-generation cut.
      // A different operation name or a partial set cannot clear previous evidence.
      requireCut(!withdrawal.aborted && dedicated.every((path) => readdirSync(path).length === 0));
    } catch (error) { quiesce(); throw error; }
  }

  function guard(action: () => void) {
    requireCut(!stale);
    try { action(); }
    catch (error) { stale = true; throw error; }
  }
  function checkFiles(closed = false) {
    guard(() => {
      requireCut(answers && attached.service && attached.worker);
      for (const path of [...roots, ...ancestry.values()]) requireCut(canonical(pinPath(path.path, true)) === canonical(path));
      assertPrivateRoot();
      for (const source of [answers, attached.service, attached.worker, operational]) {
        requireCut(canonical(pinPath(source.file.path)) === canonical(source.file));
        if (source.db.open) source.assertLive();
      }
      requireCut(answers.db.open === !closed && attached.service.db.open === !closed && operational.db.open);
    });
  }
  function roleRuntime(role: 'service' | 'worker') {
    return { attach(connection: RecoveryAttachment) {
      requireCut(!reserved && !attached[role]);
      assertClearance(role);
      const { database, admission } = connection;
      const admitted = new Map<string, RecoveryRuntimeAdmission>();
      attached[role] = { ...opener.lookup(role, database), admission, admitted };
      attach({ database, admission: Object.freeze({
        admit(value: RecoveryRuntimeAdmission) {
          requireCut(!reserved && identity.domains.includes(value.domain));
          assertClearance(role);
          admission.admit(value);
          admitted.set(value.domain, Object.freeze({ ...value }));
        },
        revoke(domain: string) { admission.revoke(domain); admitted.delete(domain); },
      }) });
      assertClearance(role);
    } };
  }
  function bindAnswers(resources: { database: SqliteDatabase; hubDatabase: SqliteDatabase }) {
    requireCut(!answers && resources.database === attached.service?.db && resources.hubDatabase !== operational.db);
    answers = opener.lookup('localAnswers', resources.hubDatabase);
    const files = [answers.file, operational.file, attached.service.file];
    requireCut(new Set(files.map((file) => file.device + '-' + file.inode)).size === 3);
  }

  function assertPrivateTargets(configuration: RecoveryConfiguration) {
    const paths = [configuration.root];
    for (const [name, target] of Object.entries(configuration.targets)) {
      requireCut(name !== targetId);
      if (target.backup) paths.push(target.backup.options.root, ...target.backup.scope.resources.map((resource) => resource.root));
      if (target.drill) paths.push(target.drill.recoveryRoot, target.drill.isolationRoot);
    }
    for (const path of paths) requireCut(dedicated.every((root) => disjoint(resolve(path), root) &&
      (!existsSync(path) || disjoint(realpathSync(path), root))));
  }

  function install(reserve: () => ServiceCloseHold | undefined, stopIngress: () => Promise<boolean>,
    onClose: () => void, joinService: () => Promise<boolean>,
    joinWorker: () => Promise<'closed' | 'absent' | 'unresolved'>): InstalledMaintenanceCut {
    joinStoppedOwners = () => {
      void Promise.all([stopIngress(), joinService(), joinWorker()]).then(([ingress, service, worker]) => {
        if (ingress && service && worker !== 'unresolved') onClose();
      }).catch(() => {});
    };
    if (withdrawn) joinStoppedOwners();
    let attempt: Promise<void> | undefined;
    let recheck: (() => Promise<void>) | undefined;
    let rereading: Promise<void> | undefined;
    let closedReceipt: string | undefined;
    let rejectedEvidence = false;
    let observation: MaintenanceObservation = { status: 'absent', code: 'MAINTENANCE_ABSENT' };
    let deadline = Infinity;
    const withinDeadline = () => performance.now() < deadline;
    let lease: ReturnType<typeof begin> | undefined;
    let answerDigest: string | undefined;
    let snapshotFile: CutFile | undefined;
    let manifestHash: string | undefined;
    let phase: CutPhase = 'joining';
    function setPhase(value: CutPhase) {
      phase = value;
      observation = { status: 'unresolved', phase, code: 'MAINTENANCE_IN_PROGRESS' };
    }
    function preflight() {
      assertClearance('service');
      assertClearance('worker');
      requireCut(attached.service && attached.worker && answers);
      checkFiles();
      const service = attached.service, worker = attached.worker;
      requireCut(worker.db.open && worker.db !== service.db && canonical(worker.file) === canonical(service.file));
      for (const participant of [service, worker]) for (const writer of plan.writers) {
        const current = participant.admitted.get(writer.domain);
        requireCut(current?.writerEpoch === writer.writerEpoch && current.activationId === writer.activationId &&
          current.witnessRevision === writer.witnessRevision && recoveryWriteAllowed(participant.db, writer.domain));
      }
      requireCut(readdirSync(handoffRoot).length === 0);
      requireCut(authorize(subject) === true);
    }
    function current(closed = false) {
      checkFiles(closed);
      guard(() => {
        if (snapshotFile) requireCut(canonical(pinPath(answerPath)) === canonical(snapshotFile));
      });
      requireCut(!attached.worker!.db.open && lease);
      const continuous = lease.current(subject);
      if (continuous === undefined) throw new Error('MAINTENANCE_CLOSE_UNAVAILABLE');
      guard(() => { requireCut(continuous === true); });
    }
    function confirmedReceipt(hash: string) {
      const receipt = readClose(subject, hash);
      if (receipt === undefined) throw new Error('MAINTENANCE_CLOSE_UNAVAILABLE');
      if (!validToken(receipt) || (closedReceipt && receipt !== closedReceipt)) {
        stale = true;
        throw new Error('MAINTENANCE_CLOSE_INVALID');
      }
      closedReceipt = receipt;
      return receipt;
    }
    function read(id: string): MaintenanceObservation {
      if (id !== operationId) return { status: 'absent', code: 'MAINTENANCE_ABSENT' };
      if (withdrawn) return { status: 'unresolved', phase: 'closing', code: 'MAINTENANCE_GENERATION_WITHDRAWN' };
      if (observation.status === 'verified') {
        try {
          current(true);
          confirmedReceipt(observation.manifestHash);
        } catch { observation = { status: 'unresolved', phase: 'closing', code: 'MAINTENANCE_CLOSE_UNCONFIRMED' }; }
      }
      return { ...observation };
    }
    async function execute(hold: ServiceCloseHold, joinedIngress: Promise<boolean>) {
      const keepAlive = setInterval(() => {}, 60_000);
      let operations: ReturnType<typeof createRecoveryOperations> | undefined;
      const request = { operationId, targetId, mode: 'backup' } as const;
      const backupScope = { ...scope, resources: [...scope.resources, { kind: 'handoff' as const, root: handoffRoot }] };
      async function signedReadback() {
        const result = await operations!.read(request);
        requireCut(result.status === 'completed' && answerDigest);
        const set = await verifyRecoverySet(await containedPath(setRoot, setId), signer, scope.versionLocks, readDatabase);
        const handoff = set.manifest.artifacts.filter((artifact) => artifact.path.startsWith('resources/' + scope.resources.length + '/'));
        requireCut(set.manifestHash === result.outcome.manifestHash && set.manifest.setId === setId &&
          set.manifest.cutId === cutId && canonical(set.manifest.domains) === canonical(scope.domains) &&
          set.manifest.completeness.recoverable === true && handoff.length === 1 && handoff[0].kind === 'handoff' &&
          handoff[0].path === 'resources/' + scope.resources.length + '/local-answers.sqlite' && handoff[0].hash === answerDigest);
        if (offHost) {
          const receipt: unknown = JSON.parse(await readFile(await containedPath(set.directory, 'off-host-receipt.json'), 'utf8'));
          requireCut(await verifyProtection!(subject, set.manifestHash, receipt) === true);
        }
        return set.manifestHash;
      }
      async function verifyClosed() {
        requireCut(manifestHash);
        current(true);
        try { requireCut(await signedReadback() === manifestHash); }
        catch (error) { rejectedEvidence = true; throw error; }
        current(true);
        const fenceReceiptId = confirmedReceipt(manifestHash);
        observation = { status: 'verified', operationId, setId, cutId, manifestHash, fenceReceiptId };
      }
      try {
        // begin must exclude all new external effects before returning. Its worker join can run
        // concurrently with the actual local request, producer and socket finalizers.
        const acquired = begin(subject);
        lease = Object.freeze({
          current: acquired.current.bind(acquired), joinWorkerAndFence: acquired.joinWorkerAndFence.bind(acquired),
          acquireInner: acquired.acquireInner.bind(acquired), finish: acquired.finish.bind(acquired),
        });
        const joins = await Promise.allSettled([hold.joined, joinedIngress, joinWorker(), lease.joinWorkerAndFence()]);
        setPhase('fencing');
        requireCut(joins.every((entry) => entry.status === 'fulfilled') &&
          joins[1].status === 'fulfilled' && joins[1].value === true &&
          joins[2].status === 'fulfilled' && joins[2].value === 'closed');
        for (const { domain } of plan.writers) {
          attached.service!.admission.revoke(domain);
          attached.worker!.admission.revoke(domain);
          requireCut(!recoveryWriteAllowed(attached.service!.db, domain));
        }
        current();
        requireCut(withinDeadline() && readdirSync(handoffRoot).length === 0);
        const freeze: RecoveryFreezePort = { async acquire(domains) {
          current();
          requireCut(canonical([...domains].sort()) === domainNames);
          const inner = await lease!.acquireInner(domains);
          const release = inner.release.bind(inner);
          try {
            current();
            requireCut(inner.cutId === cutId);
            return { ...inner, async release() {
              try { current(); } finally { await release(); }
              current();
            } };
          } catch (error) { await release(); throw error; }
        } };
        operations = createRecoveryOperations({ root: journalRoot, authority: signer, targets: {
          [targetId]: { identity, backup: { scope: backupScope, options: { root: setRoot, authority: signer,
            databases: { service: attached.service!.db, hub: operational.db }, readDatabase, freeze, offHost } } },
        } });
        requireCut((await operations.read(request)).status === 'absent');
        current();
        requireCut(withinDeadline());
        // Create-only in the pinned, exclusively held private directory. SQLite online
        // backup includes committed WAL state from the original local-answer connection.
        const fd = openSync(answerPath, 'wx', 0o600);
        closeSync(fd);
        snapshotFile = pinPath(answerPath);
        await answers!.db.backup(answerPath);
        current();
        const snapshot = new Database(answerPath, { fileMustExist: true });
        try {
          // Consolidate only the private destination; a read-only open of a WAL-mode copy
          // may leave -wal/-shm sidecars that T22 would otherwise inventory as handoffs.
          requireCut(snapshot.pragma('journal_mode=DELETE', { simple: true }) === 'delete');
          assertDatabaseIntegrity(snapshot);
        } finally { snapshot.close(); }
        requireCut(canonical(readdirSync(handoffRoot)) === canonical(['local-answers.sqlite']));
        answerDigest = (await fileHash(answerPath)).hash;
        current();
        requireCut(withinDeadline() && (await operations.reserve(request)).status === 'reserved');
        current();
        requireCut(withinDeadline());
        setPhase('capturing');
        try {
          await operations.run(request, () => { current(); requireCut(withinDeadline()); });
        } catch {
          // A lost response, a published set, and a signed terminal are distinct outcomes.
        }
        current();
        manifestHash = await signedReadback();
        current();
      } catch {
        observation = { status: 'unresolved', phase, code: 'MAINTENANCE_UNCONFIRMED' };
      } finally {
        // Even begin failure cannot close underneath a pending local producer or socket.
        const [, ingress] = await Promise.allSettled([hold.joined, joinedIngress]);
        const deferReadback = observation.status === 'unresolved' && observation.code === 'MAINTENANCE_UNCONFIRMED';
        setPhase('closing');
        try {
          if (manifestHash) current();
        } catch { manifestHash = undefined; }
        const result = await hold.finalize();
        const closed = result.status === 'closed';
        try {
          try { await lease?.finish(subject, closed, manifestHash); }
          catch { /* Only independent close readback can resolve a lost finish response. */ }
          requireCut(closed && manifestHash && !stale && !rejectedEvidence);
          try {
            // A recovered pre-close probe retains the signed hash. A matching observer
            // must still verify the terminal, all three artifacts and the close receipt.
            if (deferReadback) observation = { status: 'unresolved', phase, code: 'MAINTENANCE_CLOSE_UNCONFIRMED' };
            else await verifyClosed();
          } finally { if (!stale && !rejectedEvidence) recheck = verifyClosed; }
        } catch { observation = { status: 'unresolved', phase, code: 'MAINTENANCE_UNCONFIRMED' }; }
        if (closed && ingress.status === 'fulfilled' && ingress.value) { clearInterval(keepAlive); onClose(); }
      }
    }
    return Object.freeze({ read, async capture({ operationId: id, timeoutMs = 5000 }) {
      requireCut(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 2_147_483_647);
      if (id !== operationId) return { status: 'blocked' as const, code: 'MAINTENANCE_OPERATION_MISMATCH' };
      if (withdrawn) return read(id);
      const first = !reserved;
      if (first) {
        try { preflight(); }
        catch { return withdrawn ? read(id) : { status: 'blocked' as const, code: 'MAINTENANCE_BINDING_UNAVAILABLE' }; }
        reserved = true;
        const hold = reserve();
        if (!hold) {
          observation = { status: 'blocked', code: 'MAINTENANCE_OWNER_STOPPING' };
          return read(id);
        }
        deadline = performance.now() + timeoutMs;
        setPhase('joining');
        const ingress = stopIngress();
        attempt = execute(hold, ingress);
      }
      // A subsequent same-owner observation can re-read the actual signed records and
      // copied files even after both original local SQLite handles have closed.
      if (!first && recheck && !stale && !rejectedEvidence && !rereading) {
        setPhase('closing');
        rereading = recheck().catch(() => {
          observation = { status: 'unresolved', phase: 'closing', code: 'MAINTENANCE_READBACK_UNCONFIRMED' };
        }).finally(() => { rereading = undefined; });
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([rereading ?? attempt, new Promise<void>((done) => {
          timer = setTimeout(done, timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
      return read(id);
    } });
  }
  function assertStartupAllowed(role: 'worker' | 'service') {
    assertClearance(role);
    requireCut(!attached[role]);
    started = true;
  }
  return { roleRuntime, bindAnswers, assertPrivateTargets, assertStartupAllowed, install, signal: shutdown.signal,
    openMain(role: 'service' | 'worker', path: string) {
      try { return opener.main(role, path, () => assertClearance(role)); }
      catch (error) { quiesce(); throw error; }
    },
    openLocalAnswers(path: string, own?: (database: SqliteDatabase) => void) {
      try { return opener.answers(path, own, () => assertClearance('service')); }
      catch (error) { quiesce(); throw error; }
    },
  };
}

const maintenanceOwners = new WeakMap<RuntimeProvisioning, ReturnType<typeof createMaintenanceOwner>>();
type FactoryRuntime = ReturnType<typeof createServiceRuntime>;
const boundMaintenance = new WeakMap<FactoryRuntime, {
  owner: ReturnType<typeof createMaintenanceOwner>; provisioning: RuntimeProvisioning; reserve: () => ServiceCloseHold | undefined;
}>();

/** Lookup requires both the original factory owner and the successfully started listener. */
export async function installRuntimeMaintenance(runtime: FactoryRuntime,
  ingress: Readonly<{ stopIngress(): Promise<boolean>; onClose(): void }>) {
  const bound = boundMaintenance.get(runtime);
  if (!bound) return undefined;
  const { ownsMaintenanceIngress } = await import('./service.js');
  if (!ownsMaintenanceIngress(runtime, ingress) || runtime.read().status !== 'running') return undefined;
  boundMaintenance.delete(runtime);
  return bound.owner.install(bound.reserve, ingress.stopIngress, ingress.onClose,
    async () => (await runtime.drain({ timeoutMs: 2_147_483_647 })).status === 'closed',
    async () => {
      const { drainGenerationWorker } = await import('./worker.js');
      const worker = await drainGenerationWorker(bound.provisioning);
      if (!worker) return 'absent';
      return worker.status === 'closed' ? 'closed' : 'unresolved';
    });
}

export function createRuntimeProvisioning(input: RuntimeProvisioningInput): RuntimeProvisioning {
  const { registration, hostCapabilities = {}, operationalRecoveryHub, service, worker } = input;
  if (!registration) throw new Error('HOST_REGISTRATION_REQUIRED');
  validateIdentity(registration.identity);
  const browserAuthority = validateBrowserAuthority(registration, registration.profile === 'test');
  validateListener(registration.listener, registration.profile, browserAuthority.origin);
  if (registration.captureHost !== hostname() || registration.serviceUid !== process.geteuid?.() ||
      !Number.isSafeInteger(registration.serviceUid) || registration.serviceUid < 0 ||
      !validToken(registration.profile, 80) || typeof registration.dataRoot !== 'string' ||
      !isAbsolute(registration.dataRoot) || !Number.isSafeInteger(registration.minimumFreeBytes) ||
      registration.minimumFreeBytes < 0) {
    throw new Error('HOST_REGISTRATION_INVALID');
  }
  if (!service || !isAbsolute(service.databasePath ?? '') ||
      !isAbsolute(service.credentialDirectory ?? '') ||
      typeof service.recoveryRuntime?.attach !== 'function' ||
      typeof service.bindRecoveryOperations !== 'function') {
    throw new Error('SERVICE_RECOVERY_CAPABILITIES_REQUIRED');
  }
  const network = service.networkRepair;
  if (network && (network.accountId !== registration.identity.accountId ||
      !registration.identity.domains.includes(network.domain) || network.localDeviceId !== registration.identity.deviceId)) {
    throw new Error('NETWORK_REGISTRATION_MISMATCH');
  }
  validateOperationalHub(registration, worker);
  const domains = [...registration.identity.domains];
  Object.freeze(domains);
  const identity = Object.freeze({ ...registration.identity, domains });
  validateNestedIdentities(hostCapabilities, identity);
  if (input.maintenance) {
    const opener = openingOwners.get(input.maintenance.storage);
    requireCut(opener && operationalRecoveryHub && !provisionedStorage.has(input.maintenance.storage));
    opener.lookup('operationalHub', operationalRecoveryHub.database);
  }
  const { bindTargets: bindRecoveryTargets, assertCliRecoveryCurrent } =
    createRecoveryTargetBinding(identity, service.databasePath!, operationalRecoveryHub);
  const registeredRecovery = hostCapabilities.recovery && bindRecoveryTargets(hostCapabilities.recovery, undefined, true);
  const registrationData = Object.freeze({
    ...registration,
    identity,
    listener: Object.freeze({ ...registration.listener }),
    ...(registration.operationalHub ? { operationalHub: Object.freeze({ ...registration.operationalHub }) } : {}),
  });
  const host: RegisteredHost = Object.freeze({
    ...hostCapabilities,
    ...(registeredRecovery ? { recovery: registeredRecovery } : {}),
    identity,
    captureHost: registrationData.captureHost,
    serviceUid: registrationData.serviceUid,
    profile: registrationData.profile,
    dataRoot: registrationData.dataRoot,
    minimumFreeBytes: registrationData.minimumFreeBytes,
    origin: registrationData.origin,
    rpId: registrationData.rpId,
    runtime: Object.freeze({
      createRecoveryOperations(configuration: RecoveryConfiguration) { return createRecoveryOperations(bindRecoveryTargets(configuration)); },
      createRecoveryBackupReader,
      createLifecycleJournalReader,
      createNetworkInspector,
      createNodeNetworkProbePorts,
      createObsidianDoctor,
      createVaultKitInstaller,
    }),
  });
  const {
    databasePath, credentialDirectory, recoveryRuntime, bindRecoveryOperations, networkRepair,
    feishuCredentials, feishuTestOutbound, httpSources, settingsHandlers, prDeliveryWorker,
    productViewHub, notificationMaintenance, workStopSupervisor, httpSourceWorker,
  } = service;
  let maintenance: ReturnType<typeof createMaintenanceOwner> | undefined;
  if (input.maintenance) {
    requireCut(worker && operationalRecoveryHub && recoveryRuntime);
    maintenance = createMaintenanceOwner(input.maintenance, registrationData, databasePath!, operationalRecoveryHub,
      recoveryRuntime.attach.bind(recoveryRuntime));
    if (registeredRecovery) maintenance.assertPrivateTargets(registeredRecovery);
  }
  const storageOptions = Object.freeze({ databasePath, credentialDirectory,
    signal: maintenance?.signal,
    openMain: maintenance && ((path: string) => maintenance.openMain('worker', path)),
    recoveryRuntime: maintenance?.roleRuntime('worker') ?? recoveryRuntime,
    assertStartupAllowed: maintenance && (() => maintenance.assertStartupAllowed('worker')) });
  const serviceOptions: CreateAppOptions = {
    ...storageOptions, browserAuthority,
    openMain: maintenance && ((path) => maintenance.openMain('service', path)),
    openLocalAnswers: maintenance?.openLocalAnswers,
    recoveryRuntime: maintenance?.roleRuntime('service') ?? recoveryRuntime,
    assertStartupAllowed: maintenance && (() => maintenance.assertStartupAllowed('service')),
    networkRepair: networkRepair && Object.freeze({ ...networkRepair }), feishuCredentials, feishuTestOutbound,
    httpSources, httpSourceWorker, settingsHandlers, prDeliveryWorker, productViewHub, notificationMaintenance, workStopSupervisor,
    bindRecoveryOperations(resources) {
      maintenance?.bindAnswers(resources);
      const operations = bindRecoveryOperations(resources);
      if (!operations || !validToken(operations.authority?.keyId) || typeof operations.authority.sign !== 'function' ||
          typeof operations.authority.verify !== 'function') throw new Error('OPERATIONAL_RECOVERY_BINDING_REQUIRED');
      maintenance?.assertPrivateTargets(operations);
      return bindRecoveryTargets(operations, resources);
    },
  };
  const result = Object.freeze({ registration: registrationData, host });
  if (maintenance && input.maintenance) {
    requireCut(!provisionedStorage.has(input.maintenance.storage));
    provisionedStorage.add(input.maintenance.storage);
    maintenanceOwners.set(result, maintenance);
  }
  provisioned.set(result, Object.freeze({
    storageOptions,
    serviceOptions: Object.freeze(serviceOptions),
    assertCliRecoveryCurrent,
    ...(worker ? { worker: Object.freeze({ ...worker, keys: Object.freeze({ ...worker.keys }) }) } : {}),
  }));
  return result;
}

export function createRuntimeCli(provisioning: RuntimeProvisioning) {
  const { assertCliRecoveryCurrent } = requireRuntimeProvisioning(provisioning);
  const { host } = provisioning;
  validateNestedIdentities(host, provisioning.registration.identity);
  if (!host.backupReadback && Object.getOwnPropertyNames(host.lifecycleReadbacks ?? {}).length === 0) assertCliRecoveryCurrent();
  return createPatrickCli(host, (): CliResult | undefined => {
    try { assertCliRecoveryCurrent(); }
    catch {
      return {
        status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH', exitCode: 5,
        nextStep: 'Provision a fresh controller binding for the current service database.',
      };
    }
  });
}

export function createProvisionedServiceRuntime(provisioning: RuntimeProvisioning) {
  const { serviceOptions } = requireRuntimeProvisioning(provisioning);
  const owner = maintenanceOwners.get(provisioning);
  if (!owner) return createServiceRuntime(serviceOptions);
  let reserve!: () => ServiceCloseHold | undefined;
  const runtime = createServiceRuntime({ ...serviceOptions, registerCloseHold(port) { reserve = port; } });
  boundMaintenance.set(runtime, { owner, reserve, provisioning });
  return runtime;
}

export async function cleanRuntimeStartup(error: unknown) {
  if (error instanceof ServiceStartupError) return {
    code: diagnosticCode(error.cause, 'SERVICE_START_FAILED'),
    cleanup: await error.cleanup.drain(),
    readCleanup: error.cleanup.read,
  };
  return { code: diagnosticCode(error, 'SERVICE_START_FAILED') };
}

function diagnosticCode(error: unknown, fallback: string): string {
  // Keep diagnostics bounded and avoid reflecting arbitrary operational error messages.
  const known = ['TRUSTED_PROVISIONING_REQUIRED', 'OPERATIONAL_RECOVERY_BINDING_REQUIRED',
    'RECOVERY_SERVICE_HANDLE_MISMATCH', 'OPERATIONAL_RECOVERY_HUB_REQUIRED',
    'OPERATIONAL_RECOVERY_STORAGE_MISMATCH', 'HOST_IDENTITY_MISMATCH'];
  return error instanceof Error && known.includes(error.message) ? error.message : fallback;
}

export function isRuntimeMain(url: string): boolean {
  if (!process.argv[1]) return false;
  try { return url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}

export function openRuntimeDatabase(path: string): SqliteDatabase {
  if (!isAbsolute(path)) throw new Error('DATABASE_PATH_INVALID');
  return openDatabase(path);
}

export function runtimeRecoveryWriteAllowed(database: SqliteDatabase, domain: string): boolean {
  return recoveryWriteAllowed(database, domain);
}

export function unavailableRuntimeDiagnostic(
  nextStep = 'Invoke this entry from the independently enrolled in-process host controller.',
) {
  return Object.freeze({
    status: 'unavailable',
    code: 'TRUSTED_PROVISIONING_REQUIRED',
    nextStep,
    exitCode: 3,
  });
}
