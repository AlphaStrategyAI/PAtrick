import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const HARNESS_FILES = ['manifest.json', 'patrick-bridge.ts', 'patrick-judgment.ts', 'patrick-memory.ts'] as const;

export function evidenceSha256(observation: string): string {
  return createHash('sha256').update(observation, 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function bundleFingerprint(dir: string): { present: boolean; hash: string | null; tools: string[] } {
  const missing = HARNESS_FILES.some((name) => !existsSync(join(dir, name)));
  if (missing) return { present: false, hash: null, tools: [] };
  const hash = createHash('sha256');
  for (const name of HARNESS_FILES) {
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(join(dir, name)));
    hash.update('\0');
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { tools?: { name?: string }[] };
  const tools = (manifest.tools ?? []).flatMap((tool) => (typeof tool.name === 'string' ? [tool.name] : []));
  return { present: true, hash: hash.digest('hex'), tools };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
