import type { ReactNode } from 'react';
import { ClientError } from '../../api/client.js';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClientError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new ClientError('INVALID_RESPONSE');
  return value;
}
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ClientError('INVALID_RESPONSE');
  return value;
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ClientError('INVALID_RESPONSE');
  return value.map(string);
}
export function parseList<T>(data: unknown, parse: (item: unknown) => T): T[] {
  const items = record(data).items;
  if (!Array.isArray(items)) throw new ClientError('INVALID_RESPONSE');
  return items.map(parse);
}
function parseAccess(data: unknown) {
  const { domains, operations } = record(data);
  return { domains: strings(domains), operations: strings(operations) };
}

export function T16Access({ permission, children, scoped = false }: {
  permission: string; scoped?: boolean; children: (operations: readonly string[]) => ReactNode;
}) {
  const { t } = useLocale();
  const { scope } = useService();
  const session = useScopedSnapshot('getSession', {}, parseAccess);
  if (session.error) return <LocalizedError code={asClientError(session.error).code} onRetry={() => { void session.refetch(); }} />;
  if (!session.data) return <p role="status">{t('session.checking')}</p>;
  // Unscoped feature readers must not display aggregates as if they belonged to this domain.
  if (!scope || !session.data.data.domains.includes(scope.data_domain) || (!scoped && session.data.data.domains.length !== 1)) {
    return <p className="card" role="status">{t('learning.singleDomain')}</p>;
  }
  const operations = session.data.data.operations;
  return may(operations, permission) ? children(operations) : <LocalizedError code="FORBIDDEN" />;
}

export function may(operations: readonly string[], permission: string): boolean {
  return operations.includes(permission) || operations.includes('owner');
}
