import { randomUUID } from 'node:crypto';
import { commandFingerprint, recordCommand, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import type { BrowserCreationScope } from '@patrick/contracts';
import { assertDomainPermission, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';

export type ConsultationReady = () => { db: SqliteDatabase; now: () => Date };
export type CommandEnvelope<T> = { client_request_id: string; expected_revision: number | null; payload_hash: string; payload: T };

type CommandTarget = { domain: string; resourceId: string | null };

export function runConsultationCommand<T extends CommandTarget>(
  db: SqliteDatabase,
  now: () => Date,
  principal: Principal,
  operation: string,
  permission: string,
  body: CommandEnvelope<unknown>,
  resolve: () => T,
  mutate: (target: T) => string,
): { commandId: string; resourceId: string } {
  return withImmediateTransaction(db, () => {
    const target = resolve();
    const prior = db.prepare(`SELECT i.command_id, i.command_fingerprint, r.resource_id
      FROM command_inbox i LEFT JOIN command_records r ON r.command_id = i.command_id
      WHERE i.account_id = ? AND i.caller_id = ? AND i.client_request_id = ?`).get(
      principal.account_id, principal.caller_id, body.client_request_id,
    ) as { command_id: string; command_fingerprint: string; resource_id: string | null } | undefined;
    function fingerprint(resourceId: string) {
      return commandFingerprint({
        operation,
        resource_id: resourceId,
        data_domain: target.domain,
        expected_revision: body.expected_revision,
        payload_hash: body.payload_hash,
      });
    }
    if (prior) {
      // Create commands have no resource ID until the first execution.
      const resourceId = target.resourceId ?? prior.resource_id;
      if (!prior.resource_id || !resourceId || prior.command_fingerprint !== fingerprint(resourceId)) {
        throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
      }
      return { commandId: prior.command_id, resourceId };
    }
    const resourceId = mutate(target);
    const receipt = recordCommand(db, {
      account_id: principal.account_id,
      caller_id: principal.caller_id,
      client_request_id: body.client_request_id,
      command_fingerprint: fingerprint(resourceId),
      command_id: randomUUID(),
    });
    db.prepare(`INSERT INTO command_records (
      command_id, account_id, caller_id, operation, resource_id, data_domain, permission, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      receipt.command_id, principal.account_id, principal.caller_id,
      operation, resourceId, target.domain, permission, now().toISOString(),
    );
    return { commandId: receipt.command_id, resourceId };
  });
}

export function boundCreationDomain(db: SqliteDatabase, principal: Principal, scope: BrowserCreationScope, permission: string): string {
  if (scope.account_id !== principal.account_id || scope.caller_id !== principal.caller_id || scope.permission_epoch !== principal.auth_epoch) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  assertDomainPermission(db, principal, scope.data_domain, permission);
  return scope.data_domain;
}

export function resolvedWorkDomain(db: SqliteDatabase, principal: Principal, workId: string): string {
  const row = db.prepare(`SELECT account_id, data_domain FROM work_generations
    WHERE work_id = ? ORDER BY generation DESC LIMIT 1`).get(workId) as {
    account_id: string;
    data_domain: string;
  } | undefined;
  if (!row || row.account_id !== principal.account_id) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return row.data_domain;
}

export function ownedConsultationDomain(db: SqliteDatabase, principal: Principal, requestId: string): string {
  const row = db.prepare('SELECT account_id, caller_id, data_domain FROM consultations WHERE request_id = ?').get(requestId) as {
    account_id: string;
    caller_id: string;
    data_domain: string;
  } | undefined;
  if (!row || row.account_id !== principal.account_id || row.caller_id !== principal.caller_id) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  }
  return row.data_domain;
}

export function commandAccepted(commandId: string, receiptUrl: string) {
  return { command_id: commandId, state: 'received' as const, receipt_url: receiptUrl };
}
