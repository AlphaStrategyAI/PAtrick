import { constants } from 'node:fs';
import { access, lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const readerDirs = ['知识笔记', '判断案例', '标准修订', '附件'];
export const draftDirs = ['知识笔记', '标准修订'];
export const kitDirs = [...readerDirs, '模板', '系统视图'];

export function hasServiceIdentity(serviceUid) {
  return Number.isInteger(serviceUid) && serviceUid >= 0 && process.geteuid?.() === serviceUid;
}

export async function checkRoot(vault) {
  const root = vault.root_path;
  if (!isAbsolute(root) || resolve(root) !== root || vault.physical_root !== root) throw new Error('VAULT_ROOT_CHANGED');
  const info = await lstat(root);
  if (!info.isDirectory() || await realpath(root) !== root || `${info.dev}:${info.ino}` !== vault.root_identity) {
    throw new Error('VAULT_ROOT_CHANGED');
  }
  const config = join(root, '.obsidian');
  if (await optionalStat(config) && !(await lstat(config)).isDirectory()) throw new Error('VAULT_UNSAFE_PATH');
  for (let ancestor = dirname(root); ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    if (await optionalStat(join(ancestor, '.obsidian'))) throw new Error('VAULT_NESTED');
  }
  const normalized = root.normalize('NFC').toLowerCase().split(sep);
  if (normalized.includes('.obsidian') || normalized.some((name, i) =>
    name === 'obsidian' && normalized[i - 1] === 'application support')) throw new Error('VAULT_UNSAFE_PATH');
}

export async function optionalStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function safeDirectory(path, root) {
  const info = await optionalStat(path);
  if (info && (!info.isDirectory() || !samePath(await realpath(path), path) || !inside(root, path))) {
    throw new Error('VAULT_UNSAFE_PATH');
  }
  return info;
}

export async function readRegular(path, allowStagedTwin = false, syncInterrupted = false) {
  const info = await optionalStat(path);
  if (!info) return null;
  if (!info.isFile() || info.nlink !== 1 &&
      !(allowStagedTwin && info.nlink === 2 && await hasStagedTwin(path, info))) throw new Error('VAULT_UNSAFE_PATH');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink > info.nlink || info.dev !== actual.dev || info.ino !== actual.ino) {
      throw new Error('VAULT_UNSAFE_PATH');
    }
    const bytes = await handle.readFile();
    if (syncInterrupted && info.nlink === 2) {
      await handle.sync();
      const parent = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

// A process killed after link but before T06 unlinks its private stage may
// leave exactly one sibling link to the published inode. Never follow links.
async function hasStagedTwin(path, info) {
  const parent = dirname(path);
  const staging = join(parent, '.patrick-staging');
  if (!await safeDirectory(staging, dirname(parent))) return false;
  for (const name of await readdir(staging)) {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/.test(name)) continue;
    const sibling = await optionalStat(join(staging, name));
    if (sibling?.isFile() && sibling.dev === info.dev && sibling.ino === info.ino) return true;
  }
  return false;
}

export function inside(root, path) {
  const part = relative(root.normalize('NFC'), path.normalize('NFC'));
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

export function samePath(left, right) {
  return left.normalize('NFC') === right.normalize('NFC');
}

function permissionFailure(error) {
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return 'denied';
  if (error.message === 'VAULT_UNSAFE_PATH') return 'unsafe';
  return 'unknown';
}

export async function permission(root, dirs, requested) {
  try {
    for (const dir of dirs) {
      const child = join(root, dir);
      const info = await safeDirectory(child, root);
      if (!info) return 'missing';
      await access(child, requested | constants.X_OK);
    }
    return 'allowed';
  } catch (error) {
    return permissionFailure(error);
  }
}

export async function projectorPermission(vault) {
  const generated = await permission(vault.root_path, ['系统视图'], constants.W_OK);
  if (generated !== 'allowed') return generated;
  try {
    const vaultId = vault.vault_id;
    if (!vaultId || vaultId === '.' || vaultId === '..' || /[/\\\p{Cc}]/u.test(vaultId)) return 'unsafe';
    const parent = await realpath(dirname(vault.isolation_root));
    const isolation = join(parent, basename(vault.isolation_root));
    const archive = join(isolation, vaultId);
    const root = vault.root_path;
    if (samePath(isolation, root) || inside(root, isolation) ||
        samePath(archive, root) || inside(archive, root)) return 'unsafe';
    let writable = parent;
    if (await safeDirectory(isolation, parent)) {
      writable = await safeDirectory(archive, isolation) ? archive : isolation;
    }
    await access(writable, constants.W_OK | constants.X_OK);
    return 'allowed';
  } catch (error) {
    return permissionFailure(error);
  }
}
