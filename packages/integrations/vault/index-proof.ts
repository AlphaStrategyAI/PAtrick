import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const INDEX_PATH = '系统视图/索引.md';
export const SEED_PROOF_PATH = '系统视图/.patrick-index-seed.json';

type IndexIdentity = { dev: number; ino: number; sha256: string; mtimeMs: number };
type SeedVault = { vault_id: string; root_identity: string; config_revision: number; scope_hash: string };

export function indexSeedProof(vault: SeedVault, index: IndexIdentity): string {
  return JSON.stringify({
    format: 1, vaultId: vault.vault_id, rootIdentity: vault.root_identity, configRevision: vault.config_revision,
    scopeHash: vault.scope_hash, dev: index.dev, ino: index.ino, sha256: index.sha256, mtimeMs: index.mtimeMs,
  }) + '\n';
}

export async function readIndexFile(path: string): Promise<IndexIdentity & { text: string } | null> {
  let observed;
  try {
    observed = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const dir = await lstat(dirname(path));
        if (!dir.isDirectory() || (await realpath(dirname(path))).normalize('NFC') !== dirname(path).normalize('NFC')) {
          throw new Error('PROJECTION_INDEX_UNSAFE', { cause: error });
        }
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError;
      }
      return null;
    }
    throw error;
  }
  if (!observed.isFile() || observed.size > 64 * 1024 ||
      (await realpath(path)).normalize('NFC') !== path.normalize('NFC')) throw new Error('PROJECTION_INDEX_UNSAFE');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const found = await file.stat();
    if (!found.isFile() || found.dev !== observed.dev || found.ino !== observed.ino) throw new Error('PROJECTION_INDEX_UNSAFE');
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await file.read(buffer, length, buffer.byteLength - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length > 64 * 1024 || found.size !== length || found.size !== after.size || found.mtimeMs !== after.mtimeMs) {
      throw new Error('PROJECTION_INDEX_UNSAFE');
    }
    const bytes = buffer.subarray(0, length);
    return { dev: found.dev, ino: found.ino, mtimeMs: found.mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') };
  } finally {
    await file.close();
  }
}

export async function indexSeedMatches(root: string, vault: SeedVault, index: IndexIdentity): Promise<boolean> {
  const proof = await readIndexFile(join(root, SEED_PROOF_PATH));
  return proof?.text === indexSeedProof(vault, index);
}
