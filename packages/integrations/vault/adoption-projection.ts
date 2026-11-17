import { readFileSync } from 'node:fs';
import { canonicalPayload, type Json } from '@patrick/contracts';
import { appendDomainEvent, withImmediateTransaction, type BlobStore, type SqliteDatabase } from '@patrick/storage';
import { sha256 } from './projection-publication.js';
import { isProjectionIoFailure, PROJECTION_BATCH_FILES, projectVault, type ProjectionRequest, type ProjectionResult } from './projector.js';

type Adopted = {
  account_id: string; data_domain: string; vault_id: string; edit_id: string; receipt_revision: number;
  intent_id: string; projection_revision: number; projection_state: string; manifest_json: string; manifest_hash: string;
  config_revision: number; connection_epoch: number; candidate_id: string; result_ref: string;
  adoption_current: number;
};
type ProjectionOptions = Parameters<typeof projectVault>[2];
type AdoptionBinding = Pick<ProjectionRequest, 'editId' | 'vaultId' | 'viewKind' | 'revision' | 'adoptionRender' | 'expectedFailedReceiptRevision'>;
const format = 'patrick.adoption-render.v1';
const maxBytes = 4 * 1024 * 1024;

export async function projectPendingAdoption(
  db: SqliteDatabase, blobs: BlobStore, candidateId: string, reportId: string, options: ProjectionOptions,
) {
  const target = withImmediateTransaction(db, () => {
    options.authorize?.();
    const current = db.prepare(`SELECT c.edit_id FROM standard_candidates c
      JOIN adoption_facts a ON a.candidate_id=c.candidate_id AND a.data_domain=c.data_domain
      JOIN standards s ON s.standard_id=a.standard_id AND s.account_id=c.account_id AND s.data_domain=a.data_domain
      JOIN edit_receipts r ON r.edit_id=c.edit_id AND r.result_ref=a.report_id AND r.projection_intent_id=a.projection_intent_id
        AND r.receipt_revision=(SELECT MAX(x.receipt_revision) FROM edit_receipts x WHERE x.edit_id=c.edit_id)
      JOIN edit_intents e ON e.edit_id=c.edit_id AND e.account_id=c.account_id AND e.data_domain=c.data_domain
      JOIN vaults v ON v.vault_id=e.vault_id AND v.account_id=e.account_id AND v.data_domain=e.data_domain AND v.status='connected'
      WHERE c.candidate_id=? AND a.report_id=? AND r.business_state='adopted' AND r.projection_state='pending'`)
      .get(candidateId, reportId) as { edit_id: string } | undefined;
    if (!current) return;
    const row = adopted(db, current.edit_id);
    const superseded = observeNewerPointer(db, row, options.now);
    if (superseded) return { result: superseded };
    if (!row.adoption_current) return;
    return { row: frozen(row) ? row : freezeRender(db, row, renderCommittedView(db, row), options.now) };
  });
  if (!target) return;
  if ('result' in target) return target.result;
  return projectFrozen(db, blobs, target.row, options);
}

function renderCommittedView(db: SqliteDatabase, row: Adopted): Record<string, string> {
  const scope = [row.account_id, row.data_domain];
  const active = db.prepare(`SELECT s.standard_id, v.version, v.scope_text, v.rules_json, v.exceptions_text, v.counterexamples_text
    FROM standards s JOIN standard_versions v ON v.standard_id=s.standard_id AND v.data_domain=s.data_domain
      AND v.version=s.active_version AND v.status='active'
    WHERE s.account_id=? AND s.data_domain=? ORDER BY s.standard_id`).all(...scope) as {
    standard_id: string; version: number; scope_text: string; rules_json: string; exceptions_text: string; counterexamples_text: string;
  }[];
  const candidates = db.prepare(`SELECT standard_id,candidate_id,base_version,source_revision,status FROM standard_candidates
    WHERE account_id=? AND data_domain=? AND status='open' ORDER BY standard_id,candidate_id`).all(...scope) as Json[];
  const knowledge = db.prepare(`SELECT knowledge_id,title,revision,status FROM knowledge_records
    WHERE account_id=? AND data_domain=? AND status<>'withdrawn' ORDER BY knowledge_id`).all(...scope) as Json[];
  // Only committed view data; draft contents and evaluation samples (including held-out cases) never enter this export.
  const template = (name: string) => readFileSync(new URL(`../../../assets/vault-kit/系统视图/${name}`, import.meta.url), 'utf8');
  return {
    '知识/当前.md': '# 知识\n\n' + knowledge.map(asMarkdownText).join('\n\n'),
    '生效标准/当前.md': '# 生效标准\n\n' + active.map((item) => [
      asMarkdownText(`${item.standard_id} · v${item.version}`),
      asMarkdownText({ scope: item.scope_text, rules: JSON.parse(item.rules_json) as Json,
        exceptions: item.exceptions_text, counterexamples: item.counterexamples_text }),
    ].join('\n\n')).join('\n\n'),
    '候选标准/当前.md': '# 候选标准\n\n' + candidates.map(asMarkdownText).join('\n\n'),
    '案例/当前.md': '# 案例\n\n暂无获准导出的案例。\n',
    '知识.base': template('知识.base'),
    '标准.base': template('标准.base'),
    '知识关系.canvas': template('知识关系.canvas'),
  };
}

function asMarkdownText(value: Json): string {
  // Obsidian must display user-authored strings as text, without expanding links, HTML or embeds.
  return (typeof value === 'string' ? value : JSON.stringify(value, null, 2)).split(/\r?\n/u).map((line) => '    ' + line).join('\n');
}

function adopted(db: SqliteDatabase, editId: string): Adopted {
  const row = db.prepare(`SELECT e.account_id,e.data_domain,e.vault_id,e.edit_id,r.receipt_revision,r.projection_state,r.candidate_id,r.result_ref,
    b.intent_id,b.projection_revision,b.manifest_json,b.manifest_hash,v.config_revision,v.connection_epoch,
    COALESCE(s.active_version=a.active_version AND s.revision=a.standard_revision, 0) AS adoption_current
    FROM edit_intents e JOIN edit_receipts r ON r.edit_id=e.edit_id
      AND r.receipt_revision=(SELECT MAX(x.receipt_revision) FROM edit_receipts x WHERE x.edit_id=e.edit_id)
    JOIN standard_candidates c ON c.candidate_id=r.candidate_id AND c.edit_id=e.edit_id
      AND c.account_id=e.account_id AND c.data_domain=e.data_domain AND c.status='adopted'
    JOIN adoption_facts a ON a.candidate_id=c.candidate_id AND a.standard_id=c.standard_id
      AND a.report_id=r.result_ref AND a.data_domain=e.data_domain AND a.projection_intent_id=r.projection_intent_id
    JOIN standards s ON s.standard_id=a.standard_id AND s.account_id=e.account_id AND s.data_domain=e.data_domain
    JOIN vaults v ON v.vault_id=e.vault_id AND v.account_id=e.account_id AND v.data_domain=e.data_domain AND v.status='connected'
    JOIN projection_batches b ON b.vault_id=v.vault_id AND b.data_domain=e.data_domain AND b.view_kind='standards'
      AND b.intent_id=a.projection_intent_id AND (r.projection_revision IS NULL OR b.projection_revision=r.projection_revision)
    WHERE e.edit_id=? AND r.business_state='adopted'`).get(editId) as Adopted | undefined;
  if (!row || sha256(row.manifest_json) !== row.manifest_hash) throw new Error('CONFLICT');
  return row;
}

export type AdoptionRender = { intentId: string; blob: string; configRevision: number; connectionEpoch: number };
function manifest(row: Adopted) {
  return JSON.parse(row.manifest_json) as {
    format?: string; render?: AdoptionRender; pending_files?: Record<string, string>; scope?: { adoptionRender?: AdoptionRender };
  };
}
function frozen(row: Adopted, data = manifest(row)): AdoptionRender | null {
  const render = data.format === format ? data.render : data.scope?.adoptionRender;
  if (!render) return null;
  if (render.intentId !== row.intent_id || render.configRevision !== row.config_revision ||
    render.connectionEpoch !== row.connection_epoch || !/^[0-9a-f]{64}$/.test(render.blob)) throw new Error('CONFLICT');
  return render;
}

function encode(files: Record<string, string>): Buffer {
  if (Object.keys(files).length !== PROJECTION_BATCH_FILES.length || PROJECTION_BATCH_FILES.some((path) => typeof files[path] !== 'string')) {
    throw new Error('CONFLICT');
  }
  const bytes = Buffer.from(canonicalPayload(files as Json));
  if (bytes.length > maxBytes) throw new Error('CONFLICT');
  return bytes;
}

export function assertBoundRender(db: SqliteDatabase, input: ProjectionRequest): void {
  const row = boundRow(db, input);
  if (!row.adoption_current || sha256(encode(input.files)) !== input.adoptionRender?.blob) throw new Error('CONFLICT');
}

function boundRow(db: SqliteDatabase, binding: AdoptionBinding): Adopted {
  if (!binding.adoptionRender || !binding.editId) throw new Error('CONFLICT');
  const row = adopted(db, binding.editId);
  const render = frozen(row);
  if (!render || render.blob !== binding.adoptionRender.blob || render.intentId !== binding.adoptionRender.intentId ||
    binding.vaultId !== row.vault_id || binding.revision !== row.projection_revision || binding.viewKind !== 'standards') throw new Error('CONFLICT');
  return row;
}

function freezeRender(db: SqliteDatabase, row: Adopted, files: Record<string, string>, now: string): Adopted {
  const blob = sha256(encode(files));
  const existing = frozen(row);
  if (existing) {
    if (existing.blob !== blob) throw new Error('CONFLICT');
    return row;
  }
  const render: AdoptionRender = {
    intentId: row.intent_id, blob, configRevision: row.config_revision, connectionEpoch: row.connection_epoch,
  };
  // Stage the exact bytes in the same durable store as the adopted receipt, before BlobStore can fail.
  // This temporary copy is dropped once its content-addressed blob has been made durable.
  return updateManifest(db, row, canonicalPayload({ format, render, pending_files: files }), now);
}

function updateManifest(db: SqliteDatabase, row: Adopted, json: string, now: string): Adopted {
  const hash = sha256(json);
  const updated = db.prepare(`UPDATE projection_batches SET manifest_json=?,manifest_hash=?,updated_at=?
    WHERE data_domain=? AND view_kind='standards' AND projection_revision=? AND vault_id=? AND intent_id=? AND applied=0 AND manifest_hash=?`)
    .run(json, hash, now, row.data_domain, row.projection_revision, row.vault_id, row.intent_id, row.manifest_hash);
  if (updated.changes !== 1) throw new Error('CONFLICT');
  return { ...row, manifest_json: json, manifest_hash: hash };
}

export async function publishAdoptionProjection(db: SqliteDatabase, blobs: BlobStore, input: ProjectionRequest, options: ProjectionOptions) {
  const editId = input.editId;
  if (!editId || input.viewKind !== 'standards') throw new Error('CONFLICT');
  const target = withImmediateTransaction(db, () => {
    options.authorize?.();
    const row = adopted(db, editId);
    if (input.vaultId !== row.vault_id || input.revision !== row.projection_revision) throw new Error('CONFLICT');
    const superseded = observeNewerPointer(db, row, options.now);
    if (superseded) return { result: superseded };
    if (!row.adoption_current) throw new Error('CONFLICT');
    return { row: freezeRender(db, row, input.files, options.now) };
  });
  return 'result' in target ? target.result! : projectFrozen(db, blobs, target.row, options);
}

async function projectFrozen(db: SqliteDatabase, blobs: BlobStore, row: Adopted,
  options: ProjectionOptions, expectedFailedReceiptRevision?: number): Promise<ProjectionResult> {
  const data = manifest(row);
  const render = frozen(row, data);
  if (!render) throw new Error('CONFLICT');
  const binding = { vaultId: row.vault_id, viewKind: 'standards', revision: row.projection_revision, editId: row.edit_id,
    adoptionRender: render, expectedFailedReceiptRevision };
  let files: Record<string, string>;
  try {
    if (data.format === format && data.pending_files) {
      files = data.pending_files;
      const bytes = encode(files);
      if (sha256(bytes) !== render.blob || await blobs.putBlob(bytes) !== render.blob) throw new Error('CONFLICT');
      const superseded = withImmediateTransaction(db, () => {
        options.authorize?.();
        const actual = boundRow(db, binding);
        const newer = observeNewerPointer(db, actual, options.now);
        if (newer) return newer;
        if (!actual.adoption_current) throw new Error('CONFLICT');
        if (manifest(actual).pending_files) {
          db.prepare(`INSERT INTO blobs (sha256,byte_length,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING`)
            .run(render.blob, bytes.length, options.now);
          updateManifest(db, actual, canonicalPayload({ format, render }), options.now);
        }
      });
      if (superseded) return superseded;
    } else files = await readFrozen(blobs, render);
  } catch (error) {
    if (!isProjectionIoFailure(error)) throw error;
    return withImmediateTransaction(db, () => {
      options.authorize?.();
      const actual = boundRow(db, binding);
      const superseded = observeNewerPointer(db, actual, options.now);
      if (superseded) return superseded;
      if (!actual.adoption_current) throw new Error('CONFLICT');
      observeAdoptionProjection(db, binding, 'failed', options.now);
      const head = db.prepare(`SELECT projection_revision FROM projection_pointers WHERE data_domain=? AND view_kind='standards'`)
        .get(row.data_domain) as { projection_revision: number } | undefined;
      return { applied: false, pointer: head?.projection_revision ?? null, state: 'failed' };
    });
  }
  return projectVault(db, { ...binding, files }, options);
}

export async function retryAdoptionProjection(
  db: SqliteDatabase, blobs: BlobStore, editId: string, expected: {
    receiptRevision: number; intentId: string; projectionRevision: number;
  }, options: ProjectionOptions, authorize: () => void,
) {
  authorize();
  const row = adopted(db, editId);
  const render = frozen(row);
  if (!render || row.intent_id !== expected.intentId || row.projection_revision !== expected.projectionRevision) {
    throw new Error('CONFLICT');
  }
  if (row.projection_state === 'current' || row.projection_state === 'superseded') {
    // After a terminal receipt, an interrupted command can be replayed as a read.
    const preceding = db.prepare(`SELECT 1 FROM edit_receipts WHERE edit_id=? AND receipt_revision=?
      AND business_state='adopted' AND projection_state='failed' AND projection_intent_id=?
      AND projection_revision=? AND candidate_id=? AND result_ref=?`).get(editId,expected.receiptRevision,
        row.intent_id,row.projection_revision,row.candidate_id,row.result_ref);
    if (preceding && row.receipt_revision > expected.receiptRevision) return;
  }
  if (row.projection_state !== 'failed' || row.receipt_revision !== expected.receiptRevision) throw new Error('CONFLICT');
  const superseded = withImmediateTransaction(db, () => {
    authorize();
    return observeNewerPointer(db, row, options.now);
  });
  if (superseded) return superseded;
  if (!row.adoption_current) throw new Error('CONFLICT');
  return projectFrozen(db, blobs, row, { ...options, authorize }, expected.receiptRevision);
}

async function readFrozen(blobs: BlobStore, render: AdoptionRender): Promise<Record<string, string>> {
  const files = await blobs.readBlob(render.blob);
  if (files.byteLength > maxBytes || sha256(files) !== render.blob) throw new Error('CONFLICT');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files)) as Record<string, string>;
}

export function assertFailedReceiptCurrent(db: SqliteDatabase, input: ProjectionRequest): void {
  if (input.expectedFailedReceiptRevision === undefined || !input.editId) return;
  const row = adopted(db, input.editId);
  if (row.receipt_revision !== input.expectedFailedReceiptRevision || row.projection_state !== 'failed') throw new Error('CONFLICT');
}

/** Advance only the exact adopted receipt. The adoption event, permission and active pointer never change here. */
export function observeAdoptionProjection(db: SqliteDatabase, input: AdoptionBinding, state: 'failed' | 'current', now: string): void {
  const row = boundRow(db, input);
  appendProjectionObservation(db, row, state, now, null);
}

export function supersedeAdoptionProjection(db: SqliteDatabase, input: AdoptionBinding, now: string): ProjectionResult | null {
  return observeNewerPointer(db, boundRow(db, input), now);
}

function observeNewerPointer(db: SqliteDatabase, row: Adopted, now: string): ProjectionResult | null {
  const head = db.prepare(`SELECT p.projection_revision,p.intent_id FROM projection_pointers p
    JOIN projection_batches b ON b.data_domain=p.data_domain AND b.view_kind=p.view_kind
      AND b.projection_revision=p.projection_revision AND b.intent_id=p.intent_id AND b.applied=1
    JOIN vaults v ON v.vault_id=b.vault_id AND v.data_domain=p.data_domain AND v.account_id=?
    WHERE p.data_domain=? AND p.view_kind='standards' AND p.projection_revision>?`)
    .get(row.account_id, row.data_domain, row.projection_revision) as { projection_revision: number; intent_id: string } | undefined;
  if (!head) return null;
  if (row.projection_state !== 'current' && row.projection_state !== 'superseded') {
    db.prepare(`UPDATE projection_batches SET cleanup_state='superseded',updated_at=?
      WHERE data_domain=? AND view_kind='standards' AND projection_revision=? AND vault_id=? AND intent_id=? AND applied=0`)
      .run(now, row.data_domain, row.projection_revision, row.vault_id, row.intent_id);
    appendProjectionObservation(db, row, 'superseded', now, head.intent_id);
  }
  return { applied: false, pointer: head.projection_revision, state: 'superseded' };
}

function appendProjectionObservation(db: SqliteDatabase, row: Adopted, state: 'failed' | 'current' | 'superseded',
  now: string, supersededBy: string | null): void {
  if (row.projection_state === state || row.projection_state === 'current' || row.projection_state === 'superseded') return;
  db.prepare(`INSERT INTO edit_receipts
    SELECT edit_id,receipt_revision+1,file_state,file_proof_ref,business_state,candidate_id,result_ref,
      ?,projection_intent_id,?,?,? FROM edit_receipts WHERE edit_id=? AND receipt_revision=?`)
    .run(state, row.projection_revision, supersededBy, now, row.edit_id, row.receipt_revision);
  appendDomainEvent(db, {
    eventId: `edit.projection:${row.edit_id}:${row.receipt_revision + 1}`, aggregateId: row.edit_id,
    aggregateVersion: row.receipt_revision + 1, accountId: row.account_id, dataDomain: row.data_domain,
    payload: { type: 'edit.receipt.changed', edit_id: row.edit_id, projection_state: state, projection_revision: row.projection_revision,
      ...(supersededBy ? { superseded_by: supersededBy } : {}) },
    destination: 'local',
  });
}
