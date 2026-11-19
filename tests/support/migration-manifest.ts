import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type MigrationEntry = { file: string; sha256: string };

/** Derives the manifest that `packages/storage/migrations/manifest.json` has to equal.
 *
 * Every `.sql` file in the directory is listed exactly once, ordered by its numeric
 * prefix, with the SHA-256 of the file on disk. Appending a migration therefore
 * extends the manifest instead of invalidating it, while a missing entry, an extra
 * entry, a reordered chain, a duplicated prefix, or an edited file still fails the
 * comparison. Callers keep their own pinned hashes for the earlier files they own so
 * that "appends without changing earlier files" stays a separate guarantee.
 */
export function expectedMigrationManifest(directory: string): MigrationEntry[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort((left, right) => {
      const leftOrder = Number(left.slice(0, 4));
      const rightOrder = Number(right.slice(0, 4));
      return leftOrder === rightOrder ? left.localeCompare(right) : leftOrder - rightOrder;
    });
  const prefixes = new Set<string>();
  for (const file of files) {
    const prefix = file.slice(0, 4);
    if (!/^\d{4}$/.test(prefix) || prefixes.has(prefix)) {
      throw new Error(`MIGRATION_PREFIX_INVALID: ${file}`);
    }
    prefixes.add(prefix);
  }
  return files.map((file) => ({
    file,
    sha256: createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'),
  }));
}
