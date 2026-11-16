import { Hono } from 'hono';
import { generateOpenApi, routes } from '@patrick/contracts';

export function createApp(): Hono {
  const app = new Hono();
  app.get('/api/openapi.json', (c) => c.json(generateOpenApi()));
  app.get('/api/v1/system/health', (c) =>
    c.json({
      schema_version: '1.0',
      service: 'bootstrapping',
      operations: routes.length,
    }),
  );
  return app;
}

export const app = createApp();
