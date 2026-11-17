import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

export function assertName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)) throw new Error('RECOVERY_PATH_INVALID');
}

export function assertRelative(path: string): void {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')
    || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('RECOVERY_PATH_INVALID');
}

export async function containedPath(root: string, path: string): Promise<string> {
  assertRelative(path);
  const actualRoot = await realpath(root);
  const result = resolve(actualRoot, path);
  const difference = relative(actualRoot, result);
  if (difference.startsWith(`..${sep}`) || difference === '..' || isAbsolute(difference)) throw new Error('RECOVERY_PATH_INVALID');
  let cursor = actualRoot;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) throw new Error('RECOVERY_SYMLINK_FORBIDDEN');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return result;
}

export async function walkFiles(root: string): Promise<string[]> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error('RECOVERY_SYMLINK_FORBIDDEN');
  const result: string[] = [];
  async function visit(directory: string, prefix: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertRelative(path);
      if (entry.isSymbolicLink()) throw new Error('RECOVERY_SYMLINK_FORBIDDEN');
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
      else if (entry.isFile()) result.push(path);
      else throw new Error('RECOVERY_SPECIAL_FILE_FORBIDDEN');
    }
  }
  await visit(root, '');
  return result;
}

export async function durableWrite(path: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

export async function durableJson(path: string, value: unknown): Promise<void> {
  await durableWrite(path, canonical(value));
}

export async function durableCopy(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  const handle = await open(destination, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(destination));
}

export async function publishDirectory(from: string, to: string): Promise<void> {
  await rename(from, to);
  await syncDirectory(dirname(to));
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function fileHash(path: string): Promise<{ hash: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { hash: hash.digest('hex'), bytes };
}
