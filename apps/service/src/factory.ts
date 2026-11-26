import { createTaskLifetime, type WorkerLifetime } from './lifecycle.js';
import { randomUUID } from 'node:crypto';
import { attachRecoveryRuntime, type RecoveryRuntimeConfiguration } from './recovery-runtime.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { generateOpenApi } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import { createCredentialStore } from '@patrick/host';
import { createManualConsultationWorker, startConsultationWorker, type ConsultationWorkerOptions } from '@patrick/integrations/autoloop/consultation-runtime';
import { createLocalHubPort, encodeHubAnswer, type LocalHubPort } from '@patrick/integrations/autoloop/answers';
import type { FeishuTestOutbound } from '../../../packages/integrations/feishu/outbound.js';
import { createSourceRegistry, type RegistryOptions } from '@patrick/integrations/sources/registry';
import type { GithubApiPort } from '@patrick/integrations/sources/github';
import { createVaultApi } from '@patrick/integrations/vault/drafts';
import { createBlobStore, openDatabase, type SqliteDatabase } from '@patrick/storage';
import { createAnswerGate } from '../../../packages/domain/src/answer-gate.js';
import {
  LOCAL_BROWSER_AUTHORITY, mountAuthRoutes, runWithAuth, validateBrowserAuthority,
  type AuthContext, type BrowserAuthority,
} from './auth.js';
import { mountControlRoutes } from './control.js';
import { createPrDeliveryService, type PrDeliveryOptions } from './pr-delivery.js';
import { mountAnswerRoutes } from './routes/answers.js';
import { mountConsultationRoutes } from './routes/consultations.js';
import { mountConversationRoutes } from './routes/conversations.js';
import { mountFeishuRoutes } from './routes/feishu.js';
import { mountDelegationRoutes } from './routes/delegations.js';
import { mountEditRoutes } from './routes/edits.js';
import { mountKnowledgeRoutes } from './routes/knowledge.js';
import { mountStandardRoutes } from './routes/standards.js';
import { mountVaultRoutes } from './routes/vaults.js';
import { mountWorkControlRoutes } from './routes/work-controls.js';
import { startWorkStopObserver, type WorkStopSupervisor } from './work-stop.js';
import { mountPreferenceRoutes } from './routes/preferences.js';
import { createNotificationMaintenance, type NotificationMaintenanceOptions } from './notification-maintenance.js';
import { mountNotificationRoutes } from './routes/notifications.js';
import { mountDiagnosticsRoutes } from './routes/diagnostics.js';
import { mountSourceRoutes } from './routes/sources.js';
import { mountSettingsRoutes } from './routes/settings.js';
import { createSettingsChanges, type SettingsHandler } from './settings/changes.js';
import { builtinSettingsHandlers } from './settings/builtin.js';
import { networkSettingsHandlers, registeredNetworkTargets, type NetworkRepairConfiguration } from './settings/network.js';
import { recoverySettingsHandlers, registeredRecoveryTargets, type RecoverySettingsConfiguration } from './settings/recovery.js';
import { parseNetworkPolicy } from '../../../packages/host/src/network/vpn.js';
import { createHttpCollectionWorker, type HttpCollectionWorkerOptions } from './source-collection.js';
import { sourceSettingsHandlers } from './settings/sources.js';
import { createProductViewService, startProductViewHubObserver, type ProductViewHub } from './product-views.js';
import { mountStatsRoutes } from './routes/stats.js';
import { mountWorkProjectionRoutes } from './routes/work.js';
import { mountProjectionEventRoutes } from './routes/events.js';
import { createSourceWorkDispatch, type SourceWorkDispatchOptions } from './source-work.js';
import type { probeExecutorReadiness } from '@patrick/executor/readiness';

export { createAuthenticatedConsultationMcp } from './consultation-mcp.js';

export type CreateAppOptions = {
  /** Installed-generation guard runs before opening either database. */
  assertStartupAllowed?: () => void;
  openMain?: (path: string) => SqliteDatabase;
  openLocalAnswers?: typeof createLocalHubPort;
  /** Private installed owner receives this only after successful startup. */
  registerCloseHold?: (reserve: () => ServiceCloseHold | undefined) => void;
  browserAuthority?: BrowserAuthority;
  ownerBootstrapCurrent?: AuthContext['ownerBootstrapCurrent'];
  signal?: AbortSignal;
  /** Trusted installed composition receives the exact gated handles before worker admission. */
  bindRecoveryOperations?: (resources: { database: SqliteDatabase; hub: LocalHubPort; hubDatabase: SqliteDatabase }) => RecoverySettingsConfiguration | undefined;
  databasePath?: string;
  localAnswersPath?: string;
  recoveryRuntime?: RecoveryRuntimeConfiguration;
  recoveryOperations?: RecoverySettingsConfiguration;
  credentialDirectory?: string;
  now?: () => Date;
  consultationWorker?: ConsultationWorkerOptions & { mode?: 'manual' | 'periodic' };
  productViewHub?: ProductViewHub;
  notificationMaintenance?: NotificationMaintenanceOptions;
  networkRepair?: NetworkRepairConfiguration;
  feishuCredentials?: CredentialStore;
  feishuTestOutbound?: FeishuTestOutbound;
  workStopSupervisor?: WorkStopSupervisor;
  httpSources?: RegistryOptions['http'];
  httpSourceWorker?: HttpCollectionWorkerOptions;
  settingsHandlers?: Readonly<Partial<Record<string, SettingsHandler>>>;
  prDeliveryWorker?: Omit<PrDeliveryOptions, 'blobs'>;
  /** Backend probes used by the settings and system inspections. */
  executorProbes?: typeof probeExecutorReadiness;
  /** The live GitHub reader. Without it the connector stays on the fixture tree. */
  githubApi?: GithubApiPort;
  /** The provider that holds the GitHub token a source references. */
  sourceCredentialStore?: CredentialStore;
  sourceWorkDispatch?: SourceWorkDispatchOptions;
};

export type ServiceDrainResult = {
  status: 'running' | 'draining' | 'closed' | 'close_failed';
  active: number;
  errors: readonly { code: string }[];
};

export type ServiceCloseHold = Readonly<{
  joined: Promise<void>;
  finalize(): Promise<ServiceDrainResult>;
}>;

export type ServiceCleanup = {
  stop(): void;
  drain(options?: { timeoutMs?: number }): Promise<ServiceDrainResult>;
  read(): ServiceDrainResult;
};

/** A failed owner can still await cleanup or inspect an unresolved resource-close failure. */
export class ServiceStartupError extends Error {
  constructor(cause: unknown, readonly cleanup: ServiceCleanup) {
    super(cause instanceof Error ? cause.message : 'SERVICE_START_FAILED', { cause });
    this.name = 'ServiceStartupError';
  }
}

export function createServiceRuntime(options: CreateAppOptions = {}) {
  const browserAuthority = options.browserAuthority
    ? validateBrowserAuthority(options.browserAuthority, true) : LOCAL_BROWSER_AUTHORITY;
  const lifetime = createTaskLifetime(options.signal);
  const workers: WorkerLifetime[] = [];
  const starters: Array<() => void> = [];
  let manualConsultation: ReturnType<typeof createManualConsultationWorker> | undefined;
  let completion: Promise<void> | undefined;
  let joined: Promise<void> | undefined;
  let barrier: Promise<void> | undefined;
  let holdEligible = false;
  let status: ServiceDrainResult['status'] = 'running';
  const errors: Array<{ code: string }> = [];
  function recordError(code: string) {
    if (errors.length < 16) errors.push({ code });
  }
  const callerSignal = options.signal;
  let recoveryOperations = options.recoveryOperations;
  const combined = (signal?: AbortSignal) => signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
  options = { ...options,
    consultationWorker: options.consultationWorker && { ...options.consultationWorker, signal: combined(options.consultationWorker.signal) },
    prDeliveryWorker: options.prDeliveryWorker && { ...options.prDeliveryWorker, signal: combined(options.prDeliveryWorker.signal) },
    productViewHub: options.productViewHub && { ...options.productViewHub, signal: combined(options.productViewHub.signal) },
    httpSourceWorker: options.httpSourceWorker && { ...options.httpSourceWorker, signal: combined(options.httpSourceWorker.signal) },
    notificationMaintenance: options.notificationMaintenance && { ...options.notificationMaintenance, signal: combined(options.notificationMaintenance.signal) },
    workStopSupervisor: options.workStopSupervisor && { ...options.workStopSupervisor, signal: combined(options.workStopSupervisor.signal) },
    sourceWorkDispatch: options.sourceWorkDispatch && { ...options.sourceWorkDispatch, signal: combined(options.sourceWorkDispatch.signal) },
  };
  if (options.networkRepair && (!options.databasePath?.trim() || options.databasePath === ':memory:')) {
    throw new Error('NETWORK_SUPERVISOR_DURABLE_POLICY_REQUIRED');
  }
  if (options.networkRepair && !options.credentialDirectory?.trim()) {
    throw new Error('NETWORK_SUPERVISOR_CREDENTIAL_DIRECTORY_REQUIRED');
  }
  const networkRepair = options.networkRepair && Object.freeze({ ...options.networkRepair,
    policy: parseNetworkPolicy(options.networkRepair.policy) });
  if (networkRepair && networkRepair.localDeviceId !== networkRepair.policy.device_id) {
    throw new Error('NETWORK_DEVICE_NOT_REGISTERED');
  }
  if (options.consultationWorker && (!options.databasePath?.trim() || options.databasePath === ':memory:')) {
    throw new Error('CONSULTATION_WORKER_DATABASE_REQUIRED');
  }
  if (options.consultationWorker && !options.credentialDirectory?.trim()) {
    throw new Error('CONSULTATION_WORKER_CREDENTIAL_DIRECTORY_REQUIRED');
  }
  if (options.prDeliveryWorker && (!options.databasePath?.trim() || options.databasePath === ':memory:')) {
    throw new Error('PUBLISHER_DATABASE_REQUIRED');
  }
  if (options.productViewHub && (!options.databasePath?.trim() || options.databasePath === ':memory:')) {
    throw new Error('PRODUCT_VIEW_DATABASE_REQUIRED');
  }
  if (options.workStopSupervisor && (!options.databasePath || options.databasePath === ':memory:')) {
    throw new Error('WORK_STOP_DATABASE_REQUIRED');
  }
  if (options.httpSourceWorker && (!options.databasePath || options.databasePath === ':memory:' || !options.httpSources)) {
    throw new Error('HTTP_SOURCE_WORKER_DURABLE_POLICY_REQUIRED');
  }
  if (options.notificationMaintenance && (!options.databasePath?.trim() || options.databasePath === ':memory:')) {
    throw new Error('NOTIFICATION_MAINTENANCE_DATABASE_REQUIRED');
  }
  if (options.feishuTestOutbound && (!options.databasePath?.trim() || options.databasePath === ':memory:')) {
    throw new Error('FEISHU_TEST_DATABASE_REQUIRED');
  }
  if (options.feishuTestOutbound && !options.feishuCredentials) {
    throw new Error('FEISHU_TEST_CREDENTIAL_PROVIDER_REQUIRED');
  }
  const now = options.now ?? (() => new Date());
  const state: {
    db?: SqliteDatabase;
    recoveryAttachmentFailed?: boolean;
    credentials?: CredentialStore;
    databasePath?: string;
    vault?: ReturnType<typeof createVaultApi>;
    hub?: LocalHubPort;
    hubDatabase?: SqliteDatabase;
    productViews?: ReturnType<typeof createProductViewService>;
    sourceRegistry?: ReturnType<typeof createSourceRegistry>;
    settings?: ReturnType<typeof createSettingsChanges>;
  } = {};
  function context(): AuthContext {
    if (state.recoveryAttachmentFailed) throw new Error('RECOVERY_RUNTIME_ATTACHMENT_FAILED');
    if (status === 'closed' || status === 'close_failed') throw new Error('SERVICE_CLOSED');
    if (!state.db) {
      const databasePath = options.databasePath ?? join(tmpdir(), `patrick-${randomUUID()}.sqlite`);
      state.databasePath = databasePath;
      const database = (options.openMain ?? openDatabase)(databasePath);
      state.db = database;
      try {
        if (options.recoveryRuntime) attachRecoveryRuntime(database, options.recoveryRuntime);
      } catch (error) {
        // Retain ownership for ordered close, but never admit this failed connection again.
        state.recoveryAttachmentFailed = true;
        recordError('RECOVERY_RUNTIME_ATTACHMENT_FAILED');
        stop();
        throw error;
      }
    }
    state.credentials ??= createCredentialStore(options.credentialDirectory ?? join(tmpdir(), `patrick-credentials-${randomUUID()}`), now);
    return { db: state.db, credentials: state.credentials, now, browserAuthority, ownerBootstrapCurrent: options.ownerBootstrapCurrent };
  }
  function durableHub(): LocalHubPort {
    if (state.hub) return state.hub;
    context();
    if (!state.databasePath) throw new Error('DATABASE_PATH_MISSING');
    const path = options.localAnswersPath ?? `${state.databasePath}.hub`;
    state.hub = (options.openLocalAnswers ?? createLocalHubPort)(path, (database) => { state.hubDatabase = database; });
    return state.hub;
  }
  function vaultApi(): ReturnType<typeof createVaultApi> {
    const current = context();
    if (!state.vault || !state.databasePath) {
      state.vault = createVaultApi(current.db, {
        blobs: createBlobStore(join(dirname(state.databasePath ?? options.databasePath ?? ''), 'blobs')),
        now,
      });
    }
    return state.vault;
  }
  function closeResources() {
    // All joined finalizers still had both handles available. Close the Hub first.
    try {
      state.hub?.close();
      // The owner captures this handle before Hub initialization, even if no port is returned.
      if (state.hubDatabase?.open) state.hubDatabase.close();
    }
    catch {
      recordError('HUB_CLOSE_FAILED');
      status = 'close_failed';
      return;
    }
    try { if (state.db?.open) state.db.close(); }
    catch {
      recordError('DATABASE_CLOSE_FAILED');
      status = 'close_failed';
      return;
    }
    status = 'closed';
  }
  function read(): ServiceDrainResult {
    return {
      status,
      active: lifetime.active + workers.reduce((count, worker) => count + worker.active, 0),
      errors: [...errors, ...lifetime.errors, ...workers.flatMap((worker) => worker.errors)].slice(0, 32),
    };
  }
  function stop() {
    if (status !== 'running') return;
    status = 'draining';
    callerSignal?.removeEventListener('abort', stop);
    lifetime.stop();
    for (const worker of workers) worker.stop();
    joined = Promise.all([lifetime.join(), ...workers.map((worker) => worker.join())]).then(() => {});
    completion = (barrier ? Promise.all([joined, barrier]) : joined).then(closeResources);
  }
  function reserveCloseHold(): ServiceCloseHold | undefined {
    if (!holdEligible || status !== 'running') return undefined;
    let release!: () => void;
    barrier = new Promise<void>((resolve) => { release = resolve; });
    stop();
    return Object.freeze({
      joined: joined!,
      async finalize() { release(); await completion; return read(); },
    });
  }
  async function drain({ timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<ServiceDrainResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) throw new Error('SERVICE_DRAIN_TIMEOUT_INVALID');
    stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([completion, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    } finally { clearTimeout(timer); }
    return read();
  }
  function triggerConsultationTick(): Promise<void> {
    if (!manualConsultation) return Promise.reject(new Error('CONSULTATION_TRIGGER_NOT_CONFIGURED'));
    if (status !== 'running' || options.consultationWorker?.signal?.aborted) {
      return Promise.reject(new Error('CONSULTATION_TRIGGER_STOPPED'));
    }
    return manualConsultation.tick();
  }
  try {
    options.assertStartupAllowed?.();
    if (lifetime.signal.aborted) throw new Error('SERVICE_START_CANCELLED');
    if (options.databasePath || options.bindRecoveryOperations) context();
    if (options.bindRecoveryOperations) {
      if (!options.recoveryRuntime) throw new Error('RECOVERY_RUNTIME_REQUIRED');
      const hub = durableHub();
      if (!state.hubDatabase) throw new Error('HUB_DATABASE_MISSING');
      recoveryOperations = options.bindRecoveryOperations({ database: context().db, hub, hubDatabase: state.hubDatabase });
    }
    if (options.consultationWorker) {
      const { db, credentials } = context();
      const config = options.consultationWorker;
      starters.push(() => {
        if (config.mode === 'manual') {
          manualConsultation = createManualConsultationWorker(db, now, config, credentials);
          workers.push(manualConsultation);
        } else {
          workers.push(startConsultationWorker(db, now, config, credentials));
        }
      });
    }

    if (options.prDeliveryWorker && options.databasePath) {
      const { db } = context();
      const worker = createPrDeliveryService(db, now, {
        ...options.prDeliveryWorker, blobs: createBlobStore(join(dirname(options.databasePath), 'blobs')),
      });
      workers.push(worker);
      starters.push(() => { worker.start(); });
    }

    if (options.productViewHub) {
      const { db } = context();
      state.productViews = createProductViewService(db, now);
      const config = options.productViewHub;
      const views = state.productViews;
      starters.unshift(() => {
        workers.push(startProductViewHubObserver(db, now, config, views.recordHubObservation));
        workers.push(views.start({ signal: config.signal, onError: config.onError }));
      });
    }

    function sourceResources() {
      const current = context();
      state.sourceRegistry ??= createSourceRegistry(current.db, {
        trackAsync: lifetime.track,
        blobs: createBlobStore(join(dirname(state.databasePath ?? ''), 'blobs')),
        now: () => current.now().toISOString(),
        http: options.httpSources,
        githubApi: options.githubApi,
        credentials: options.sourceCredentialStore
          ? { resolve: (reference) => options.sourceCredentialStore!.resolve(reference) }
          : undefined,
      });
      return { ...current, registry: state.sourceRegistry, sourceCredentials: options.sourceCredentialStore };
    }

    if (options.httpSourceWorker) {
      const { db, registry } = sourceResources();
      const worker = createHttpCollectionWorker(db, registry, now, options.httpSourceWorker);
      workers.push(worker);
      starters.unshift(() => { worker.start(); });
    }
    if (options.notificationMaintenance) {
      const worker = createNotificationMaintenance(context().db, now, options.notificationMaintenance);
      workers.push(worker);
      starters.unshift(() => { worker.start(); });
    }
    if (options.sourceWorkDispatch) {
      const worker = createSourceWorkDispatch(context().db, now, options.sourceWorkDispatch);
      workers.push(worker);
      starters.unshift(() => { worker.start(); });
    }
    const app = new Hono();
    app.use('/api/v1/*', async (_c, next) => {
      await runWithAuth(context(), async () => {
        await next();
      });
    });
    app.get('/api/openapi.json', (c) => c.json(generateOpenApi()));
    app.get('/healthz', (c) => c.json({ ok: true }));
    mountAuthRoutes(app);
    mountPreferenceRoutes(app, context);
    mountSettingsRoutes(app, () => {
      const current = context();
      state.settings ??= createSettingsChanges({ ...current,
        handlers: { ...builtinSettingsHandlers({ ...current, hub: durableHub, feishuCredentials: options.feishuCredentials }),
          ...networkSettingsHandlers({ ...current, networkRepair }),
          ...recoverySettingsHandlers({ ...current, recoveryOperations }),
          ...sourceSettingsHandlers(sourceResources()), ...options.settingsHandlers },
      });
      return { ...current, engine: state.settings,
        recoveryTargets: (principal, domain, operation) => registeredRecoveryTargets(recoveryOperations, principal, domain, operation),
        networkTargets: (principal, domain) => registeredNetworkTargets(current.db, networkRepair, principal, domain),
        executorProbes: options.executorProbes };
    });
    mountSourceRoutes(app, sourceResources);
    mountDiagnosticsRoutes(app, context);
    mountNotificationRoutes(app, context);
    mountControlRoutes(app);
    mountAnswerRoutes(app, () => {
      const current = context();
      const hub = durableHub();
      return {
        db: current.db,
        now,
        gate: (domain: string) => createAnswerGate(current.db, { domain, now, hub, encode: encodeHubAnswer }),
      };
    });
    mountFeishuRoutes(app, () => {
      const current = context();
      return { db: current.db, now, hub: durableHub(), feishuCredentials: options.feishuCredentials,
        feishuTestOutbound: options.feishuTestOutbound, feishuOutboundLifetime: lifetime };
    });
    const resources = () => ({ db: context().db, api: vaultApi(), now });
    mountVaultRoutes(app, resources);
    mountKnowledgeRoutes(app, resources);
    mountEditRoutes(app, resources);
    mountStandardRoutes(app, resources);
    mountDelegationRoutes(app, resources);
    if (options.workStopSupervisor) {
      const db = context().db;
      const config = options.workStopSupervisor;
      starters.unshift(() => { workers.push(startWorkStopObserver(db, config, now)); });
    }
    mountWorkControlRoutes(app, resources, () => !!options.workStopSupervisor && !options.workStopSupervisor.signal?.aborted);
    mountConversationRoutes(app, () => ({ db: context().db, now }));
    mountConsultationRoutes(app, () => ({ db: context().db, now }));
    const viewResources = () => {
      const current = context();
      state.productViews ??= createProductViewService(current.db, now);
      return { ...current, ...state.productViews };
    };
    mountWorkProjectionRoutes(app, viewResources);
    mountStatsRoutes(app, viewResources);
    mountProjectionEventRoutes(app, viewResources);
    const fetch = app.fetch.bind(app);
    app.fetch = (request, env, executionCtx) => {
      if (status !== 'running' || lifetime.signal.aborted) return Promise.resolve(new Response('Service stopping', { status: 503 }));
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      const admitted = new Request(request, { signal });
      return lifetime.run(async () => {
        const response = await fetch(admitted, env, executionCtx);
        if (!response.body) return response;
        // HTTP response bodies may own asynchronous producers after the handler returns.
        const reader = response.body.getReader();
        let release!: () => void;
        const bodyDone = new Promise<void>((resolve) => { release = resolve; });
        lifetime.track(bodyDone);
        let cancellation: Promise<void> | undefined;
        function finish() { signal.removeEventListener('abort', abort); release(); }
        function cancel() {
          cancellation ??= reader.cancel().then(finish, () => {
            recordError('RESPONSE_CANCEL_FAILED');
            finish();
          });
          return cancellation;
        }
        const abort = () => { void cancel(); };
        signal.addEventListener('abort', abort, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const part = await reader.read();
              if (part.done) {
                if (cancellation) await cancellation;
                controller.close();
                finish();
              } else controller.enqueue(part.value);
            } catch (error) { controller.error(error); finish(); }
          },
          cancel,
        }, { highWaterMark: 0 });
        if (signal.aborted) await cancel();
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      });
    };
    // Every constructor and route is ready before any immediate worker can enter external I/O.
    for (const start of starters) {
      lifetime.signal.throwIfAborted();
      start();
    }
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    if (status === 'running' && options.registerCloseHold) {
      options.registerCloseHold(reserveCloseHold);
      holdEligible = true;
    }
    return { app, stop, drain, read, triggerConsultationTick };
  } catch (error) {
    stop();
    throw new ServiceStartupError(error, { stop, drain, read });
  }
}

export function createApp(options: CreateAppOptions = {}): Hono {
  try { return createServiceRuntime(options).app; }
  catch (error) {
    if (error instanceof ServiceStartupError) throw error.cause;
    throw error;
  }
}
