import { closeSync, constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openAuthorityStore(path, { create = false, readOnly = false, schema, check }) {
  check(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'STORE_INVALID');
  const parent = dirname(path);
  const owner = process.geteuid?.();
  const directory = lstatSync(parent);
  check(realpathSync(parent) === parent && directory.isDirectory() && directory.uid === owner && (directory.mode & 0o077) === 0, 'STORE_INVALID');
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (!existing) {
    check(create && !readOnly, 'STORE_MISSING');
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const identity = lstatSync(path + suffix, { throwIfNoEntry: false });
    if (!identity && suffix) continue;
    check(identity?.isFile() && identity.uid === owner && identity.nlink === 1 && (identity.mode & 0o077) === 0, 'STORE_INVALID');
  }
  const database = new DatabaseSync(path, { readOnly });
  try {
    database.exec('PRAGMA busy_timeout=5000;');
    if (!readOnly) database.exec('PRAGMA synchronous=FULL;');
    if (!existing) database.exec('PRAGMA journal_mode=WAL; ' + schema);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
