import { constants, realpathSync } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** The trusted directory reader.
 *
 * A source path is resolved one component at a time. The walk never enters a
 * link, the file itself is opened with `O_NOFOLLOW` and read through that
 * descriptor, and the descriptor is asked which file it really opened. A file
 * that stops being a regular file, or that is not inside the approved root
 * after the read, is refused rather than used.
 */

export type DirectoryReadResult =
  | { state: 'read'; bytes: Uint8Array }
  | { state: 'missing' }
  | { state: 'offline' }
  | { state: 'placeholder' }
  | { state: 'rejected'; reason: string };

export type DirectoryEntry = {
  relativePath: string;
  /** The approved root the entry was found in. */
  root: string;
  /** The directory the entry was found in, used to read it without a path walk. */
  directory: string;
  name: string;
  size: number;
  mtimeMs: number;
  placeholder: boolean;
  /** The identity observed during the walk. The opened file has to be the same one. */
  dev: number;
  ino: number;
  /** True when two samples of the file agreed; an unsettled file is never collected. */
  stable: boolean;
};

const OFFLINE_CODES = new Set([
  'EIO', 'ENOTCONN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH', 'ESTALE', 'ETIMEDOUT', 'ENXIO', 'ENOTDIR',
]);

/** The largest object a source may collect, matching the attachment limit. */
export const MAX_DIRECTORY_BYTES = 20 * 1024 * 1024;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Splits a relative path into safe components.
 *
 * An empty, absolute or parent-reaching path is refused before any file is
 * touched.
 */
export function safeComponents(relativePath: string): string[] | null {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\0')) return null;
  const parts: string[] = [];
  for (const part of relativePath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' || part.includes('\\')) return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts : null;
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target === base || target.startsWith(prefix);
}

/** Lists the regular files under a root, without following any link.
 *
 * The walk keeps the directory it is in, so every file can later be read
 * through that directory rather than through the path the walk happened to
 * take.
 */
export async function listDirectory(root: string, excludes: readonly string[]): Promise<{
  state: 'ready' | 'offline' | 'placeholder';
  entries: DirectoryEntry[];
}> {
  const skipped = new Set(excludes);
  const entries: DirectoryEntry[] = [];
  let offline = false;
  let placeholder = false;
  let approved = root;
  try {
    approved = await realpath(root);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || (code && OFFLINE_CODES.has(code))) return { state: 'offline', entries: [] };
    throw error;
  }

  async function walk(directory: string, prefix: string): Promise<void> {
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || (code && OFFLINE_CODES.has(code))) {
        offline = true;
        return;
      }
      if (code === 'ELOOP' || code === 'ENOTDIR') return;
      throw error;
    }
    try {
      for await (const entry of handle) {
        if (entry.name === '.' || entry.name === '..') continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (skipped.has(relativePath)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(resolve(directory, entry.name), relativePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const full = resolve(directory, entry.name);
        const info = await lstat(full).catch(() => undefined);
        if (!info || !info.isFile()) continue;
        const isPlaceholder = info.blocks === 0 && info.size > 0;
        if (isPlaceholder) placeholder = true;
        // A file that is still being written is sampled twice and only collected
        // when both samples agree.
        const second = await lstat(full).catch(() => undefined);
        const stable = !!second && second.size === info.size && second.mtimeMs === info.mtimeMs;
        entries.push({
          relativePath,
          root: approved,
          directory,
          name: entry.name,
          size: info.size,
          mtimeMs: info.mtimeMs,
          placeholder: isPlaceholder,
          dev: Number(info.dev),
          ino: Number(info.ino),
          stable,
        });
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  await walk(approved, '');
  if (offline) return { state: 'offline', entries: [] };
  if (placeholder) return { state: 'placeholder', entries: [] };
  return { state: 'ready', entries };
}

/** Reads one file through its directory, without following a link.
 *
 * The read is bounded, and a file that is not a regular file, that grew past
 * the limit, or that the descriptor reports outside the approved root, is
 * refused.
 */
export async function readDirectoryFile(entry: DirectoryEntry, limit = MAX_DIRECTORY_BYTES): Promise<DirectoryReadResult> {
  let handle;
  try {
    handle = await open(resolve(entry.directory, entry.name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { state: 'missing' };
    if (code === 'ELOOP') return { state: 'rejected', reason: 'the file is a link' };
    if (code && OFFLINE_CODES.has(code)) return { state: 'offline' };
    return { state: 'rejected', reason: code ?? 'the file could not be opened' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { state: 'rejected', reason: 'the file is not a regular file' };
    if (info.size > limit) return { state: 'rejected', reason: 'the file is larger than the limit' };
    // The walk recorded which file it approved. The descriptor has to be that
    // same file, so a directory swapped underneath the walk is refused instead
    // of quietly read.
    if (Number(info.dev) !== entry.dev || Number(info.ino) !== entry.ino) {
      return { state: 'rejected', reason: 'the file is not the one the walk approved' };
    }
    if (!isInsideRoot(entry.root, resolve(entry.directory, entry.name))) {
      return { state: 'rejected', reason: 'the file is outside the approved directory' };
    }
    const bytes = Buffer.allocUnsafe(info.size);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    if (read < bytes.length) return { state: 'rejected', reason: 'the file changed while it was read' };
    return { state: 'read', bytes: new Uint8Array(bytes) };
  } catch (error) {
    const code = errorCode(error);
    if (code && OFFLINE_CODES.has(code)) return { state: 'offline' };
    return { state: 'rejected', reason: code ?? 'the file could not be read' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}
