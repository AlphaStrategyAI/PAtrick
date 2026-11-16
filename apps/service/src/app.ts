import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { generateOpenApi } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import { createCredentialStore } from '@patrick/host';
import { createLocalHubPort, encodeHubAnswer, type LocalHubPort } from '@patrick/integrations/autoloop/answers';
import { createVaultApi } from '@patrick/integrations/vault/drafts';
import { createBlobStore, openDatabase, type SqliteDatabase } from '@patrick/storage';
import { createAnswerGate } from '../../../packages/domain/src/answer-gate.js';
import { mountAuthRoutes, runWithAuth, type AuthContext } from './auth.js';
import { mountControlRoutes } from './control.js';
import { mountAnswerRoutes } from './routes/answers.js';
import { mountFeishuRoutes } from './routes/feishu.js';
import { mountDelegationRoutes } from './routes/delegations.js';
import { mountEditRoutes } from './routes/edits.js';
import { mountKnowledgeRoutes } from './routes/knowledge.js';
import { mountStandardRoutes } from './routes/standards.js';
import { mountVaultRoutes } from './routes/vaults.js';
import { mountWorkControlRoutes } from './routes/work-controls.js';

export type CreateAppOptions = {
  databasePath?: string;
  credentialDirectory?: string;
  now?: () => Date;
};

export function createApp(options: CreateAppOptions = {}): Hono {
  const now = options.now ?? (() => new Date());
  const state: {
    db?: SqliteDatabase;
    credentials?: CredentialStore;
    databasePath?: string;
    vault?: ReturnType<typeof createVaultApi>;
    hub?: LocalHubPort;
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

  const app = new Hono();
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.path === '/api/v1/system/health') {
      await next();
      return;
    }
    await runWithAuth(context(), async () => {
      await next();
    });
  });
  app.get('/api/openapi.json', (c) => c.json(generateOpenApi()));
  app.get('/api/v1/system/health', (c) => {
    const asOf = new Date().toISOString();
    return c.json({
      schema_version: '1.0',
      scope: { account_id: 'bootstrap', data_domain: 'system', permission_epoch: 0 },
      as_of: asOf,
      watermark: { hub_seq: 0, domain_seq: 0 },
      freshness: 'unknown',
      data: {
        service: 'unknown',
        freshness: 'unknown',
        impact: 'bootstrapping',
        next_step: null,
        as_of: asOf,
      },
    });
  });
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
  return app;
}

export const app = createApp();
