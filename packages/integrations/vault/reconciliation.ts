import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { recoveryWriteAllowed, withImmediateTransaction, type BlobStore, type SqliteDatabase } from '@patrick/storage';
import { renderCommittedView } from './adoption-projection.js';
import { assertVaultWriteAllowed, requireVault, type VaultRecord } from './connection.js';
import { INDEX_PATH, readIndexFile } from './index-proof.js';
import { projectionIntentId, sameIndex, sha256 } from './projection-publication.js';
import { projectVault, projectionManifest, type ProjectionRequest } from './projector.js';
import { readVault } from './reader.js';

export type VaultReconciliationScope = Readonly<{ accountId: string; domains: readonly string[]; captureHost: string }>;
type Render = NonNullable<ProjectionRequest['reconciliationRender']>;
type Batch = { vault_id: string; projection_revision: number; manifest_json: string; manifest_hash: string };
const viewKind = 'standards';
const maxRenderBytes = 4 * 1024 * 1024;

export async function reconcileConnectedVaults(db: SqliteDatabase, blobs: BlobStore, scope: VaultReconciliationScope,
  now: string, signal: AbortSignal, onError: () => void,
): Promise<void> {
  const connected = db.prepare(`SELECT vault_id FROM vaults
    WHERE status='connected' AND account_id=? AND data_domain=? AND capture_host=?`);
  for (const domain of scope.domains) {
    if (signal.aborted) return;
    if (!recoveryWriteAllowed(db, domain)) continue;
    const selected = connected.get(scope.accountId, domain, scope.captureHost) as { vault_id: string } | undefined;
    if (!selected) continue;
    const vault = requireVault(db, selected.vault_id);
    if (vault.status !== 'connected' || vault.account_id !== scope.accountId ||
        vault.data_domain !== domain || vault.capture_host !== scope.captureHost) continue;
    const authorize = () => {
      signal.throwIfAborted();
      assertVaultWriteAllowed(db, vault);
    };
    const authorizePublication = () => {
      authorize();
      const root = lstatSync(vault.root_path);
      if (!root.isDirectory() || `${root.dev}:${root.ino}` !== vault.root_identity ||
          realpathSync(vault.root_path) !== vault.physical_root) throw new Error('VAULT_ROOT_CHANGED');
    };
    try {
      const replayed = await replayPendingProjection(db, blobs, vault, now, authorizePublication);
      const result = await readVault(db, blobs, vault.vault_id, now, { authorize });
      if (!replayed && result.state === 'ready') await reconcileProjection(db, blobs, vault, now, authorizePublication);
    } catch {
      if (signal.aborted) return;
      onError();
    }
  }
}

function projectionHead(db: SqliteDatabase, vault: VaultRecord): Batch | undefined {
  return db.prepare(`SELECT b.vault_id,b.projection_revision,b.manifest_json,b.manifest_hash
    FROM projection_pointers p JOIN projection_batches b USING (data_domain,view_kind,projection_revision,intent_id)
    WHERE p.data_domain=? AND p.view_kind=? AND b.applied=1`).get(vault.data_domain, viewKind) as Batch | undefined;
}

async function replayPendingProjection(db: SqliteDatabase, blobs: BlobStore, vault: VaultRecord, now: string, authorize: () => void) {
  const current = projectionHead(db, vault);
  if (current && current.vault_id !== vault.vault_id) return false;
  const pending = db.prepare(`SELECT vault_id,projection_revision,manifest_json,manifest_hash FROM projection_batches
    WHERE data_domain=? AND view_kind=? AND vault_id=? AND applied=0 AND cleanup_state='pending'
      AND projection_revision>? ORDER BY projection_revision`).all(vault.data_domain, viewKind, vault.vault_id,
    current?.projection_revision ?? 0) as Batch[];
  for (const batch of pending) {
    const data = parseBatch(batch);
    const render = data.scope?.reconciliationRender ?? data.reconciliationRender;
    if (!render || render.configRevision !== vault.config_revision || render.connectionEpoch !== vault.connection_epoch ||
        render.rootIdentity !== vault.root_identity) continue;
    authorize();
    const bytes = await blobs.readBlob(render.blob);
    if (bytes.byteLength > maxRenderBytes || sha256(bytes) !== render.blob) throw new Error('VAULT_RENDER_INVALID');
    const files = JSON.parse(Buffer.from(bytes).toString('utf8')) as ProjectionRequest['files'];
    const result = await projectVault(db, { vaultId: vault.vault_id, viewKind, revision: batch.projection_revision,
      files, reconciliationRender: render }, { now, authorize });
    if (result.state === 'failed') throw new Error('VAULT_PROJECTION_FAILED');
    return true;
  }
  return false;
}

async function reconcileProjection(db: SqliteDatabase, blobs: BlobStore, vault: VaultRecord, now: string, authorize: () => void) {
  authorize();
  const current = projectionHead(db, vault);
  if (current && current.vault_id !== vault.vault_id) return;
  if (!current && !db.prepare('SELECT 1 FROM vault_revisions WHERE vault_id=? LIMIT 1').get(vault.vault_id)) return;
  const files = renderCommittedView(db, vault);
  const manifest = projectionManifest(files);
  if (current) {
    const previous = parseBatch(current);
    if (canonicalPayload((Array.isArray(previous) ? previous : previous.manifest ?? null) as Json) === canonicalPayload(manifest)) return;
  }
  const pendingAdoption = db.prepare(`SELECT vault_id,projection_revision,manifest_json,manifest_hash FROM projection_batches
    WHERE data_domain=? AND view_kind=? AND vault_id=? AND applied=0 AND cleanup_state='pending'
      AND intent_id LIKE 'intent_fact_%' AND projection_revision>?`).all(vault.data_domain, viewKind, vault.vault_id,
    current?.projection_revision ?? 0) as Batch[];
  for (const batch of pendingAdoption) {
    const staged = parseBatch(batch).publishedIndex;
    if (staged && sameIndex(await readIndexFile(join(vault.root_path, INDEX_PATH)), staged)) {
      throw new Error('VAULT_ADOPTION_PROJECTION_PENDING');
    }
  }
  const bytes = Buffer.from(canonicalPayload(files));
  if (bytes.byteLength > maxRenderBytes) throw new Error('VAULT_RENDER_TOO_LARGE');
  authorize();
  const blob = await blobs.putBlob(bytes);
  const reconciliationRender: Render = { blob, configRevision: vault.config_revision,
    connectionEpoch: vault.connection_epoch, rootIdentity: vault.root_identity };
  const input = withImmediateTransaction(db, () => {
    authorize();
    if (projectionHead(db, vault)?.projection_revision !== current?.projection_revision) return;
    const competing = db.prepare(`SELECT vault_id,projection_revision,manifest_json,manifest_hash FROM projection_batches
      WHERE data_domain=? AND view_kind=? AND applied=0 AND cleanup_state='pending' AND intent_id LIKE 'vault-sync-%'
        AND vault_id=? AND projection_revision>?`).all(vault.data_domain, viewKind, vault.vault_id, current?.projection_revision ?? 0) as Batch[];
    if (competing.some((batch) => {
      const data = parseBatch(batch);
      const render = data.scope?.reconciliationRender ?? data.reconciliationRender;
      return render?.configRevision === vault.config_revision && render.connectionEpoch === vault.connection_epoch &&
        render.rootIdentity === vault.root_identity;
    })) return;
    const latest = db.prepare(`SELECT projection_revision,manifest_json,manifest_hash,vault_id,cleanup_state
      FROM projection_batches WHERE data_domain=? AND view_kind=? ORDER BY projection_revision DESC LIMIT 1`)
      .get(vault.data_domain, viewKind) as (Batch & { cleanup_state: string }) | undefined;
    const retry = latest?.vault_id === vault.vault_id && latest.cleanup_state === 'failed' &&
      parseBatch(latest).reconciliationRender;
    if (retry && retry.blob === blob && retry.configRevision === vault.config_revision &&
        retry.connectionEpoch === vault.connection_epoch && retry.rootIdentity === vault.root_identity) {
      return { vaultId: vault.vault_id, viewKind, revision: latest.projection_revision, files, reconciliationRender };
    }
    const request = { vaultId: vault.vault_id, viewKind, revision: (latest?.projection_revision ?? 0) + 1, files, reconciliationRender };
    const manifestJson = canonicalPayload({ reconciliationRender, manifest });
    db.prepare('INSERT INTO blobs (sha256,byte_length,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING')
      .run(blob, bytes.length, now);
    db.prepare(`INSERT INTO projection_batches (data_domain,view_kind,projection_revision,vault_id,intent_id,
      manifest_json,manifest_hash,cleanup_state,applied,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',0,?,?)`)
      .run(vault.data_domain, viewKind, request.revision, vault.vault_id, projectionIntentId(vault, request),
        manifestJson, sha256(manifestJson), now, now);
    return request;
  });
  if (input && (await projectVault(db, input, { now, authorize })).state === 'failed') {
    throw new Error('VAULT_PROJECTION_FAILED');
  }
}

function parseBatch(row: Batch): { reconciliationRender?: Render; scope?: { reconciliationRender?: Render }; manifest?: Json;
  publishedIndex?: Omit<NonNullable<Awaited<ReturnType<typeof readIndexFile>>>, 'text'> } {
  if (sha256(row.manifest_json) !== row.manifest_hash) throw new Error('VAULT_RENDER_INVALID');
  return JSON.parse(row.manifest_json);
}
