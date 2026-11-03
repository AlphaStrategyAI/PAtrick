import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyBackup } from '../src/backup.js';
import { readConfig } from '../src/config.js';
import { DomainError } from '../src/domain.js';
import { acquireHostLease } from '../src/lease.js';
import { Store } from '../src/store.js';

const modes = ['live', 'demo', 'test'] as const;
export interface RestoreOptions { snapshot: string; destination: string; writerRevoked: boolean; reconciled: boolean }
export interface RestoreResult { destination: string; previousDirectory?: string; mode: typeof modes[number] }

function assertDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new DomainError('Recovery paths must be real directories, not symbolic links.', 'invalid_backup');
}

function assertPlainFile(root: string, path: string): void {
  const segments = path.split('/'); let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) throw new DomainError('Snapshot files and their parents must not contain symbolic links.', 'invalid_backup');
  }
}

/** Offline restore: no network calls, no service start, and no credentials copied from a snapshot. */
export function restoreBackup(options: RestoreOptions): RestoreResult {
  if (!options.writerRevoked) throw new DomainError('Supply --writer-revoked only after revoking the old writer credentials.', 'recovery_required');
  if (!options.reconciled) throw new DomainError('Supply --reconciled only after reconciling remote PR, merge and message actions.', 'recovery_required');
  const snapshot = resolve(options.snapshot), destination = resolve(options.destination);
  if (destination === dirname(destination) || snapshot === destination || destination.startsWith(snapshot + sep)) throw new DomainError('Choose a separate, non-root data directory.', 'recovery_required');
  assertDirectory(snapshot);
  const manifest = verifyBackup(snapshot);
  const names = manifest.files.map(file => file.path);
  if (new Set(names).size !== names.length) throw new DomainError('Snapshot manifest contains duplicate paths.', 'invalid_backup');
  if (!names.includes('workspace-mode')) throw new DomainError('Snapshot mode is missing. Create a new mode-labelled backup before recovery.', 'invalid_backup');
  for (const path of names) {
    if (!(path === 'patrick.db' || path === 'workspace-mode' || path.startsWith('vault/') && path.endsWith('.md'))) throw new DomainError('Snapshot manifest contains files outside the ledger, published Vault and workspace mode.', 'invalid_backup');
    assertPlainFile(snapshot, path);
  }
  const mode = readFileSync(join(snapshot, 'workspace-mode'), 'utf8').trim();
  if (!modes.includes(mode as typeof modes[number])) throw new DomainError('Snapshot workspace mode is invalid.', 'invalid_backup');
  const typedMode = mode as typeof modes[number];
  const existed = existsSync(destination);
  if (existed) assertDirectory(destination);
  const lockPath = join(destination, 'writer.lock');
  if (existsSync(lockPath) && lstatSync(lockPath).isSymbolicLink()) throw new DomainError('Writer lease ownership cannot be verified through a symbolic link.', 'writer_active', 409);
  // The shared SQLite lease serializes stale-marker replacement with every current host.
  const reservation = acquireHostLease(destination), lease = JSON.stringify(reservation.marker);
  const staging = join(dirname(destination), `.${basename(destination)}.restore-${randomUUID()}`);
  const previous = `${destination}.previous-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  let moved = false, installed = false;
  const removeOwnLease = (directory: string) => {
    const path = join(directory, 'writer.lock');
    try { if (readFileSync(path, 'utf8') === lease) unlinkSync(path); } catch { /* Another owner's lock is never removed. */ }
  };
  try {
    mkdirSync(staging, { mode: 0o700 });
    for (const path of names) {
      mkdirSync(dirname(join(staging, path)), { recursive: true, mode: 0o700 });
      copyFileSync(join(snapshot, path), join(staging, path));
      chmodSync(join(staging, path), 0o600);
    }
    // Verify the copied bytes too, before Store opens or changes their projections.
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
    verifyBackup(staging); unlinkSync(join(staging, 'manifest.json'));
    writeFileSync(join(staging, 'writer.lock'), lease, { mode: 0o600, flag: 'wx' });
    // Store initialization replays withdrawals before rebuilding its scoped FTS and Vault projections.
    const recovered = new Store(join(staging, 'patrick.db'), join(staging, 'vault'));
    try {
      if (typedMode === 'live' && (recovered.get('cursors', 'demo-seeded') || recovered.list('attempts').some(attempt => attempt.model.endsWith('-demo')) || recovered.list('receipts').some(receipt => receipt.pullRequestUrl.startsWith('https://example.com/patrick-demo/')))) throw new DomainError('Demo evidence cannot be restored into a live workspace.', 'workspace_mode', 409);
    } finally { recovered.close(); }
    // Keep both directories on one filesystem. Each rename is atomic; the old directory survives any interrupted second rename.
    if (readFileSync(lockPath, 'utf8') !== lease) throw new DomainError('Writer lease changed before recovery swap. Recovery stopped.', 'writer_active', 409);
    renameSync(destination, previous); moved = true;
    try { renameSync(staging, destination); installed = true; }
    catch (error) {
      if (!existsSync(destination)) { renameSync(previous, destination); moved = false; }
      throw error;
    }
    removeOwnLease(previous);
    if (!existed) {
      // This directory held only this invocation's lease reservation.
      // Close its SQLite handle before removing it.
      reservation.release(); rmSync(previous, { recursive: true });
    }
    return { destination, ...(existed ? { previousDirectory: previous } : {}), mode: typedMode };
  } finally {
    reservation.release();
    if (!installed) {
      removeOwnLease(destination);
      if (moved) removeOwnLease(previous);
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  }
}

function main(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const args = process.argv.slice(2), allowed = new Set(['--writer-revoked', '--reconciled', '--data-dir']);
  const snapshot = args[0];
  if (!snapshot || snapshot.startsWith('--')) throw new Error('Usage: restore.ts SNAPSHOT [--data-dir ABSOLUTE_DIRECTORY] --writer-revoked --reconciled');
  let destination: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (!allowed.has(arg)) throw new Error(`Unknown restore argument: ${arg}`);
    if (arg === '--data-dir') { destination = args[++index]; if (!destination || destination.startsWith('--')) throw new Error('--data-dir needs a path.'); }
  }
  const config = readConfig();
  const target = resolve(destination ?? config.dataDir);
  if (target === config.dataDir && config.vaultDir !== join(config.dataDir, 'vault')) throw new Error('Automated recovery requires a Vault inside dataDir/vault. Stage a separate Vault recovery while the service is stopped.');
  const result = restoreBackup({ snapshot, destination: target, writerRevoked: args.includes('--writer-revoked'), reconciled: args.includes('--reconciled') });
  console.log(`Restored ${result.mode} workspace: ${result.destination}`);
  if (result.previousDirectory) console.log(`Prior directory retained: ${result.previousDirectory}`);
  console.log('No service was started. Supply newly issued credentials externally before restarting.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
