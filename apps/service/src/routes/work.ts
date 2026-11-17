import { createHash } from 'node:crypto';
import { PAGE_MAX } from '@patrick/contracts';
import type { Hono } from 'hono';
import type { ProjectionScope } from '../../../../packages/storage/src/views/cursors.js';
import type { createWorkProjection, WorkFilters } from '../../../../packages/storage/src/views/work.js';
import { readPresentedToken, requireSession, runWithAuth, type AuthContext } from '../auth.js';
import { ApiError } from '../errors.js';
import { handle, routeId } from './http.js';

export type ProjectionResources = AuthContext & { projection: ReturnType<typeof createWorkProjection> };
export type ProjectionReady = () => ProjectionResources;

export function mountWorkProjectionRoutes(app: Hono, ready: ProjectionReady): void {
  app.get('/api/v1/system/health', (c) => handle(c, async () => {
    const resources = ready();
    const scope = await projectionScope(resources, c.req.raw, [], oneValue(new URL(c.req.url).searchParams, 'domain'));
    return c.json(resources.projection.readHealth(scope));
  }));
  app.get('/api/v1/work', (c) => handle(c, async () => {
    const resources = ready();
    const query = new URL(c.req.url).searchParams;
    const scope = await projectionScope(resources, c.req.raw, ['work.read'], oneValue(query, 'domain'));
    const state = oneValue(query, 'state') ?? 'open';
    if (!isWorkFilter(state)) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'state' });
    const cursor = oneValue(query, 'cursor');
    const pageSize = oneValue(query, 'limit');
    if (pageSize !== undefined && (!/^[1-9][0-9]{0,2}$/.test(pageSize) || Number(pageSize) > PAGE_MAX)) {
      throw new ApiError(422, 'UNPROCESSABLE', { reason: 'limit' });
    }
    const limit = pageSize === undefined ? undefined : Number(pageSize);
    try { return c.json(resources.projection.readList(scope, { state, cursor, limit })); }
    catch (error) {
      if (error instanceof Error && error.message === 'PROJECTION_RESET_REQUIRED') {
        throw new ApiError(409, 'CONFLICT', { reason: 'projection_reset' });
      }
      throw error;
    }
  }));
  app.get('/api/v1/work/:id', (c) => handle(c, async () => {
    const resources = ready();
    const scope = await projectionScope(resources, c.req.raw, ['work.read'], oneValue(new URL(c.req.url).searchParams, 'domain'));
    const snapshot = resources.projection.readDetail(scope, routeId(c.req.param('id')));
    if (!snapshot) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
    return c.json(snapshot);
  }));
  app.get('/api/v1/work/:id/timeline', (c) => handle(c, async () => {
    const resources = ready();
    const scope = await projectionScope(resources, c.req.raw, ['work.read'], oneValue(new URL(c.req.url).searchParams, 'domain'));
    const snapshot = resources.projection.readTimeline(scope, routeId(c.req.param('id')));
    if (!snapshot) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
    return c.json(snapshot);
  }));
}

export async function projectionScope(
  resources: ProjectionResources, request: Request, permissions: readonly string[], domain?: string,
): Promise<ProjectionScope> {
  const principal = await runWithAuth(resources, () => requireSession(request));
  const token = readPresentedToken(request);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', { reason: 'session' });
  const active = resources.db.prepare(`SELECT s.data_domain,s.permission FROM caller_scopes s
    JOIN accounts a ON a.account_id=s.account_id WHERE s.account_id=? AND s.caller_id=? AND a.auth_epoch=?
      AND s.revoked_at IS NULL ORDER BY s.data_domain,s.permission`)
    .all(principal.account_id, principal.caller_id, principal.auth_epoch) as { data_domain: string; permission: string }[];
  const domains = new Map<string, Set<string>>();
  for (const row of active) {
    const actions = domains.get(row.data_domain) ?? new Set<string>();
    actions.add(row.permission);
    domains.set(row.data_domain, actions);
  }
  const allowed = [...domains.keys()].filter((key) => {
    const actions = domains.get(key)!;
    return actions.has('owner') || permissions.every((permission) => actions.has(permission));
  });
  const selected = domain ?? allowed[0];
  if (!selected || !allowed.includes(selected)) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return { accountId: principal.account_id, callerId: principal.caller_id, dataDomain: selected,
    permissionEpoch: principal.auth_epoch, permissionDigest: sha256(JSON.stringify(active)), sessionDigest: sha256(token) };
}

export function oneValue(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  if (values.length > 1 || values[0] === '') throw new ApiError(422, 'UNPROCESSABLE', { reason: name });
  return values[0];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isWorkFilter(value: string): value is WorkFilters['state'] {
  return value === 'open' || value === 'awaiting_answer' || value === 'blocked' || value === 'delivered' || value === 'all';
}
