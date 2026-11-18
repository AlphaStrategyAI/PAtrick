import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { appendDomainEvent, withImmediateTransaction, type BlobStore, type SqliteDatabase } from '@patrick/storage';
import { recordKnowledge } from '../../domain/src/evidence.js';
import { assertVaultWriteAllowed, requireVault, type VaultRecord } from './connection.js';

const NOTE_DIRS = new Set(['知识笔记', '判断案例', '标准修订']);
const ATTACHMENT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);
const MAX_ATTACHMENT_BYTES = 20_000_000;
const ATTACHMENT_CHUNK_BYTES = 64 * 1024;
const OFFLINE_CODES = new Set(['ENOENT', 'EIO', 'ENOTCONN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH', 'ESTALE', 'ETIMEDOUT', 'ENXIO', 'ENOTDIR']);

type Scalar = string | number | boolean | null;
type ParsedFrontMatter =
  | { ok: true; data: Record<string, Scalar>; body: string }
  | { ok: false; line: number };

type FileSample = { dev: number; ino: number; size: number; mtimeMs: number };

type ScannedFile = {
  relativePath: string;
  kind: 'note' | 'attachment';
  bytes: Uint8Array;
  hash: string;
  dev: number;
  ino: number;
};

export type VaultReadResult = {
  state: 'ready' | 'offline' | 'placeholder';
  collected: number;
  attachments: number;
};

export async function readVault(db: SqliteDatabase, blobs: BlobStore, vaultId: string, now: string): Promise<VaultReadResult> {
  const vault = requireVault(db, vaultId);
  assertVaultWriteAllowed(db, vault);
  if (vault.status !== 'connected') throw new Error('CONFLICT');
  let root;
  try {
    root = await lstat(vault.root_path);
  } catch (error) {
    if (OFFLINE_CODES.has(errorCode(error) ?? '')) return { state: 'offline', collected: 0, attachments: 0 };
    throw error;
  }
  const assertRoot = () => {
    const current = lstatSync(vault.root_path);
    if (!current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino ||
        realpathSync(vault.root_path) !== vault.physical_root) throw new Error('CONFLICT');
  };
  const scan = await scanVault(vault.root_path);
  assertVaultWriteAllowed(db, vault);
  if (scan.state !== 'ready') return { state: scan.state, collected: 0, attachments: 0 };
  assertRoot();
  for (const file of scan.files) {
    assertVaultWriteAllowed(db, vault);
    assertRoot();
    await blobs.putBlob(file.bytes);
  }
  return withImmediateTransaction(db, () => {
    const current = assertVaultWriteAllowed(db, vault);
    assertRoot();
    let collected = 0;
    let attachments = 0;
    for (const file of scan.files) {
      const wrote = applyFile(db, current, file, now);
      if (!wrote) continue;
      if (file.kind === 'attachment') attachments += 1;
      else collected += 1;
    }
    return { state: 'ready' as const, collected, attachments };
  });
}

/** An explicit edit check observes one registered file. It never sweeps unrelated input. */
export async function readVaultEdit(
  db: SqliteDatabase, blobs: BlobStore, vaultId: string, relativePath: string, now: string, authorize: () => void,
): Promise<void> {
  const vault = requireVault(db, vaultId);
  assertVaultWriteAllowed(db, vault);
  const authorizeWrite = () => {
    authorize();
    const current = assertVaultWriteAllowed(db, vault);
    const root = lstatSync(vault.root_path);
    if (!root.isDirectory() || `${root.dev}:${root.ino}` !== vault.root_identity ||
        realpathSync(vault.root_path) !== vault.physical_root) throw new Error('CONFLICT');
    return current;
  };
  const parts = relativePath.split('/');
  if (!NOTE_DIRS.has(parts[0]) || parts.length < 2 || extname(relativePath).toLowerCase() !== '.md' ||
    parts.some((part) => !part || part.startsWith('.') || /[:\\\p{Cc}]/u.test(part) || skippedFile(part))) throw new Error('CONFLICT');
  const path = resolve(vault.root_path, ...parts);
  const limit = 8 * 1024 * 1024;
  const sameRoot = async () => {
    const root = await lstat(vault.root_path);
    return root.isDirectory() && `${root.dev}:${root.ino}` === vault.root_identity &&
      (await realpath(vault.root_path)).normalize('NFC') === vault.physical_root.normalize('NFC');
  };
  try {
    if (vault.status !== 'connected' || !await sameRoot()) throw new Error('CONFLICT');
    if ((await realpath(path)).normalize('NFC') !== path.normalize('NFC')) throw new Error('CONFLICT');
    authorizeWrite();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > limit) throw new Error('CONFLICT');
      const bytes = Buffer.alloc(before.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const after = await file.stat();
      const live = await lstat(path);
      if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        live.dev !== after.dev || live.ino !== after.ino || live.mtimeMs !== after.mtimeMs || !await sameRoot() ||
        (await realpath(path)).normalize('NFC') !== path.normalize('NFC')) throw new Error('CONFLICT');
      authorizeWrite();
      const hash = await blobs.putBlob(bytes);
      withImmediateTransaction(db, () => {
        const current = authorizeWrite();
        if (current.root_identity !== vault.root_identity || current.status !== 'connected' ||
          current.connection_epoch !== vault.connection_epoch || current.config_revision !== vault.config_revision) throw new Error('CONFLICT');
        applyFile(db, current, { relativePath, kind: 'note', bytes, hash, dev: after.dev, ino: after.ino }, now);
      });
    } finally {
      await file.close();
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error('CONFLICT', { cause: error });
    throw error;
  }
}

function applyFile(db: SqliteDatabase, vault: VaultRecord, file: ScannedFile, now: string): boolean {
  db.prepare('INSERT INTO blobs (sha256, byte_length, created_at) VALUES (?, ?, ?) ON CONFLICT(sha256) DO NOTHING').run(
    file.hash,
    file.bytes.byteLength,
    now,
  );
  const existing = db.prepare(`SELECT document_id, content_hash, observed_seq, tombstone FROM vault_documents
    WHERE vault_id = ? AND relative_path = ?`).get(vault.vault_id, file.relativePath) as {
    document_id: string;
    content_hash: string | null;
    observed_seq: number;
    tombstone: number;
  } | undefined;
  if (existing && existing.tombstone === 0 && existing.content_hash === file.hash) return false;
  const parsed = file.kind === 'note' ? parseFrontMatter(file.bytes) : undefined;
  const draft = openDraft(db, vault.vault_id, file.relativePath);
  const stillTemplate = draft !== undefined && file.hash === draft.proof;
  const parseError = parsed && !parsed.ok ? String(parsed.line) : null;
  const bodyText = parsed?.ok ? parsed.body : null;
  const knowledgeId = stillTemplate || !parsed?.ok ? null : knowledgeIdFor(vault, file, parsed.data);
  const patrickId = parsed?.ok ? scalarString(parsed.data.patrick_id) : null;
  const documentId = existing?.document_id ?? draft?.documentId ?? `doc_${sha256(`${vault.vault_id}\0${file.relativePath}`).slice(0, 24)}`;
  const observedSeq = (existing?.observed_seq ?? 0) + 1;
  const revisionId = `rev_${sha256(`${documentId}\0${observedSeq}`).slice(0, 24)}`;
  const identity = `${file.dev}:${file.ino}`;
  if (!existing) {
    db.prepare(`INSERT INTO vault_documents (
      document_id, vault_id, relative_path, identity_key, kind, knowledge_id, patrick_id, body_text, content_hash,
      byte_length, observed_seq, tombstone, parse_error, account_id, data_domain, schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '1.0', ?, ?)`).run(
      documentId,
      vault.vault_id,
      file.relativePath,
      identity,
      file.kind,
      knowledgeId,
      patrickId,
      bodyText,
      file.hash,
      file.bytes.byteLength,
      observedSeq,
      parseError,
      vault.account_id,
      vault.data_domain,
      now,
      now,
    );
  } else {
    db.prepare(`UPDATE vault_documents
      SET identity_key = ?, knowledge_id = ?, patrick_id = ?, body_text = ?, content_hash = ?, byte_length = ?,
        observed_seq = ?, tombstone = 0, parse_error = ?, updated_at = ?
      WHERE document_id = ?`).run(
      identity,
      knowledgeId,
      patrickId,
      bodyText,
      file.hash,
      file.bytes.byteLength,
      observedSeq,
      parseError,
      now,
      documentId,
    );
  }
  db.prepare(`INSERT INTO vault_revisions (
    vault_id, document_id, observed_seq, revision_id, content_hash, identity_key, relative_path, tombstone,
    account_id, data_domain, schema_version, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '1.0', ?)`).run(
    vault.vault_id,
    documentId,
    observedSeq,
    revisionId,
    file.hash,
    identity,
    file.relativePath,
    vault.account_id,
    vault.data_domain,
    now,
  );
  appendDomainEvent(db, {
    eventId: `vault.revision:${revisionId}`,
    aggregateId: documentId,
    aggregateVersion: observedSeq,
    accountId: vault.account_id,
    dataDomain: vault.data_domain,
    payload: { type: 'source.revision.committed', document_id: documentId, revision_id: revisionId, content_hash: file.hash },
    destination: 'vault',
  });
  if (!stillTemplate && parsed?.ok && knowledgeId && parsed.data.kind !== 'standard') {
    recordKnowledge(db, {
      accountId: vault.account_id,
      domain: vault.data_domain,
      knowledgeId,
      body: parsed.body,
      alias: scalarString(parsed.data.alias),
      documentId,
      revisionId,
      observedSeq,
      now,
    });
  }
  if (draft && !stillTemplate) observeOwnerDraft(db, draft.editId, file.hash, parsed, now);
  const originals = db.prepare(`SELECT e.edit_id FROM edit_intents e JOIN vault_documents d ON d.document_id=e.document_id
    WHERE e.vault_id=? AND e.account_id=? AND e.data_domain=? AND e.operation='edit_original' AND e.closed_at IS NULL
      AND e.relative_path=? AND e.document_id=? AND e.base_version<? AND d.tombstone=0`)
    .all(vault.vault_id,vault.account_id,vault.data_domain,file.relativePath,documentId,observedSeq) as { edit_id: string }[];
  for (const { edit_id } of originals) observeOwnerDraft(db, edit_id, file.hash, parsed, now);
  return true;
}

function openDraft(db: SqliteDatabase, vaultId: string, relativePath: string): { editId: string; proof: string; documentId: string } | undefined {
  const row = db.prepare(`SELECT d.edit_id, d.template_hash, d.proof_hash, d.document_id
    FROM draft_intents d
    JOIN edit_intents i ON i.edit_id = d.edit_id
    WHERE d.vault_id = ? AND d.relative_path = ? AND i.closed_at IS NULL`).get(vaultId, relativePath) as {
    edit_id: string;
    template_hash: string | null;
    proof_hash: string | null;
    document_id: string;
  } | undefined;
  if (!row) return undefined;
  const proof = row.template_hash ?? row.proof_hash;
  if (!proof) return undefined;
  return { editId: row.edit_id, proof, documentId: row.document_id };
}

function observeOwnerDraft(db: SqliteDatabase, editId: string, hash: string, parsed: ParsedFrontMatter | undefined, now: string): void {
  const latest = db.prepare(`SELECT receipt_revision, file_state, business_state, candidate_id, result_ref,
      projection_state, projection_intent_id, projection_revision, superseded_by
    FROM edit_receipts WHERE edit_id = ? ORDER BY receipt_revision DESC LIMIT 1`).get(editId) as {
    receipt_revision: number;
    file_state: string;
    business_state: string;
    candidate_id: string | null;
    result_ref: string | null;
    projection_state: string;
    projection_intent_id: string | null;
    projection_revision: number | null;
    superseded_by: string | null;
  } | undefined;
  if (!latest) return;
  if (latest.file_state !== 'awaiting_save' && latest.file_state !== 'collected' && latest.file_state !== 'invalid') return;
  const fileState = parsed?.ok ? 'collected' : 'invalid';
  db.prepare(`INSERT INTO edit_receipts (
    edit_id, receipt_revision, file_state, file_proof_ref, business_state, candidate_id, result_ref,
    projection_state, projection_intent_id, projection_revision, superseded_by, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    editId,
    latest.receipt_revision + 1,
    fileState,
    hash,
    latest.business_state,
    latest.candidate_id,
    latest.result_ref,
    latest.projection_state,
    latest.projection_intent_id,
    latest.projection_revision,
    latest.superseded_by,
    now,
  );
}

function knowledgeIdFor(vault: VaultRecord, file: ScannedFile, data: Record<string, Scalar>): string | null {
  if (data.kind === 'standard') return null;
  return scalarString(data.knowledge_id) ?? `k_${sha256(`${vault.vault_id}\0${file.relativePath}`).slice(0, 16)}`;
}

async function scanVault(root: string): Promise<{ state: 'ready'; files: ScannedFile[] } | { state: 'offline' | 'placeholder' }> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (OFFLINE_CODES.has(errorCode(error) ?? '')) return { state: 'offline' };
    throw error;
  }
  const files: ScannedFile[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (NOTE_DIRS.has(entry.name)) {
      const nested = await walk(root, resolve(root, entry.name), 'note');
      if (nested === 'offline') return { state: 'offline' };
      if (nested === 'placeholder') return { state: 'placeholder' };
      files.push(...nested);
      continue;
    }
    if (entry.name === '附件') {
      const nested = await walk(root, resolve(root, entry.name), 'attachment');
      if (nested === 'offline') return { state: 'offline' };
      if (nested === 'placeholder') return { state: 'placeholder' };
      files.push(...nested);
    }
  }
  files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  return { state: 'ready', files };
}

async function walk(
  root: string,
  dir: string,
  kind: 'note' | 'attachment',
): Promise<ScannedFile[] | 'offline' | 'placeholder'> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (OFFLINE_CODES.has(errorCode(error) ?? '')) return 'offline';
    throw error;
  }
  const files: ScannedFile[] = [];
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '模板' || entry.name === '系统视图' || entry.name === '.obsidian') continue;
      const nested = await walk(root, full, kind);
      if (nested === 'offline' || nested === 'placeholder') return nested;
      files.push(...nested);
      continue;
    }
    if (!entry.isFile() || skippedFile(entry.name)) continue;
    if (kind === 'note' && extname(entry.name).toLowerCase() !== '.md') continue;
    if (kind === 'attachment' && !ATTACHMENT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const sample = await stableFile(full);
    if (sample === 'offline') return 'offline';
    if (sample === 'placeholder') return 'placeholder';
    if (!sample) continue;
    const real = await realInside(root, full);
    if (!real) continue;
    const relativePath = relative(root, full).split(sep).join('/');
    if (!relativePath || relativePath.startsWith('..')) continue;
    const bytes = kind === 'attachment' ? await readAttachment(real, sample) : new Uint8Array(await readFile(real));
    if (!bytes) continue;
    files.push({
      relativePath,
      kind,
      bytes,
      hash: sha256(bytes),
      dev: sample.dev,
      ino: sample.ino,
    });
  }
  return files;
}

async function readAttachment(path: string, sample: FileSample): Promise<Uint8Array | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== sample.dev || before.ino !== sample.ino) return;
    if (before.size > MAX_ATTACHMENT_BYTES) throw new Error('VAULT_ATTACHMENT_TOO_LARGE');
    if (before.size !== sample.size || before.mtimeMs !== sample.mtimeMs) return;

    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, Math.min(ATTACHMENT_CHUNK_BYTES, bytes.length - offset), offset);
      if (bytesRead === 0) return;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size > MAX_ATTACHMENT_BYTES) throw new Error('VAULT_ATTACHMENT_TOO_LARGE');
    const named = await lstat(path);
    if (!named.isFile() || named.dev !== after.dev || named.ino !== after.ino) return;
    if (named.size > MAX_ATTACHMENT_BYTES) throw new Error('VAULT_ATTACHMENT_TOO_LARGE');
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        named.size !== after.size || named.ctimeMs !== after.ctimeMs) return;
    return bytes;
  } finally { await file.close(); }
}

function skippedFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tmp') || lower.endsWith('.temp') || name.endsWith('~')) return true;
  if (lower.includes('sync-conflict') || name.includes('(conflicted copy)')) return true;
  if (lower.endsWith('.base') || lower.endsWith('.canvas')) return true;
  if (lower.endsWith('.crdownload') || lower.endsWith('.download')) return true;
  return false;
}

async function stableFile(path: string): Promise<FileSample | 'offline' | 'placeholder' | undefined> {
  const first = await sample(path);
  if (first === 'offline' || first === 'placeholder' || !first) return first;
  const second = await sample(path);
  if (second === 'offline' || second === 'placeholder' || !second) return second;
  if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) return undefined;
  return second;
}

async function sample(path: string): Promise<FileSample | 'offline' | 'placeholder' | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    if (info.size > 0 && info.blocks === 0) return 'placeholder';
    return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return undefined;
    if (code && OFFLINE_CODES.has(code)) return 'offline';
    throw error;
  }
}

async function realInside(root: string, path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path);
    const realRoot = await realpath(root);
    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (real !== realRoot && !real.startsWith(prefix)) return undefined;
    return real;
  } catch (error) {
    if (OFFLINE_CODES.has(errorCode(error) ?? '')) return undefined;
    throw error;
  }
}

export function parseFrontMatter(bytes: Uint8Array): ParsedFrontMatter {
  const text = new TextDecoder().decode(bytes);
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { ok: true, data: {}, body: text };
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      end = index;
      break;
    }
  }
  if (end < 0) return { ok: false, line: 1 };
  const data: Record<string, Scalar> = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (/^\s/.test(line) || /!!|&|\*|<<|\[|\{/.test(line)) return { ok: false, line: index + 1 };
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!match || !match[1] || match[1] in data) return { ok: false, line: index + 1 };
    const parsed = parseScalar(match[2] ?? '');
    if (!parsed.ok) return { ok: false, line: index + 1 };
    data[match[1]] = parsed.value;
  }
  return { ok: true, data, body: lines.slice(end + 1).join('\n') };
}

function parseScalar(raw: string): { ok: true; value: Scalar } | { ok: false } {
  const value = raw.trim();
  if (value === '' || value === 'null' || value === '~') return { ok: true, value: null };
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  if (/^-?\d+$/.test(value)) return { ok: true, value: Number(value) };
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return { ok: true, value: value.slice(1, -1) };
  }
  if (value.includes(':')) return { ok: false };
  return { ok: true, value };
}

function scalarString(value: Scalar | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) return String((error as { code: unknown }).code);
  return undefined;
}
