import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

type RecordKind = 'policy_wait' | 'terminal' | 'execution_claim';

export function ledgerPath(dir: string, kind: RecordKind, attemptId: string): string {
  if (!/^[-A-Za-z0-9]+$/.test(attemptId)) throw new Error('UNPROCESSABLE');
  return join(dir, kind, `${attemptId}.json`);
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function ensureLedgerDirectory(path: string): void {
  path = resolve(path);
  const first = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!first) return;
  for (let current = path; ; current = dirname(current)) {
    syncDirectory(current);
    if (current === first) break;
  }
  syncDirectory(dirname(first));
}

export function persistRecord(dir: string, kind: RecordKind, attemptId: string, body: unknown): string {
  const target = ledgerPath(dir, kind, attemptId);
  const folder = dirname(target);
  ensureLedgerDirectory(folder);
  const temporary = join(folder, `.${attemptId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(body)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    if (kind === 'policy_wait') renameSync(temporary, target);
    else linkSync(temporary, target); // Atomic create that never overwrites a winner.
    syncDirectory(folder);
    return target;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readExactFile(path: string, limit: number, kind: 'plan' | 'supervisor_record' = 'plan'): Uint8Array {
  if (realpathSync(path) !== resolve(path)) throw new Error('BUILD_SYMLINK_DENIED');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    const validLinks = before.nlink === 1 || (kind === 'supervisor_record' && before.nlink === 2
      && (before.mode & 0o077) === 0 && hasScratchLink(path, before.dev, before.ino));
    if (!before.isFile() || before.size < 1 || before.size > limit || !validLinks) throw new Error('BUILD_FILE_INVALID');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!length) break;
      offset += length;
    }
    const after = fstatSync(fd);
    if (offset !== before.size || before.size !== after.size || before.nlink !== after.nlink
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('BUILD_FILE_CHANGED');
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

// A power loss can leave the private scratch name after the durable install.
function hasScratchLink(path: string, dev: number, ino: number): boolean {
  const directory = dirname(path);
  const prefix = '.' + basename(path, '.json') + '.';
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(name.slice(prefix.length))) continue;
    const scratch = lstatSync(join(directory, name), { throwIfNoEntry: false });
    if (scratch?.isFile() && scratch.dev === dev && scratch.ino === ino) return true;
  }
  return false;
}
