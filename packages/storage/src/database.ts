import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export const BUSY_TIMEOUT_MS = 2000;

export type MigrationEntry = { file: string; sha256: string };

export type SqliteDatabase = InstanceType<typeof Database>;

export type OpenDatabaseOptions = {
  migrationsDir?: string;
  manifest?: readonly MigrationEntry[];
};

const packagedMigrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

export function pendingMigrations(applied: readonly MigrationEntry[], manifest: readonly MigrationEntry[]) {
  for (const [index, entry] of applied.entries()) {
    const candidate = manifest[index];
    if (candidate?.file !== entry.file || candidate.sha256 !== entry.sha256) {
      throw new Error('SCHEMA_HISTORY_MISMATCH');
    }
  }
  return manifest.slice(applied.length);
}

export function openDatabase(path: string, options?: OpenDatabaseOptions): SqliteDatabase {
  const db = new Database(path, { timeout: BUSY_TIMEOUT_MS });
  try {
    configure(db);
    migrate(db, options);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function withImmediateTransaction<T>(db: SqliteDatabase, run: () => T): T {
  if (db.inTransaction) return run();
  const transaction = db.transaction(run);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return transaction.immediate();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt === 2) throw error;
    }
  }
  throw new Error('SQLITE_BUSY');
}

export function withDeferredTransaction<T>(db: SqliteDatabase, run: () => T): T {
  if (db.inTransaction) return run();
  return db.transaction(run)();
}

function configure(db: SqliteDatabase): void {
  db.pragma('foreign_keys = ON');
  const journalMode = db.pragma('journal_mode = WAL', { simple: true });
  if (String(journalMode).toLowerCase() !== 'wal') throw new Error('WAL_REQUIRED');
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

function migrate(db: SqliteDatabase, options?: OpenDatabaseOptions): void {
  const directory = options?.migrationsDir ?? packagedMigrationsDir;
  const manifest = options?.manifest ?? readManifest(join(directory, 'manifest.json'));
  const applied = readApplied(db);
  const pending = pendingMigrations(applied, manifest);
  for (const [offset, entry] of pending.entries()) {
    assertMigrationFile(entry);
    const sqlPath = join(directory, entry.file);
    const bytes = readFileSync(sqlPath);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) throw new Error('SCHEMA_FILE_HASH_MISMATCH');
    const position = applied.length + offset;
    const sql = bytes.toString('utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (position, file, sha256) VALUES (?, ?, ?)').run(position, entry.file, entry.sha256);
    }).immediate();
  }
}

function readManifest(path: string): MigrationEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('SCHEMA_MANIFEST_INVALID');
  return parsed.map((entry) => {
    if (!isMigrationEntry(entry)) throw new Error('SCHEMA_MANIFEST_INVALID');
    return entry;
  });
}

function isMigrationEntry(entry: unknown): entry is MigrationEntry {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as { file?: unknown; sha256?: unknown };
  return typeof candidate.file === 'string'
    && candidate.file === basename(candidate.file)
    && typeof candidate.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(candidate.sha256);
}

function assertMigrationFile(entry: MigrationEntry): void {
  if (!isMigrationEntry(entry)) throw new Error('SCHEMA_MANIFEST_INVALID');
}

function readApplied(db: SqliteDatabase): MigrationEntry[] {
  const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return [];
  return db.prepare('SELECT file, sha256 FROM schema_migrations ORDER BY position').all() as MigrationEntry[];
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code: unknown }).code;
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_BUSY_RECOVERY'
    || code === 'SQLITE_BUSY_SNAPSHOT'
    || code === 'SQLITE_BUSY_TIMEOUT';
}
