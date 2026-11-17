import { createHash } from 'node:crypto';
import { canonicalPayload } from '@patrick/contracts';
import type { CredentialStore } from '@patrick/host';
import type { SqliteDatabase } from '@patrick/storage';
import { canConfirm, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';

type Binding = { operation: string; target: string; domain: string; draftHash: string; validationId: string; objectRevision: number };

export function settingsControlHash(binding: Binding): string {
  return createHash('sha256').update(canonicalPayload({
    operation: binding.operation, target: binding.target, domain: binding.domain, draft_hash: binding.draftHash,
    validation_id: binding.validationId, object_revision: binding.objectRevision,
  })).digest('hex');
}

export function assertSettingsControl(
  db: SqliteDatabase, credentials: CredentialStore, principal: Principal, now: Date, receiptId: string, binding: Binding,
): void {
  const row = db.prepare(`SELECT r.credential_ref,r.authenticated_at FROM control_receipts r
    JOIN control_proposals p ON p.proposal_id=r.proposal_id AND p.account_id=r.account_id
    JOIN accounts a ON a.account_id=r.account_id
    WHERE r.receipt_id=@receipt AND r.account_id=@account AND r.caller_id=@caller
      AND r.auth_epoch=@epoch AND a.auth_epoch=@epoch AND r.result='confirmed'
      AND p.target=@target AND p.scope=@scope AND p.action=@action
      AND r.proposal_hash=@hash AND p.proposal_hash=@hash
      AND p.base_revision=r.base_revision AND a.policy_revision=r.base_revision
      AND p.confirmed_at IS NOT NULL AND p.expires_at>@now`)
    .get({ receipt: receiptId, account: principal.account_id, caller: principal.caller_id, epoch: principal.auth_epoch,
      target: binding.target, scope: binding.domain, action: binding.operation, hash: settingsControlHash(binding),
      now: now.toISOString() }) as { credential_ref: string; authenticated_at: string } | undefined;
  const authenticated = row ? Date.parse(row.authenticated_at) : NaN;
  const age = now.getTime() - authenticated;
  if (!canConfirm(principal) || !row || !Number.isFinite(age) || age < 0 || age > 300_000 || !credentials.resolve(row.credential_ref)) {
    throw new ApiError(403, 'FORBIDDEN', { reason: 'control_receipt' });
  }
}
