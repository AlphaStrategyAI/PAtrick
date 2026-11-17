import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export function checkDmgLock(dmgPath, lock) {
  if (!/^\d+\.\d+\.\d+$/.test(lock?.version ?? '') || !/^[a-f0-9]{64}$/.test(lock?.sha256 ?? '')) {
    throw new Error('OBSIDIAN_INSTALLER_UNPINNED');
  }
  if (!/\.dmg$/i.test(dmgPath)) throw new Error('OBSIDIAN_INSTALLER_INVALID_FORMAT');
}

export async function snapshotDmg(dmgPath, target) {
  const source = await open(dmgPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await source.stat()).isFile()) throw new Error('OBSIDIAN_INSTALLER_INVALID_FORMAT');
    await pipeline(source.createReadStream({ autoClose: false }), createWriteStream(target, { flags: 'wx', mode: 0o400 }));
  } finally {
    await source.close();
  }
}

export async function verifyObsidianInstaller(dmgPath, lock) {
  checkDmgLock(dmgPath, lock);
  const hash = createHash('sha256');
  const image = await open(dmgPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await image.stat()).isFile()) throw new Error('OBSIDIAN_INSTALLER_INVALID_FORMAT');
    for await (const chunk of image.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await image.close();
  }
  if (hash.digest('hex') !== lock.sha256) throw new Error('OBSIDIAN_INSTALLER_HASH_MISMATCH');
  return { version: lock.version, sha256: lock.sha256, status: 'hash_verified' };
}
