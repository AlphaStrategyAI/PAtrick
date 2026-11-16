import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export type StabilitySample = { size: number; mtimeMs: number };

export type FileSample = StabilitySample & {
  exists: boolean;
  offline: boolean;
  placeholder: boolean;
};

export type DirectoryFile = {
  relativePath: string;
  stable: boolean;
  bytes?: Uint8Array;
};

export type DirectoryScan =
  | { state: 'offline' }
  | { state: 'placeholder' }
  | { state: 'ready'; files: DirectoryFile[] };

const OFFLINE_CODES = new Set(['EIO', 'ENOTCONN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH', 'ESTALE', 'ETIMEDOUT', 'ENXIO', 'ENOTDIR']);

export function stabilityDecision(
  previous: StabilitySample | undefined,
  sample: FileSample,
): { ready: boolean; next: StabilitySample | undefined } {
  if (!sample.exists || sample.offline || sample.placeholder) return { ready: false, next: undefined };
  const next = { size: sample.size, mtimeMs: sample.mtimeMs };
  if (!previous || previous.size !== next.size || previous.mtimeMs !== next.mtimeMs) return { ready: false, next };
  return { ready: true, next };
}

export async function samplePath(path: string): Promise<FileSample> {
  try {
    const info = await stat(path);
    return {
      exists: true,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offline: false,
      placeholder: info.isFile() && info.size > 0 && info.blocks === 0,
    };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { exists: false, size: 0, mtimeMs: 0, offline: false, placeholder: false };
    if (code && OFFLINE_CODES.has(code)) return { exists: false, size: 0, mtimeMs: 0, offline: true, placeholder: false };
    throw error;
  }
}

export async function scanDirectory(root: string, excludes: readonly string[]): Promise<DirectoryScan> {
  const skipped = new Set(excludes);
  const found: Array<{ full: string; relativePath: string; stable: boolean }> = [];
  const walked = await walk(root, root, skipped, found);
  if (walked !== 'ready') return { state: walked };
  const files: DirectoryFile[] = [];
  for (const file of found) {
    if (!file.stable) {
      files.push({ relativePath: file.relativePath, stable: false });
      continue;
    }
    const real = await realInside(root, file.full);
    if (!real) continue;
    files.push({ relativePath: file.relativePath, stable: true, bytes: new Uint8Array(await readFile(real)) });
  }
  return { state: 'ready', files };
}

export async function listSamples(
  root: string,
  excludes: readonly string[],
  limit = 3,
): Promise<Array<{ relativePath: string; byteLength: number }>> {
  const skipped = new Set(excludes);
  const found: Array<{ relativePath: string; byteLength: number }> = [];
  await collectSamples(root, root, skipped, found);
  found.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  return found.slice(0, limit);
}

async function walk(
  root: string,
  dir: string,
  excludes: ReadonlySet<string>,
  found: Array<{ full: string; relativePath: string; stable: boolean }>,
): Promise<'ready' | 'offline' | 'placeholder'> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || (code && OFFLINE_CODES.has(code))) return 'offline';
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.isSymbolicLink()) continue;
    const full = resolve(dir, entry.name);
    const relativePath = toRelative(root, full);
    if (!relativePath || excludes.has(relativePath)) continue;
    if (entry.isDirectory()) {
      const nested = await walk(root, full, excludes, found);
      if (nested !== 'ready') return nested;
      continue;
    }
    if (!entry.isFile()) continue;
    const first = await samplePath(full);
    if (first.offline) return 'offline';
    if (first.placeholder) return 'placeholder';
    if (!first.exists) continue;
    const second = await samplePath(full);
    if (second.offline) return 'offline';
    if (second.placeholder) return 'placeholder';
    const stable = second.exists && second.size === first.size && second.mtimeMs === first.mtimeMs;
    found.push({ full, relativePath, stable });
  }
  return 'ready';
}

async function collectSamples(
  root: string,
  dir: string,
  excludes: ReadonlySet<string>,
  found: Array<{ relativePath: string; byteLength: number }>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.isSymbolicLink()) continue;
    const full = resolve(dir, entry.name);
    const relativePath = toRelative(root, full);
    if (!relativePath || excludes.has(relativePath)) continue;
    if (entry.isDirectory()) {
      await collectSamples(root, full, excludes, found);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(full);
    if (info.size > 0 && info.blocks === 0) continue;
    found.push({ relativePath, byteLength: info.size });
  }
}

async function realInside(root: string, full: string): Promise<string | null> {
  try {
    const rootReal = await realpath(root);
    const fileReal = await realpath(full);
    return isInside(rootReal, fileReal) ? fileReal : null;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function toRelative(root: string, full: string): string | null {
  const value = relative(root, full).split(sep).join('/');
  if (value === '' || value.startsWith('../') || value === '..') return null;
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(prefix);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}
