import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { ApiError, errorBody } from '../errors.js';
import { assertBrowserOrigin, requireSession, type Principal } from '../auth.js';

export async function handle(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    const rendered = errorBody(asApiError(error));
    return c.json(rendered.body, rendered.status as 401);
  }
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'json' });
  }
}

export function assertPayloadHash(payload: Json, claimed: string): void {
  const actual = createHash('sha256').update(canonicalPayload(payload)).digest('hex');
  const left = Buffer.from(actual);
  const right = Buffer.from(claimed);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ApiError(422, 'UNPROCESSABLE', { reason: 'payload_hash' });
  }
}

export async function requirePermission(request: Request, permission: string): Promise<Principal> {
  const principal = await requireSession(request);
  if (!principal.operations.includes('owner') && !principal.operations.includes(permission)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'permission' });
  }
  return principal;
}

export function assertWriteOrigin(request: Request): void {
  assertBrowserOrigin(request);
}

export function routeId(value: string | undefined): string {
  if (!value) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'id' });
  return value;
}

function asApiError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    if (error.message === 'RECOVERY_WRITE_BLOCKED') return new ApiError(409, 'CONFLICT', { reason: 'recovery_write_blocked' });
    if (error.message === 'CONFLICT' || error.message === 'VAULT_ROOT_TAKEN' || error.message === 'IDEMPOTENCY_CONFLICT') {
      return new ApiError(409, 'CONFLICT', { reason: error.message === 'IDEMPOTENCY_CONFLICT' ? 'idempotency' : 'revision' });
    }
    if (error.message === 'FORBIDDEN' || error.message === 'NOT_FOUND') return new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
    if (error.message === 'UNPROCESSABLE') return new ApiError(422, 'UNPROCESSABLE', { reason: 'edit' });
  }
  return error;
}
