import { constants, lstatSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqliteDatabase } from '@patrick/storage';
import { canonical, containedPath, digest } from './files.js';
import type { RecoveryDatabaseQuery, RecoveryScope, RecoveryVault } from './types.js';

type VaultRow = {
  vault_id: string; source_id: string; account_id: string; data_domain: string;
  physical_root: string; root_path: string; root_identity: string; scope_hash: string;
};

export type BoundVaultRoot = Readonly<{ root: string; canonicalRoot: string; rootIdentity: string }>;

export function bindVaultRoot(root: string, vault: Pick<RecoveryVault, 'canonicalRoot' | 'rootIdentity'>): BoundVaultRoot {
  if (!vault.canonicalRoot) throw new Error('RECOVERY_VAULT_PHYSICAL_IDENTITY_MISMATCH');
  const binding = Object.freeze({ root, canonicalRoot: vault.canonicalRoot, rootIdentity: vault.rootIdentity });
  assertVaultRoot(binding);
  return binding;
}

/** Reobserve the physical directory, not just its submitted path or Vault ID. */
export function assertVaultRoot(binding: BoundVaultRoot): void {
  try {
    if (realpathSync(binding.root) !== binding.canonicalRoot) throw new Error('root moved');
    for (const path of [binding.root, binding.canonicalRoot]) {
      const info = lstatSync(path);
      if (!info.isDirectory() || `${info.dev}:${info.ino}` !== binding.rootIdentity) throw new Error('root replaced');
    }
  } catch {
    throw new Error('RECOVERY_VAULT_PHYSICAL_IDENTITY_MISMATCH');
  }
}

export async function withVaultRoot<T>(binding: BoundVaultRoot, operation: () => Promise<T>): Promise<T> {
  assertVaultRoot(binding);
  const result = await operation();
  assertVaultRoot(binding);
  return result;
}

export async function readVaultFile(binding: BoundVaultRoot, path: string): Promise<Buffer> {
  return withVaultRoot(binding, async () => {
    const source = await withVaultRoot(binding, () => containedPath(binding.root, path));
    // Include the root's change time: replacing then restoring a child name must
    // invalidate the traversal even when every original directory inode returns.
    const ancestors = [binding.canonicalRoot];
    for (const part of path.split('/').slice(0, -1)) ancestors.push(join(ancestors.at(-1)!, part));
    const admittedAncestors = ancestors.map((directory) => {
      const info = lstatSync(directory, { bigint: true });
      if (!info.isDirectory()) throw new Error('RECOVERY_VAULT_FILE_IDENTITY_MISMATCH');
      return { directory, info };
    });
    const admittedFile = lstatSync(source);
    if (!admittedFile.isFile()) throw new Error('RECOVERY_VAULT_FILE_IDENTITY_MISMATCH');
    const assertSource = () => {
      assertVaultRoot(binding);
      for (const { directory, info } of admittedAncestors) {
        const live = lstatSync(directory, { bigint: true });
        if (!live.isDirectory() || live.dev !== info.dev || live.ino !== info.ino
          || live.ctimeNs !== info.ctimeNs || live.mtimeNs !== info.mtimeNs) {
          throw new Error('RECOVERY_VAULT_FILE_IDENTITY_MISMATCH');
        }
      }
      const live = lstatSync(source);
      if (!live.isFile() || live.dev !== admittedFile.dev || live.ino !== admittedFile.ino
        || live.size !== admittedFile.size || live.mtimeMs !== admittedFile.mtimeMs || live.ctimeMs !== admittedFile.ctimeMs) {
        throw new Error('RECOVERY_VAULT_FILE_IDENTITY_MISMATCH');
      }
    };
    assertSource();
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      assertSource();
      const before = await handle.stat();
      assertSource();
      const first = lstatSync(source);
      if (before.dev !== admittedFile.dev || before.ino !== admittedFile.ino || !before.isFile() || !first.isFile() || before.dev !== first.dev || before.ino !== first.ino) {
        throw new Error('RECOVERY_VAULT_FILE_IDENTITY_MISMATCH');
      }
      const bytes = await handle.readFile();
      assertSource();
      const after = await handle.stat();
      assertSource();
      const live = lstatSync(source);
      if (!live.isFile() || bytes.length !== before.size || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || live.dev !== after.dev || live.ino !== after.ino || live.size !== after.size
        || live.mtimeMs !== after.mtimeMs || live.ctimeMs !== after.ctimeMs) {
        throw new Error('RECOVERY_VAULT_FILE_IDENTITY_MISMATCH');
      }
      return bytes;
    } finally { await handle.close(); }
  });
}

export function registeredVaults(database: RecoveryDatabaseQuery): VaultRow[] {
  return database.prepare(`SELECT vault_id,source_id,account_id,data_domain,physical_root,root_path,root_identity,scope_hash
    FROM vaults ORDER BY vault_id`).all() as VaultRow[];
}

export function captureVaults(database: SqliteDatabase, scope: RecoveryScope): {
  vaults: RecoveryVault[]; gaps: string[]; roots: Map<string, BoundVaultRoot>;
} {
  const vaults: RecoveryVault[] = [];
  const gaps: string[] = [];
  const roots = new Map<string, BoundVaultRoot>();
  const resources = scope.resources.map((resource, index) => {
    let canonicalRoot: string | null = null;
    try { if (resource.kind === 'vault') canonicalRoot = realpathSync(resource.root); } catch { /* Inventory gap below. */ }
    return { ...resource, prefix: `resources/${index}`, canonicalRoot };
  });
  for (const row of registeredVaults(database)) {
    let canonicalRoot: string | null = null;
    try {
      canonicalRoot = realpathSync(row.physical_root);
      bindVaultRoot(row.physical_root, { canonicalRoot, rootIdentity: row.root_identity });
      bindVaultRoot(row.root_path, { canonicalRoot, rootIdentity: row.root_identity });
    } catch {
      canonicalRoot = null;
      gaps.push(`vault_physical_identity_mismatch:${row.vault_id}`);
    }
    const matches = resources.filter((resource) => resource.kind === 'vault' && resource.domain === row.data_domain
      && resource.canonicalRoot === canonicalRoot && canonicalRoot !== null && (!resource.vaultId || resource.vaultId === row.vault_id));
    let resourcePrefix: string | null = null;
    if (matches.length === 1) {
      try {
        const binding = bindVaultRoot(matches[0].root, { canonicalRoot, rootIdentity: row.root_identity });
        resourcePrefix = matches[0].prefix;
        roots.set(resourcePrefix, binding);
      } catch { gaps.push(`vault_physical_identity_mismatch:${row.vault_id}`); }
    }
    if (!resourcePrefix) gaps.push(`vault_missing_or_ambiguous:${row.vault_id}`);
    vaults.push({
      vaultId: row.vault_id, accountId: row.account_id, sourceId: row.source_id, domain: row.data_domain,
      physicalRoot: row.physical_root, canonicalRoot, rootIdentity: row.root_identity, scopeHash: row.scope_hash, resourcePrefix,
    });
  }
  for (const resource of resources.filter((resource) => resource.kind === 'vault')) {
    if (vaults.filter((vault) => vault.resourcePrefix === resource.prefix).length !== 1) gaps.push(`vault_resource_unregistered:${resource.prefix}`);
  }
  const sourceIds = vaults.map((vault) => vault.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) gaps.push('vault_source_mapping_ambiguous');
  return { vaults, gaps, roots };
}

export function verifyVaultRegistrations(database: RecoveryDatabaseQuery, vaults: RecoveryVault[]): void {
  const expected = registeredVaults(database).map((row) => ({
    vaultId: row.vault_id, accountId: row.account_id, sourceId: row.source_id, domain: row.data_domain,
    physicalRoot: row.physical_root, rootIdentity: row.root_identity, scopeHash: row.scope_hash,
  }));
  const actual = vaults.map(({ canonicalRoot: _root, resourcePrefix: _prefix, ...identity }) => identity)
    .sort((left, right) => left.vaultId.localeCompare(right.vaultId));
  if (canonical(actual) !== canonical(expected)) throw new Error('RECOVERY_VAULT_REGISTRATION_MISMATCH');
}

export function restoredVaultRoot(directory: string, vault: Pick<RecoveryVault, 'domain' | 'vaultId'>): string {
  return join(directory, 'vault', vault.domain, digest(vault.vaultId));
}
