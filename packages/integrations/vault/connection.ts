import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { canonicalPayload, vaultConnectionSchema, type Json } from '@patrick/contracts';
import { appendDomainEvent, assertRecoveryWriteAllowed, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';

export type VaultConnection = {
  status: 'not_connected' | 'checking' | 'needs_install' | 'needs_permission' | 'awaiting_confirmation' | 'connected' | 'degraded';
  vault_id: string;
  source_id: string;
  config_revision: number;
  scope_hash: string;
  root_identity: string;
  capture_host: string;
  client_mapping_revision: number;
  editor_status: 'ready' | 'missing' | 'stopped' | 'unknown';
  collection_status: 'ready' | 'missing' | 'stopped' | 'unknown';
  projection_status: 'ready' | 'missing' | 'stopped' | 'unknown';
};

export type VaultRecord = {
  vault_id: string;
  source_id: string;
  account_id: string;
  data_domain: string;
  capture_host: string;
  root_path: string;
  isolation_root: string;
  root_identity: string;
  physical_root: string;
  scope_hash: string;
  config_revision: number;
  connection_epoch: number;
  status: VaultConnection['status'];
};

const VAULT_COLUMNS = `vault_id, source_id, account_id, data_domain, capture_host, root_path, isolation_root,
  root_identity, physical_root, scope_hash, config_revision, connection_epoch, status`;

export async function connectVault(db: SqliteDatabase, input: {
  accountId: string;
  deviceId: string;
  vaultId: string;
  root: string;
  domain: string;
  captureHost: string;
  now: string;
}): Promise<void> {
  assertRecoveryWriteAllowed(db, input.domain);
  const physicalRoot = await realpath(input.root);
  const info = await stat(physicalRoot);
  if (!info.isDirectory()) throw new Error('UNPROCESSABLE');
  const identity = `${info.dev}:${info.ino}`;
  const scopeHash = createHash('sha256').update(canonicalPayload({
    domain: input.domain,
    paths: ['知识笔记', '判断案例', '标准修订', '附件', '模板', '系统视图'],
  } satisfies Json)).digest('hex');
  const sourceId = `src_${input.vaultId}`;
  withImmediateTransaction(db, () => {
    assertRecoveryWriteAllowed(db, input.domain);
    if (sourceRootTaken(db, physicalRoot) || vaultRootTaken(db, physicalRoot)) throw new Error('VAULT_ROOT_TAKEN');
    db.prepare(`INSERT INTO vaults (
      vault_id, source_id, account_id, data_domain, capture_host, root_path, isolation_root, root_identity,
      physical_root, scope_hash, config_revision, connection_epoch, status, schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'awaiting_confirmation', '1.0', ?, ?)`).run(
      input.vaultId,
      sourceId,
      input.accountId,
      input.domain,
      input.captureHost,
      physicalRoot,
      join(dirname(input.root), 'isolation'),
      identity,
      physicalRoot,
      scopeHash,
      input.now,
      input.now,
    );
    db.prepare(`INSERT INTO vault_clients (
      device_id, vault_id, mapping_revision, app_status, editor_status, observed_at
    ) VALUES (?, ?, 1, 'missing', 'missing', ?)`).run(input.deviceId, input.vaultId, input.now);
    db.prepare(`INSERT INTO authority_facts (account_id, data_domain, active_version, evaluation_threshold, delegation)
      VALUES (?, ?, NULL, 'frozen', 'owner')`).run(input.accountId, input.domain);
    appendDomainEvent(db, {
      eventId: `vault.connection:${input.vaultId}:1`,
      aggregateId: input.vaultId,
      aggregateVersion: 1,
      accountId: input.accountId,
      dataDomain: input.domain,
      payload: { type: 'vault.connection.changed', vault_id: input.vaultId, status: 'awaiting_confirmation' },
      destination: 'vault',
    });
  });
}

export class VaultConfirmationBlocked extends Error {
  readonly reason: 'root_unavailable' | 'binding_changed';
  constructor(reason: 'root_unavailable' | 'binding_changed') {
    super(reason);
    this.reason = reason;
  }
}

export async function probeVaultConfirmation(vault: VaultRecord): Promise<boolean> {
  if (vault.status !== 'awaiting_confirmation') return false;
  try {
    const absolute = await realpath(vault.root_path);
    if (absolute !== vault.root_path || absolute !== vault.physical_root) return false;
    const info = await stat(absolute);
    if (!info.isDirectory() || `${info.dev}:${info.ino}` !== vault.root_identity) return false;
    await access(absolute, constants.R_OK | constants.W_OK);
    return true;
  } catch (error) {
    if (knownRootFailure(error)) return false;
    throw error;
  }
}

export async function confirmVault(
  db: SqliteDatabase, deviceId: string, vaultId: string, now: string,
  options?: { beforeWrite: () => string },
): Promise<void> {
  const vault = requireVault(db, vaultId);
  assertVaultWriteAllowed(db, vault);
  const mapping = db.prepare('SELECT mapping_revision FROM vault_clients WHERE device_id=? AND vault_id=?');
  const currentMapping = mapping.get(deviceId, vaultId) as { mapping_revision: number } | undefined;
  if (!currentMapping || vault.status !== 'awaiting_confirmation') throw new VaultConfirmationBlocked('binding_changed');
  if (!await probeVaultConfirmation(vault)) throw new VaultConfirmationBlocked('root_unavailable');
  withImmediateTransaction(db, () => {
    const stamped = options?.beforeWrite() ?? now;
    const current = mapping.get(deviceId, vaultId) as { mapping_revision: number } | undefined;
    if (current?.mapping_revision !== currentMapping.mapping_revision) throw new VaultConfirmationBlocked('binding_changed');
    // The asynchronous observation may be obsolete. Recheck the canonical on-disk identity and permissions immediately before CAS.
    try {
      const absolute = realpathSync(vault.root_path);
      const info = lstatSync(vault.root_path);
      if (absolute !== vault.root_path || absolute !== vault.physical_root || !info.isDirectory() ||
          `${info.dev}:${info.ino}` !== vault.root_identity) throw new VaultConfirmationBlocked('root_unavailable');
      accessSync(absolute, constants.R_OK | constants.W_OK);
    } catch (error) {
      if (knownRootFailure(error)) throw new VaultConfirmationBlocked('root_unavailable');
      throw error;
    }
    assertVaultWriteAllowed(db, vault);
    const changed = db.prepare(`UPDATE vaults
      SET status='connected',connection_epoch=connection_epoch+1,updated_at=?
      WHERE vault_id=? AND account_id=? AND data_domain=? AND capture_host=? AND root_path=? AND physical_root=?
        AND root_identity=? AND scope_hash=? AND config_revision=? AND connection_epoch=? AND status='awaiting_confirmation'`)
      .run(stamped, vaultId, vault.account_id, vault.data_domain, vault.capture_host, vault.root_path, vault.physical_root,
        vault.root_identity, vault.scope_hash, vault.config_revision, vault.connection_epoch);
    if (changed.changes !== 1) throw new VaultConfirmationBlocked('binding_changed');
    db.prepare('UPDATE vault_clients SET observed_at=? WHERE device_id=? AND vault_id=?').run(stamped, deviceId, vaultId);
    appendDomainEvent(db, {
      eventId: `vault.connection:${vaultId}:confirmed`,
      aggregateId: vaultId,
      aggregateVersion: vault.config_revision + 1,
      accountId: vault.account_id,
      dataDomain: vault.data_domain,
      payload: { type: 'vault.connection.changed', vault_id: vaultId, status: 'connected' },
      destination: 'vault',
    });
  });
}

function knownRootFailure(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(errorCode(error) ?? '');
}

export async function inspectVault(db: SqliteDatabase, deviceId: string, vaultId: string): Promise<VaultConnection> {
  const vault = requireVault(db, vaultId);
  const live = await statDirectory(vault.root_path);
  const identity = live ? `${live.dev}:${live.ino}` : null;
  const same = identity === vault.root_identity;
  let status = vault.status;
  let collection: VaultConnection['collection_status'] = 'unknown';
  if (!live) {
    status = vault.status === 'connected' ? 'degraded' : vault.status;
    collection = 'stopped';
  } else if (!same) {
    status = 'degraded';
    collection = 'stopped';
  } else if (vault.status === 'connected') {
    collection = 'ready';
  }
  const client = db.prepare(`SELECT mapping_revision FROM vault_clients WHERE device_id = ? AND vault_id = ?`).get(deviceId, vaultId) as {
    mapping_revision: number;
  } | undefined;
  const pointer = db.prepare('SELECT 1 AS ok FROM projection_pointers WHERE data_domain = ?').get(vault.data_domain) as { ok: number } | undefined;
  const connection: VaultConnection = {
    status,
    vault_id: vault.vault_id,
    source_id: vault.source_id,
    config_revision: vault.config_revision,
    scope_hash: vault.scope_hash,
    root_identity: vault.root_identity,
    capture_host: vault.capture_host,
    client_mapping_revision: client?.mapping_revision ?? 0,
    editor_status: 'missing',
    collection_status: collection,
    projection_status: pointer ? 'ready' : 'missing',
  };
  vaultConnectionSchema.parse(connection);
  return connection;
}

export function loadVault(db: SqliteDatabase, vaultId: string): VaultRecord | undefined {
  return db.prepare(`SELECT ${VAULT_COLUMNS} FROM vaults WHERE vault_id = ?`).get(vaultId) as VaultRecord | undefined;
}

export function requireVault(db: SqliteDatabase, vaultId: string): VaultRecord {
  const vault = loadVault(db, vaultId);
  if (!vault) throw new Error('NOT_FOUND');
  return vault;
}

/** Re-read the authoritative binding after callbacks and asynchronous preparation. */
export function assertVaultWriteAllowed(db: SqliteDatabase, expected: VaultRecord): VaultRecord {
  const current = requireVault(db, expected.vault_id);
  assertRecoveryWriteAllowed(db, current.data_domain);
  if (Object.keys(expected).some((key) => current[key as keyof VaultRecord] !== expected[key as keyof VaultRecord])) {
    throw new Error('CONFLICT');
  }
  return current;
}

export function sourceRootTaken(db: SqliteDatabase, physicalRoot: string): boolean {
  const rows = db.prepare('SELECT physical_root FROM source_configs').all() as { physical_root: string }[];
  return rows.some((row) => rootsConflict(row.physical_root, physicalRoot));
}

export function vaultRootTaken(db: SqliteDatabase, physicalRoot: string, exceptVaultId?: string): boolean {
  const rows = db.prepare('SELECT vault_id, physical_root FROM vaults').all() as { vault_id: string; physical_root: string }[];
  return rows.some((row) => row.vault_id !== exceptVaultId && rootsConflict(row.physical_root, physicalRoot));
}

function rootsConflict(left: string, right: string): boolean {
  return left === right || isPathPrefix(left, right) || isPathPrefix(right, left);
}

function isPathPrefix(parent: string, child: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

async function statDirectory(path: string): Promise<{ dev: number; ino: number } | undefined> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return undefined;
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) return String((error as { code: unknown }).code);
  return undefined;
}
