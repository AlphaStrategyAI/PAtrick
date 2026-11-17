import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { generateOpenApi } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import { createCredentialStore } from '@patrick/host';
import { startConsultationWorker, type ConsultationWorkerOptions } from '@patrick/integrations/autoloop/consultation-runtime';
import { createLocalHubPort, encodeHubAnswer, type LocalHubPort } from '@patrick/integrations/autoloop/answers';
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
import { createProductViewService, startProductViewHubObserver, type ProductViewHub } from './product-views.js';
import { mountWorkProjectionRoutes } from './routes/work.js';
import { mountProjectionEventRoutes } from './routes/events.js';

export { createAuthenticatedConsultationMcp } from './consultation-mcp.js';

export type CreateAppOptions = {
  databasePath?: string;
  credentialDirectory?: string;
  now?: () => Date;
  consultationWorker?: ConsultationWorkerOptions;
  productViewHub?: ProductViewHub;
  prDeliveryWorker?: Omit<PrDeliveryOptions, 'blobs'>;
};

export function createApp(options: CreateAppOptions = {}): Hono {
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
  const now = options.now ?? (() => new Date());
  const state: {
    db?: SqliteDatabase;
    credentials?: CredentialStore;
    databasePath?: string;
    vault?: ReturnType<typeof createVaultApi>;
    hub?: LocalHubPort;
    productViews?: ReturnType<typeof createProductViewService>;
  } = {};
  function context(): AuthContext {
    if (!state.db || !state.credentials || !state.databasePath) {
      const databasePath = options.databasePath ?? join(tmpdir(), `patrick-${randomUUID()}.sqlite`);
      const credentialDirectory = options.credentialDirectory ?? join(tmpdir(), `patrick-credentials-${randomUUID()}`);
      state.databasePath = databasePath;
      state.db = openDatabase(databasePath);
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

  const app = new Hono();
  app.use('/api/v1/*', async (_c, next) => {
    await runWithAuth(context(), async () => {
      await next();
    });
  });
  app.get('/api/openapi.json', (c) => c.json(generateOpenApi()));
  app.get('/healthz', (c) => c.json({ ok: true }));
  mountAuthRoutes(app);
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
    return { db: current.db, now, credentials: current.credentials, hub: durableHub() };
  });
  const resources = () => ({ db: context().db, api: vaultApi(), now });
  mountVaultRoutes(app, resources);
  mountKnowledgeRoutes(app, resources);
  mountEditRoutes(app, resources);
  mountStandardRoutes(app, resources);
  mountDelegationRoutes(app, resources);
  mountWorkControlRoutes(app, resources);
  mountConversationRoutes(app, () => ({ db: context().db, now }));
  mountConsultationRoutes(app, () => ({ db: context().db, now }));
  const viewResources = () => {
    const current = context();
    state.productViews ??= createProductViewService(current.db, now);
    return { ...current, ...state.productViews };
  };
  mountWorkProjectionRoutes(app, viewResources);
  mountProjectionEventRoutes(app, viewResources);
  return app;
}

export const app = createApp();
