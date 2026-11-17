import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const canonical = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();

export async function exists(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function ownedDirectory(path: string, uid: number) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0 ||
      (await realpath(path)).normalize('NFC') !== path.normalize('NFC')) throw new Error('REHEARSAL_UNSAFE_PATH');
  return info;
}

export async function ownedFile(path: string, uid: number, access = constants.O_RDONLY) {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.uid !== uid || initial.nlink !== 1 || (initial.mode & 0o022) !== 0) {
    throw new Error('REHEARSAL_UNSAFE_PATH');
  }
  const fd = await open(path, access | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const opened = await fd.stat();
  if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.nlink !== 1) {
    await fd.close();
    throw new Error('REHEARSAL_UNSAFE_PATH');
  }
  return fd;
}

export async function readOwned(path: string, uid: number, limit = 128 * 1024) {
  const fd = await ownedFile(path, uid);
  try {
    const limitBytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < limitBytes.byteLength) {
      const { bytesRead } = await fd.read(limitBytes, length, limitBytes.byteLength - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('REHEARSAL_FILE_LIMIT');
    return limitBytes.subarray(0, length);
  } finally { await fd.close(); }
}

export async function writeExclusive(path: string, bytes: Uint8Array | string) {
  const fd = await open(path, 'wx', 0o600);
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally { await fd.close(); }
}

export const writeRecord = (path: string, record: unknown) => writeExclusive(path, JSON.stringify(record, null, 2) + '\n');
export async function readRecord<T>(path: string, uid: number): Promise<T> {
  return JSON.parse((await readOwned(path, uid)).toString('utf8')) as T;
}

// Control files are scoped to the synthetic rehearsal. Never follow symlinks through to outside data.
export async function auditTree(root: string, uid: number) {
  if (!await exists(root)) return;
  await ownedDirectory(root, uid);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await auditTree(path, uid);
    else {
      const fd = await ownedFile(path, uid);
      await fd.close();
    }
  }
}

export async function auditManuscripts(vault: string, allowed: readonly string[], uid: number) {
  for (const folder of ['知识笔记', '判断案例', '标准修订', '附件']) {
    const path = join(vault, folder);
    await ownedDirectory(path, uid);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '.patrick-staging' && entry.isDirectory()) {
        await auditTree(join(path, entry.name), uid);
        continue;
      }
      if (entry.isFile() && (entry.name === '.DS_Store' || allowed.includes(`${folder}/${entry.name}`))) {
        const fd = await ownedFile(join(path, entry.name), uid);
        await fd.close();
        continue;
      }
      throw new Error('REHEARSAL_UNEXPECTED_VAULT_CONTENT');
    }
  }
}

export async function verifyAncestors(file: string, uid: number) {
  await ownedDirectory(dirname(file), uid);
  if (await exists(file)) {
    const fd = await ownedFile(file, uid);
    await fd.close();
  }
}
