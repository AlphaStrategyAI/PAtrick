import type { Context } from 'hono';
import type { SqliteDatabase } from '@patrick/storage';
import { assertDomainPermission, domainsWithPermission, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';

/** Match the session's default domain; aggregate "some domain" permission is not authority for this route. */
export function learningDomain(db: SqliteDatabase, principal: Principal, permission: string, domain?: string): string {
  const selected = domain ?? principal.domains[0];
  if (!selected) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  assertDomainPermission(db, principal, selected, permission);
  return selected;
}

export function queryParameter(c: Context, name: string): string | undefined {
  const values = new URL(c.req.url).searchParams.getAll(name);
  if (values.length > 1 || values[0] === '') throw new ApiError(422, 'UNPROCESSABLE', { reason: name });
  return values[0];
}

export function domainPrincipal(db: SqliteDatabase, principal: Principal, domain: string): Principal {
  const operations = principal.operations.filter((permission) =>
    domainsWithPermission(db, principal, permission, false).includes(domain));
  return { ...principal, domains: [domain], operations };
}

export function vaultRelativePath(value: string): boolean {
  return !/[:\\\p{Cc}]/u.test(value) &&
    value.split('/').every((part) => !!part && part !== '.' && part !== '..') &&
    /^(知识笔记|判断案例|标准修订|附件)\//u.test(value);
}
