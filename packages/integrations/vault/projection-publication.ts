import { createHash } from 'node:crypto';
import { canonicalPayload, type Json } from '@patrick/contracts';
import type { SqliteDatabase } from '@patrick/storage';
import type { VaultRecord } from './connection.js';
import type { readIndexFile } from './index-proof.js';
import type { ProjectionRequest } from './projector.js';

export type IndexSnapshot = Awaited<ReturnType<typeof readIndexFile>>;
type IndexBinding = Omit<NonNullable<IndexSnapshot>, 'text'>;
const format = 'patrick.vault-index-publication.v1';

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bindIndex(index: IndexSnapshot): IndexBinding | null {
  if (!index) return null;
  const { dev, ino, mtimeMs, sha256 } = index;
  return { dev, ino, mtimeMs, sha256 };
}

export function sameIndex(left: IndexSnapshot, right: IndexBinding | null): boolean {
  return left && right ? left.dev === right.dev && left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs && left.sha256 === right.sha256 : left === null && right === null;
}

export function publicationScope(vault: VaultRecord, input: ProjectionRequest, precedingPointer: number | null,
  manifest: Json, indexBody: string) {
  return {
    vaultId: vault.vault_id,
    sourceId: vault.source_id,
    account: vault.account_id,
    domain: vault.data_domain,
    root: vault.root_path,
    physicalRoot: vault.physical_root,
    rootIdentity: vault.root_identity,
    captureHost: vault.capture_host,
    configRevision: vault.config_revision,
    connectionEpoch: vault.connection_epoch,
    scopeHash: vault.scope_hash,
    intentId: projectionIntentId(vault, input),
    editId: input.editId ?? null,
    view: input.viewKind,
    revision: input.revision,
    precedingPointer,
    manifest,
    indexSha256: sha256(indexBody),
    ...(input.adoptionRender ? { adoptionRender: input.adoptionRender } : {}),
    ...(input.reconciliationRender ? { reconciliationRender: input.reconciliationRender } : {}),
  };
}

export function projectionIntentId(vault: Pick<VaultRecord, 'data_domain' | 'vault_id'>, input: ProjectionRequest): string {
  if (input.reconciliationRender) return `vault-sync-${sha256(vault.vault_id).slice(0, 24)}-${input.revision}`;
  return input.adoptionRender?.intentId ?? `projection:${vault.data_domain}:${input.viewKind}:${input.revision}`;
}

type Scope = ReturnType<typeof publicationScope>;
type Publication = { format: typeof format; scope: Scope; precedingIndex: IndexBinding | null; publishedIndex: IndexBinding };

export function writePublicationProof(scope: Scope, precedingIndex: IndexSnapshot, stagedIndex: NonNullable<IndexSnapshot>): string {
  const proof: Publication = {
    format, scope, precedingIndex: bindIndex(precedingIndex),
    publishedIndex: { dev: stagedIndex.dev, ino: stagedIndex.ino, mtimeMs: stagedIndex.mtimeMs, sha256: stagedIndex.sha256 },
  };
  return canonicalPayload(proof);
}

export function loadPublicationProof(db: SqliteDatabase, scope: Scope): Publication | 'conflict' | null {
  const row = db.prepare(`SELECT vault_id, intent_id, manifest_json, manifest_hash FROM projection_batches
    WHERE data_domain = ? AND view_kind = ? AND projection_revision = ? AND cleanup_state = 'pending' AND applied = 0`)
    .get(scope.domain, scope.view, scope.revision) as {
      vault_id: string; intent_id: string; manifest_json: string; manifest_hash: string;
    } | undefined;
  if (!row) return null;
  if (row.vault_id !== scope.vaultId || row.manifest_hash !== sha256(row.manifest_json)) return 'conflict';
  const proof = JSON.parse(row.manifest_json) as Publication | null;
  // T07 may have reserved this projection row; it has no filesystem publication proof yet.
  if (proof?.format !== format) return null;
  if (row.intent_id !== scope.intentId || !proof.scope || canonicalPayload(proof.scope) !== canonicalPayload(scope) ||
      proof.publishedIndex?.sha256 !== scope.indexSha256) return 'conflict';
  return proof;
}
