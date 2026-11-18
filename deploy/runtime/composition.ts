import { realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPatrickCli, type CliResult } from '../cli/patrick.mjs';
import { sameIdentity, type HostIdentity, type RegisteredHost } from '../lib/doctor.mjs';
import { createObsidianDoctor } from '../obsidian/doctor.mjs';
import { createVaultKitInstaller } from '../obsidian/install.mjs';
import { ServiceStartupError, createServiceRuntime, type CreateAppOptions } from '@patrick/service/factory';
import { validateBrowserAuthority } from '../../apps/service/src/auth.js';
import { PINNED_HUB_COMMIT, type HubKeys } from '@patrick/integrations/autoloop/client';
import { createRecoveryOperations } from '../../packages/host/src/recovery/operations.js';
import type { RecoveryDatabaseReader } from '../../packages/host/src/recovery/types.js';
import { createNetworkInspector } from '../../packages/host/src/network/probes.js';
import { createNodeNetworkProbePorts } from '../../packages/host/src/network/node-probes.js';
import {
  openDatabase,
  recoveryWriteAllowed,
  type SqliteDatabase,
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

type RuntimeStorageOptions = Pick<CreateAppOptions, 'databasePath' | 'credentialDirectory' | 'recoveryRuntime'>;

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
  const storageOptions = Object.freeze({ databasePath, credentialDirectory, recoveryRuntime });
  const serviceOptions: CreateAppOptions = {
    ...storageOptions, browserAuthority,
    networkRepair: networkRepair && Object.freeze({ ...networkRepair }), feishuCredentials, feishuTestOutbound,
    httpSources, httpSourceWorker, settingsHandlers, prDeliveryWorker, productViewHub, notificationMaintenance, workStopSupervisor,
    bindRecoveryOperations(resources) {
      const operations = bindRecoveryOperations(resources);
      if (!operations || !validToken(operations.authority?.keyId) || typeof operations.authority.sign !== 'function' ||
          typeof operations.authority.verify !== 'function') throw new Error('OPERATIONAL_RECOVERY_BINDING_REQUIRED');
      return bindRecoveryTargets(operations, resources);
    },
  };
  const result = Object.freeze({ registration: registrationData, host });
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
  validateNestedIdentities(provisioning.host, provisioning.registration.identity);
  assertCliRecoveryCurrent();
  const cli = createPatrickCli(provisioning.host);
  return {
    async run(argv: readonly string[]): Promise<CliResult> {
      try { assertCliRecoveryCurrent(); }
      catch {
        return {
          status: 'blocked', code: 'RECOVERY_SERVICE_HANDLE_MISMATCH', exitCode: 5,
          nextStep: 'Provision a fresh controller binding for the current service database.',
        };
      }
      return cli.run(argv);
    },
  };
}

export function createProvisionedServiceRuntime(provisioning: RuntimeProvisioning) {
  return createServiceRuntime(requireRuntimeProvisioning(provisioning).serviceOptions);
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
