import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function persistRecord(dir: string, kind: 'policy_wait' | 'terminal', attemptId: string, body: unknown): string {
  if (!/^[-A-Za-z0-9]+$/.test(attemptId)) throw new Error('UNPROCESSABLE');
  const folder = join(dir, kind);
  mkdirSync(folder, { recursive: true });
  const target = join(folder, `${attemptId}.json`);
  const temporary = join(folder, `.${attemptId}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(body)}\n`, 'utf8');
  renameSync(temporary, target);
  return target;
}
