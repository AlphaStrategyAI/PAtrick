import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { canonicalPayload, editIntentRequestSchema, editReceiptSchema, type Json } from '@patrick/contracts';
import { appendDomainEvent, withImmediateTransaction, type BlobStore, type SqliteDatabase } from '@patrick/storage';
import { queryEvidence, withdrawEvidence, type EvidencePack, type EvidenceQuery } from '../../domain/src/evidence.js';
import { publishCreateOnly } from './create-file.js';
import { confirmVault, connectVault, inspectVault, requireVault, type VaultConnection, type VaultRecord } from './connection.js';
import { readVault, type VaultReadResult } from './reader.js';
import { projectVault, type ProjectionRequest, type ProjectionResult } from './projector.js';
import { editKey, obsidianFileUri } from './uri.js';

export type EditIntentRequest = z.infer<typeof editIntentRequestSchema>;
export type EditReceipt = z.infer<typeof editReceiptSchema>;

export type VaultPrincipal = {
  account_id: string;
  caller_id: string;
  auth_epoch: number;
  authenticated_at: string;
  domains: string[];
  operations: string[];
};

export type VaultApiOptions = {
  blobs: BlobStore;
  now?: () => Date;
  captureHost?: string;
  beforeDraftWrite?: (editId: string) => void;
  afterDraftWrite?: (editId: string) => void;
  failProjection?: (revision: number) => boolean;
  onProjectionLock?: (domain: string, viewKind: string) => void;
};

type ReceiptRow = {
  edit_id: string;
  receipt_revision: number;
  file_state: EditReceipt['file']['state'];
  file_proof_ref: string | null;
  business_state: EditReceipt['business']['state'];
  candidate_id: string | null;
  result_ref: string | null;
  projection_state: EditReceipt['projection']['state'];
  projection_intent_id: string | null;
  projection_revision: number | null;
  superseded_by: string | null;
};

type IntentRow = {
  edit_id: string;
  account_id: string;
  data_domain: string;
  vault_id: string;
  operation: EditIntentRequest['operation'];
  active_key: string;
  draft_key: string | null;
  target_id: string | null;
  base_version: number | null;
  document_id: string | null;
  relative_path: string | null;
};

const TEMPLATE_PATH = fileURLToPath(new URL('../../../assets/vault-kit/知识笔记.md', import.meta.url));
const STANDARD_TEMPLATE_PATH = fileURLToPath(new URL('../../../assets/vault-kit/标准修订.md', import.meta.url));

export function createVaultApi(db: SqliteDatabase, options: VaultApiOptions) {
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const captureHost = options.captureHost ?? hostname();

  return {
    connectVault(input: { accountId: string; deviceId: string; vaultId: string; root: string; domain: string }) {
      return connectVault(db, { ...input, captureHost, now: now() });
    },
    confirmVault(deviceId: string, vaultId: string) {
      return confirmVault(db, deviceId, vaultId, now());
    },
    inspectVault(deviceId: string, vaultId: string): Promise<VaultConnection> {
      return inspectVault(db, deviceId, vaultId);
    },
    readVault(vaultId: string): Promise<VaultReadResult> {
      return readVault(db, options.blobs, vaultId, now());
    },
    createEdit(principal: VaultPrincipal, input: EditIntentRequest): Promise<EditReceipt> {
      return createEdit(db, options, principal, input, now);
    },
    retryProjection(editId: string, expectedRevision: number): Promise<EditReceipt> {
      return retryProjection(db, editId, expectedRevision, now);
    },
    queryEvidence(query: EvidenceQuery, principal: VaultPrincipal): Promise<EvidencePack> {
      return queryEvidence(db, query, principal);
    },
    withdrawEvidence(input: { domain: string; evidenceId: string; reason: string }) {
      return Promise.resolve(withdrawEvidence(db, { ...input, now: now() }));
    },
    project(input: ProjectionRequest): Promise<ProjectionResult> {
      return projectVault(db, input, {
        now: now(),
        failProjection: options.failProjection,
        onProjectionLock: options.onProjectionLock,
      });
    },
    fileUri(editId: string): string {
      const intent = db.prepare('SELECT relative_path, vault_id FROM edit_intents WHERE edit_id = ?').get(editId) as {
        relative_path: string | null;
        vault_id: string;
      } | undefined;
      if (!intent?.relative_path) throw new Error('NOT_FOUND');
      const vault = requireVault(db, intent.vault_id);
      return obsidianFileUri(basename(vault.root_path), intent.relative_path);
    },
  };
}

async function createEdit(
  db: SqliteDatabase,
  options: VaultApiOptions,
  principal: VaultPrincipal,
  input: EditIntentRequest,
  now: () => string,
): Promise<EditReceipt> {
  if (!principal.operations.includes('owner') && !principal.operations.includes('edits.write')) throw new Error('FORBIDDEN');
  const vault = connectedVault(db, principal);
  try {
    await access(vault.root_path, constants.W_OK);
  } catch {
    throw new Error('FORBIDDEN');
  }
  const active = activeKey(input);
  const existing = openIntent(db, vault, active);
  if (existing) return reopen(db, vault, existing, now);
  const plan = planEdit(db, vault, input);
  const editId = randomUUID();
  const stamped = now();
  withImmediateTransaction(db, () => {
    db.prepare(`INSERT INTO edit_intents (
      edit_id, account_id, data_domain, vault_id, operation, active_key, draft_key, target_id, base_version,
      document_id, relative_path, request_hash, closed_at, schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '1.0', ?, ?)`).run(
      editId,
      principal.account_id,
      vault.data_domain,
      vault.vault_id,
      input.operation,
      active,
      'draft_key' in input ? input.draft_key : null,
      plan.targetId,
      plan.baseVersion,
      plan.documentId,
      plan.relativePath,
      requestHash(input),
      stamped,
      stamped,
    );
    if (plan.writes) {
      db.prepare(`INSERT INTO draft_intents (
        edit_id, vault_id, relative_path, document_id, template_hash, proof_hash, proof_identity, write_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, ?)`).run(
        editId,
        vault.vault_id,
        plan.relativePath,
        plan.documentId,
        plan.bytes ? sha256(plan.bytes) : null,
        stamped,
        stamped,
      );
    }
    insertReceipt(db, {
      editId,
      revision: 0,
      fileState: plan.writes ? 'preparing' : 'awaiting_save',
      proof: null,
      business: plan.business,
      projection: 'not_due',
      intentId: null,
      projectionRevision: null,
      supersededBy: null,
      now: stamped,
    });
    appendDomainEvent(db, {
      eventId: `edit.receipt:${editId}:0`,
      aggregateId: editId,
      aggregateVersion: 0,
      accountId: principal.account_id,
      dataDomain: vault.data_domain,
      payload: { type: 'edit.receipt.changed', edit_id: editId, operation: input.operation },
      destination: 'vault',
    });
  });
  if (!plan.writes || !plan.bytes) return receipt(db, editId);
  options.beforeDraftWrite?.(editId);
  const outcome = await placeDraft(vault.root_path, plan.relativePath, plan.bytes);
  if (outcome === 'created') options.afterDraftWrite?.(editId);
  const observed = now();
  withImmediateTransaction(db, () => {
    const proof = outcome === 'created' ? sha256(plan.bytes ?? Buffer.alloc(0)) : null;
    insertReceipt(db, {
      editId,
      revision: 1,
      fileState: outcome === 'created' ? 'awaiting_save' : 'conflict',
      proof,
      business: plan.business,
      projection: 'not_due',
      intentId: null,
      projectionRevision: null,
      supersededBy: null,
      now: observed,
    });
    db.prepare(`UPDATE draft_intents SET write_state = ?, proof_hash = ?, updated_at = ? WHERE edit_id = ?`).run(
      outcome === 'created' ? 'written' : 'conflict',
      proof,
      observed,
      editId,
    );
    appendDomainEvent(db, {
      eventId: `edit.receipt:${editId}:1`,
      aggregateId: editId,
      aggregateVersion: 1,
      accountId: principal.account_id,
      dataDomain: vault.data_domain,
      payload: { type: 'edit.receipt.changed', edit_id: editId, file_state: outcome === 'created' ? 'awaiting_save' : 'conflict' },
      destination: 'vault',
    });
  });
  return receipt(db, editId);
}

async function reopen(db: SqliteDatabase, vault: VaultRecord, intent: IntentRow, now: () => string): Promise<EditReceipt> {
  const current = receipt(db, intent.edit_id);
  if (!intent.relative_path || intent.operation === 'edit_original' || current.file.state !== 'preparing') return current;
  const destination = resolveInside(vault.root_path, intent.relative_path);
  if (!(await fileExists(destination))) {
    const draft = db.prepare('SELECT write_state FROM draft_intents WHERE edit_id = ?').get(intent.edit_id) as { write_state: string } | undefined;
    if (draft && draft.write_state !== 'pending') return current;
    const bytes = plannedBytes(intent);
    if (!bytes) return current;
    const outcome = await placeDraft(vault.root_path, intent.relative_path, bytes);
    if (outcome === 'created') {
      const proof = sha256(bytes);
      const stamped = now();
      withImmediateTransaction(db, () => {
        insertReceipt(db, {
          editId: intent.edit_id,
          revision: current.receipt_revision + 1,
          fileState: 'awaiting_save',
          proof,
          business: current.business.state,
          projection: current.projection.state,
          intentId: current.projection.intent_id,
          projectionRevision: current.projection.projection_revision,
          supersededBy: current.projection.superseded_by,
          now: stamped,
        });
        db.prepare(`UPDATE draft_intents SET write_state = 'written', proof_hash = ?, template_hash = COALESCE(template_hash, ?), updated_at = ? WHERE edit_id = ?`).run(
          proof,
          proof,
          stamped,
          intent.edit_id,
        );
      });
      return receipt(db, intent.edit_id);
    }
  }
  if (!(await fileExists(destination))) return current;
  const observed = sha256(await readFile(destination));
  const stamped = now();
  withImmediateTransaction(db, () => {
    insertReceipt(db, {
      editId: intent.edit_id,
      revision: current.receipt_revision + 1,
      fileState: 'awaiting_save',
      proof: observed,
      business: current.business.state,
      projection: current.projection.state,
      intentId: current.projection.intent_id,
      projectionRevision: current.projection.projection_revision,
      supersededBy: current.projection.superseded_by,
      now: stamped,
    });
    db.prepare(`UPDATE draft_intents SET write_state = 'written', proof_hash = ?, updated_at = ? WHERE edit_id = ?`).run(observed, stamped, intent.edit_id);
  });
  return receipt(db, intent.edit_id);
}

function planEdit(db: SqliteDatabase, vault: VaultRecord, input: EditIntentRequest): {
  targetId: string | null;
  baseVersion: number | null;
  documentId: string;
  relativePath: string;
  writes: boolean;
  bytes?: Buffer;
  business: EditReceipt['business']['state'];
} {
  if (input.operation === 'edit_original') {
    const document = db.prepare(`SELECT document_id, relative_path, observed_seq, knowledge_id FROM vault_documents
      WHERE vault_id = ? AND document_id = ? AND tombstone = 0`).get(vault.vault_id, input.document_id) as {
      document_id: string;
      relative_path: string;
      observed_seq: number;
      knowledge_id: string | null;
    } | undefined;
    if (!document || document.knowledge_id !== input.knowledge_id || document.observed_seq !== input.expected_source_revision) {
      throw new Error('CONFLICT');
    }
    return {
      targetId: document.document_id,
      baseVersion: input.expected_source_revision,
      documentId: document.document_id,
      relativePath: document.relative_path,
      writes: false,
      business: 'not_started',
    };
  }
  if (input.operation === 'supplement_knowledge') {
    const knowledge = db.prepare(`SELECT revision FROM knowledge_records
      WHERE knowledge_id = ? AND account_id = ? AND data_domain = ?`).get(input.knowledge_id, vault.account_id, vault.data_domain) as {
      revision: number;
    } | undefined;
    if (!knowledge || knowledge.revision !== input.expected_knowledge_revision) throw new Error('CONFLICT');
    const documentId = `doc_${sha256(`${vault.vault_id}\0supplement\0${input.knowledge_id}`).slice(0, 24)}`;
    const relativePath = `知识笔记/补充/${safeSegment(input.knowledge_id)}.md`;
    return {
      targetId: input.knowledge_id,
      baseVersion: input.expected_knowledge_revision,
      documentId,
      relativePath,
      writes: true,
      bytes: supplementBytes(documentId, input.knowledge_id),
      business: 'not_started',
    };
  }
  if (input.operation === 'create_standard') {
    if (input.expected_active_version !== null) throw new Error('UNPROCESSABLE');
    const authority = db.prepare('SELECT active_version FROM authority_facts WHERE account_id = ? AND data_domain = ?').get(vault.account_id, vault.data_domain) as {
      active_version: number | null;
    } | undefined;
    if (authority && authority.active_version !== null) throw new Error('CONFLICT');
    const standardId = `std_${sha256(`${vault.account_id}\0${vault.data_domain}\0${input.draft_key}`).slice(0, 24)}`;
    const documentId = `doc_${sha256(`${vault.vault_id}\0standard\0${input.draft_key}`).slice(0, 24)}`;
    return {
      targetId: standardId,
      baseVersion: null,
      documentId,
      relativePath: `标准修订/${safeSegment(input.draft_key)}.md`,
      writes: true,
      bytes: Buffer.from(standardDraft({ patrickId: documentId, standardId, baseVersion: null }), 'utf8'),
      business: 'not_started',
    };
  }
  const known = db.prepare(`SELECT target_id FROM edit_intents
    WHERE vault_id = ? AND operation = 'create_standard' AND target_id = ?`).get(vault.vault_id, input.standard_id) as { target_id: string } | undefined;
  const standard = db.prepare('SELECT active_version FROM standards WHERE standard_id = ? AND data_domain = ?').get(input.standard_id, vault.data_domain) as {
    active_version: number | null;
  } | undefined;
  if (!known && !standard) throw new Error('CONFLICT');
  const authority = db.prepare('SELECT active_version FROM authority_facts WHERE account_id = ? AND data_domain = ?').get(vault.account_id, vault.data_domain) as {
    active_version: number | null;
  } | undefined;
  const active = standard ? standard.active_version : authority?.active_version ?? null;
  const documentId = `doc_${sha256(`${vault.vault_id}\0revise\0${input.standard_id}\0${input.base_version}`).slice(0, 24)}`;
  return {
    targetId: input.standard_id,
    baseVersion: input.base_version,
    documentId,
    relativePath: `标准修订/修订-${safeSegment(input.standard_id)}-v${input.base_version}.md`,
    writes: true,
    bytes: Buffer.from(standardDraft({ patrickId: documentId, standardId: input.standard_id, baseVersion: input.base_version }), 'utf8'),
    business: active === input.base_version ? 'pending' : 'stale',
  };
}

function retryProjection(db: SqliteDatabase, editId: string, expectedRevision: number, now: () => string): Promise<EditReceipt> {
  const intent = db.prepare('SELECT edit_id, account_id, data_domain FROM edit_intents WHERE edit_id = ?').get(editId) as {
    edit_id: string;
    account_id: string;
    data_domain: string;
  } | undefined;
  if (!intent) throw new Error('NOT_FOUND');
  const pointer = db.prepare(`SELECT projection_revision, intent_id FROM projection_pointers
    WHERE data_domain = ? AND view_kind = 'knowledge'`).get(intent.data_domain) as {
    projection_revision: number;
    intent_id: string;
  } | undefined;
  const current = receipt(db, editId);
  if (!pointer || expectedRevision >= pointer.projection_revision || current.projection.projection_revision === pointer.projection_revision) {
    return Promise.resolve(current);
  }
  const stamped = now();
  withImmediateTransaction(db, () => {
    insertReceipt(db, {
      editId,
      revision: current.receipt_revision + 1,
      fileState: current.file.state,
      proof: current.file.proof_ref,
      business: current.business.state,
      projection: 'superseded',
      intentId: pointer.intent_id,
      projectionRevision: pointer.projection_revision,
      supersededBy: pointer.intent_id,
      now: stamped,
    });
    appendDomainEvent(db, {
      eventId: `edit.receipt:${editId}:retry:${expectedRevision}`,
      aggregateId: editId,
      aggregateVersion: current.receipt_revision + 1,
      accountId: intent.account_id,
      dataDomain: intent.data_domain,
      payload: { type: 'edit.receipt.changed', edit_id: editId, projection_revision: pointer.projection_revision },
      destination: 'vault',
    });
  });
  return Promise.resolve(receipt(db, editId));
}

function connectedVault(db: SqliteDatabase, principal: VaultPrincipal): VaultRecord {
  const rows = db.prepare(`SELECT vault_id, data_domain FROM vaults WHERE account_id = ? AND status = 'connected'`).all(principal.account_id) as {
    vault_id: string;
    data_domain: string;
  }[];
  const visible = rows.filter((row) => principal.domains.includes(row.data_domain));
  const chosen = visible[0];
  if (!chosen || visible.length !== 1) throw new Error(visible.length === 0 ? 'FORBIDDEN' : 'UNPROCESSABLE');
  return requireVault(db, chosen.vault_id);
}

function openIntent(db: SqliteDatabase, vault: VaultRecord, active: string): IntentRow | undefined {
  return db.prepare(`SELECT edit_id, account_id, data_domain, vault_id, operation, active_key, draft_key, target_id,
      base_version, document_id, relative_path
    FROM edit_intents
    WHERE account_id = ? AND data_domain = ? AND active_key = ? AND closed_at IS NULL`).get(
    vault.account_id,
    vault.data_domain,
    active,
  ) as IntentRow | undefined;
}

function activeKey(input: EditIntentRequest): string {
  if (input.operation === 'edit_original') return editKey(input.operation, input.document_id, input.expected_source_revision, '');
  if (input.operation === 'supplement_knowledge') return editKey(input.operation, input.knowledge_id, input.expected_knowledge_revision, input.draft_key);
  if (input.operation === 'create_standard') return editKey(input.operation, null, null, input.draft_key);
  return editKey(input.operation, input.standard_id, input.base_version, input.draft_key);
}

function insertReceipt(db: SqliteDatabase, input: {
  editId: string;
  revision: number;
  fileState: EditReceipt['file']['state'];
  proof: string | null;
  business: EditReceipt['business']['state'];
  projection: EditReceipt['projection']['state'];
  intentId: string | null;
  projectionRevision: number | null;
  supersededBy: string | null;
  now: string;
}): void {
  db.prepare(`INSERT INTO edit_receipts (
    edit_id, receipt_revision, file_state, file_proof_ref, business_state, candidate_id, result_ref,
    projection_state, projection_intent_id, projection_revision, superseded_by, created_at
  ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`).run(
    input.editId,
    input.revision,
    input.fileState,
    input.proof,
    input.business,
    input.projection,
    input.intentId,
    input.projectionRevision,
    input.supersededBy,
    input.now,
  );
}

function receipt(db: SqliteDatabase, editId: string): EditReceipt {
  const row = db.prepare(`SELECT edit_id, receipt_revision, file_state, file_proof_ref, business_state, candidate_id,
      result_ref, projection_state, projection_intent_id, projection_revision, superseded_by
    FROM edit_receipts WHERE edit_id = ? ORDER BY receipt_revision DESC LIMIT 1`).get(editId) as ReceiptRow | undefined;
  if (!row) throw new Error('NOT_FOUND');
  return {
    edit_id: row.edit_id,
    receipt_revision: row.receipt_revision,
    file: { state: row.file_state, proof_ref: row.file_proof_ref },
    business: { state: row.business_state, candidate_id: row.candidate_id, result_ref: row.result_ref },
    projection: {
      state: row.projection_state,
      intent_id: row.projection_intent_id,
      projection_revision: row.projection_revision,
      superseded_by: row.superseded_by,
    },
  };
}

async function placeDraft(root: string, relativePath: string, bytes: Buffer): Promise<'created' | 'exists'> {
  const staged = join(root, '.patrick-staging', `${randomUUID()}.md`);
  await mkdir(dirname(staged), { recursive: true });
  const handle = await open(staged, 'w', 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    return await publishCreateOnly(staged, resolveInside(root, relativePath));
  } finally {
    await rm(staged, { force: true });
  }
}

function resolveInside(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split('/'));
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(prefix)) throw new Error('UNPROCESSABLE');
  return target;
}

function safeSegment(value: string): string {
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..') || value.includes('\0')) throw new Error('UNPROCESSABLE');
  return value;
}

function plannedBytes(intent: IntentRow): Buffer | undefined {
  if (!intent.document_id || !intent.target_id) return undefined;
  if (intent.operation === 'supplement_knowledge') return supplementBytes(intent.document_id, intent.target_id);
  if (intent.operation === 'create_standard') {
    return Buffer.from(standardDraft({ patrickId: intent.document_id, standardId: intent.target_id, baseVersion: null }), 'utf8');
  }
  if (intent.operation === 'revise_standard') {
    return Buffer.from(standardDraft({
      patrickId: intent.document_id,
      standardId: intent.target_id,
      baseVersion: intent.base_version,
    }), 'utf8');
  }
  return undefined;
}

function supplementBytes(documentId: string, knowledgeId: string): Buffer {
  const template = readTemplate();
  return Buffer.from(template.replace('patrick_id:', `patrick_id: ${documentId}`).replace('knowledge_id:', `knowledge_id: ${knowledgeId}`), 'utf8');
}

function standardDraft(input: { patrickId: string; standardId: string; baseVersion: number | null }): string {
  const base = input.baseVersion === null ? '' : String(input.baseVersion);
  return readFileSync(STANDARD_TEMPLATE_PATH, 'utf8')
    .replace('patrick_id:', `patrick_id: ${input.patrickId}`)
    .replace('standard_id:', `standard_id: ${input.standardId}`)
    .replace('base_version:', `base_version: ${base}`);
}

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, 'utf8');
}

function requestHash(input: EditIntentRequest): string {
  return sha256(Buffer.from(canonicalPayload(input as unknown as Json)));
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT') return false;
    throw error;
  }
}
