import { createHash, randomUUID } from 'node:crypto';
import { canonicalCommand, type CommandBinding } from '@patrick/contracts';
import { withImmediateTransaction, type SqliteDatabase } from './database.js';
import { appendDomainEvent } from './outbox.js';

export type InboxCommand = {
  account_id: string;
  caller_id: string;
  client_request_id: string;
  command_fingerprint: string;
  command_id: string;
};

export type CommandReceipt = { command_id: string; created: boolean };

export type AcceptedCommand = {
  accountId: string;
  callerId: string;
  operation: string;
  resourceId: string;
  dataDomain: string;
  clientRequestId: string;
  expectedRevision: number | null;
  payloadHash: string;
  commandId?: string;
};

const INSERT_COMMAND = `INSERT INTO command_inbox (account_id, caller_id, client_request_id, command_id, command_fingerprint)
VALUES (@account_id, @caller_id, @client_request_id, @command_id, @command_fingerprint)
ON CONFLICT(account_id, caller_id, client_request_id) DO NOTHING`;

export function commandFingerprint(binding: CommandBinding): string {
  return createHash('sha256').update(canonicalCommand(binding)).digest('hex');
}

export function recordCommand(db: SqliteDatabase, command: InboxCommand): CommandReceipt {
  return withImmediateTransaction(db, () => insertCommand(db, command));
}

export function acceptCommand(db: SqliteDatabase, input: AcceptedCommand): CommandReceipt {
  const fingerprint = commandFingerprint({
    operation: input.operation,
    resource_id: input.resourceId,
    data_domain: input.dataDomain,
    expected_revision: input.expectedRevision,
    payload_hash: input.payloadHash,
  });
  const commandId = input.commandId ?? randomUUID();
  return withImmediateTransaction(db, () => {
    const receipt = insertCommand(db, {
      account_id: input.accountId,
      caller_id: input.callerId,
      client_request_id: input.clientRequestId,
      command_fingerprint: fingerprint,
      command_id: commandId,
    });
    if (!receipt.created) return receipt;
    const nextRevision = advanceObject(db, input, receipt.command_id);
    appendDomainEvent(db, {
      eventId: `command.received:${receipt.command_id}`,
      aggregateId: input.resourceId,
      aggregateVersion: nextRevision,
      accountId: input.accountId,
      dataDomain: input.dataDomain,
      payload: { command_id: receipt.command_id, operation: input.operation },
      destination: 'projection',
    });
    return receipt;
  });
}

function insertCommand(db: SqliteDatabase, command: InboxCommand): CommandReceipt {
  const info = db.prepare(INSERT_COMMAND).run(command);
  if (info.changes === 0) {
    const existing = db.prepare(`SELECT command_id, command_fingerprint
      FROM command_inbox
      WHERE account_id = @account_id AND caller_id = @caller_id AND client_request_id = @client_request_id`).get(command) as
      | { command_id: string; command_fingerprint: string }
      | undefined;
    if (!existing || existing.command_fingerprint !== command.command_fingerprint) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    return { command_id: existing.command_id, created: false };
  }
  return { command_id: command.command_id, created: true };
}

function advanceObject(db: SqliteDatabase, input: AcceptedCommand, commandId: string): number {
  if (input.expectedRevision === null) throw new Error('REVISION_CONFLICT');
  const current = db.prepare('SELECT MAX(revision) AS revision FROM object_revisions WHERE object_id = ?').get(input.resourceId) as {
    revision: number | null;
  };
  if (current.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT');
  const nextRevision = input.expectedRevision + 1;
  db.prepare(`INSERT INTO object_revisions (
    object_id, revision, account_id, data_domain, schema_version, blob_ref, command_id, created_at
  ) VALUES (?, ?, ?, ?, '1.0', NULL, ?, ?)`).run(
    input.resourceId,
    nextRevision,
    input.accountId,
    input.dataDomain,
    commandId,
    new Date().toISOString(),
  );
  return nextRevision;
}
