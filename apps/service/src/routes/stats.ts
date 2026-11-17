import type { Hono } from 'hono';
import type { createStatsProjection } from '../../../../packages/storage/src/views/stats.js';
import { ApiError } from '../errors.js';
import { handle } from './http.js';
import { oneValue, projectionScope, type ProjectionResources } from './work.js';

export type StatsReady = () => ProjectionResources & { stats: ReturnType<typeof createStatsProjection> };

export function mountStatsRoutes(app: Hono, ready: StatsReady): void {
  app.get('/api/v1/stats', (c) => handle(c, async () => {
    const resources = ready();
    const query = new URL(c.req.url).searchParams;
    const scope = await projectionScope(resources, c.req.raw, ['stats.read', 'work.read'], oneValue(query, 'domain'));
    const period = oneValue(query, 'period') ?? '7d';
    const timezone = oneValue(query, 'timezone');
    if (period !== '7d' && period !== '30d' && period !== 'all') throw new ApiError(422, 'UNPROCESSABLE', { reason: 'stats_period' });
    if (!timezone) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'stats_timezone' });
    try {
      return c.json(resources.stats.readStats(scope, period, timezone, resources.now()));
    } catch (error) {
      if (error instanceof Error && error.message === 'STATS_TIMEZONE_INVALID') {
        throw new ApiError(422, 'UNPROCESSABLE', { reason: 'stats_timezone' });
      }
      throw error;
    }
  }));
}
