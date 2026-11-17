import { randomUUID } from 'node:crypto';
import { attachRecoveryRuntime, type RecoveryRuntimeConfiguration } from './recovery-runtime.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { generateOpenApi } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import { createCredentialStore } from '@patrick/host';
import { startConsultationWorker, type ConsultationWorkerOptions } from '@patrick/integrations/autoloop/consultation-runtime';
import { createLocalHubPort, encodeHubAnswer, type LocalHubPort } from '@patrick/integrations/autoloop/answers';
import type { FeishuTestOutbound } from '../../../packages/integrations/feishu/outbound.js';
import { createSourceRegistry, type RegistryOptions } from '@patrick/integrations/sources/registry';
import { createVaultApi } from '@patrick/integrations/vault/drafts';
import { createBlobStore, openDatabase, type SqliteDatabase } from '@patrick/storage';
import { createAnswerGate } from '../../../packages/domain/src/answer-gate.js';
import { mountAuthRoutes, runWithAuth, type AuthContext } from './auth.js';
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
import { parseNetworkPolicy } from '../../../packages/host/src/network/vpn.js';
import { createHttpCollectionWorker, type HttpCollectionWorkerOptions } from './source-collection.js';
import { sourceSettingsHandlers } from './settings/sources.js';
import { createProductViewService, startProductViewHubObserver, type ProductViewHub } from './product-views.js';
import { mountStatsRoutes } from './routes/stats.js';
import { mountWorkProjectionRoutes } from './routes/work.js';
import { mountProjectionEventRoutes } from './routes/events.js';

export { createAuthenticatedConsultationMcp } from './consultation-mcp.js';

export type CreateAppOptions = {
  databasePath?: string;
  recoveryRuntime?: RecoveryRuntimeConfiguration;
  credentialDirectory?: string;
  now?: () => Date;
  consultationWorker?: ConsultationWorkerOptions;
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
};

export function createApp(options: CreateAppOptions = {}): Hono {
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
    credentials?: CredentialStore;
    databasePath?: string;
    vault?: ReturnType<typeof createVaultApi>;
    hub?: LocalHubPort;
    productViews?: ReturnType<typeof createProductViewService>;
    sourceRegistry?: ReturnType<typeof createSourceRegistry>;
    settings?: ReturnType<typeof createSettingsChanges>;
  } = {};
  function context(): AuthContext {
    if (!state.db || !state.credentials || !state.databasePath) {
      const databasePath = options.databasePath ?? join(tmpdir(), `patrick-${randomUUID()}.sqlite`);
      const credentialDirectory = options.credentialDirectory ?? join(tmpdir(), `patrick-credentials-${randomUUID()}`);
      state.databasePath = databasePath;
      const database = openDatabase(databasePath);
      try {
        if (options.recoveryRuntime) attachRecoveryRuntime(database, options.recoveryRuntime);
      } catch (error) {
        database.close();
        throw error;
      }
      state.db = database;
      state.credentials = createCredentialStore(credentialDirectory, now);
    }
    return { db: state.db, credentials: state.credentials, now };
  }
  function durableHub(): LocalHubPort {
    if (state.hub) return state.hub;
    context();
    if (!state.databasePath) throw new Error('DATABASE_PATH_MISSING');
    state.hub = createLocalHubPort(`${state.databasePath}.hub`);
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
  if (options.databasePath) context();
  if (options.consultationWorker) {
    const { db, credentials } = context();
    startConsultationWorker(db, now, options.consultationWorker, credentials);
  }

  if (options.prDeliveryWorker && options.databasePath) {
    const { db } = context();
    createPrDeliveryService(db, now, {
      ...options.prDeliveryWorker, blobs: createBlobStore(join(dirname(options.databasePath), 'blobs')),
    }).start();
  }

  if (options.productViewHub) {
    const { db } = context();
    state.productViews = createProductViewService(db, now);
    startProductViewHubObserver(db, now, options.productViewHub, state.productViews.recordHubObservation);
    state.productViews.start({ signal: options.productViewHub.signal, onError: options.productViewHub.onError });
  }

  function sourceResources() {
    const current = context();
    state.sourceRegistry ??= createSourceRegistry(current.db, {
      blobs: createBlobStore(join(dirname(state.databasePath ?? ''), 'blobs')),
      now: () => current.now().toISOString(),
      http: options.httpSources,
    });
    return { ...current, registry: state.sourceRegistry };
  }

  if (options.httpSourceWorker) {
    const { db, registry } = sourceResources();
    createHttpCollectionWorker(db, registry, now, options.httpSourceWorker).start();
  }
  if (options.notificationMaintenance) createNotificationMaintenance(context().db, now, options.notificationMaintenance).start();
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
      handlers: { ...builtinSettingsHandlers({ ...current, hub: durableHub }),
        ...networkSettingsHandlers({ ...current, networkRepair }),
        ...sourceSettingsHandlers(sourceResources()), ...options.settingsHandlers },
    });
    return { ...current, engine: state.settings,
      networkTargets: (principal, domain) => registeredNetworkTargets(current.db, networkRepair, principal, domain) };
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
      feishuTestOutbound: options.feishuTestOutbound };
  });
  const resources = () => ({ db: context().db, api: vaultApi(), now });
  mountVaultRoutes(app, resources);
  mountKnowledgeRoutes(app, resources);
  mountEditRoutes(app, resources);
  mountStandardRoutes(app, resources);
  mountDelegationRoutes(app, resources);
  if (options.workStopSupervisor) startWorkStopObserver(context().db, options.workStopSupervisor, now);
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
  return app;
}

export const app = createApp();
