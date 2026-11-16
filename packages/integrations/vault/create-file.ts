import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function publishCreateOnly(stagedPath: string, destination: string): Promise<'created' | 'exists'> {
  const bytes = await readFile(stagedPath);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = join(parent, '.patrick-staging');
  await mkdir(staging, { recursive: true });
  await syncDirectory(parent);
  const temporary = join(staging, `${randomUUID()}.tmp`);
  const handle = await open(temporary, 'w', 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    if (errorCode(error) === 'EEXIST') return 'exists';
    throw error;
  }
  await syncDirectory(parent);
  await rm(temporary, { force: true });
  await syncDirectory(staging);
  return 'created';
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) return String((error as { code: unknown }).code);
  return undefined;
}
