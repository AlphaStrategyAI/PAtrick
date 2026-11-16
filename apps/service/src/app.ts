import { Hono } from 'hono';
import { generateOpenApi } from '@patrick/contracts';

export function createApp(): Hono {
  const app = new Hono();
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
  return app;
}

export const app = createApp();
