import { stripTypeScriptTypes } from 'node:module';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { autoloopHub } from '../lib/deployment-templates.mjs';
import { admitReadRoot, readRegularFile, sha256 } from '../lib/release.mjs';

type KernelFact = { version: 1; seq: number; changes: unknown[] };
export const autoloopKernelSha256 = autoloopHub.files[autoloopHub.initializer];

export async function loadAutoloopKernel(kernelPath: string, guard: () => void) {
  const root = admitReadRoot(dirname(kernelPath), { allowAncestorEntriesChange: true });
  const source = await readRegularFile(kernelPath, 64 * 1024, { root: root.root, validate() {
    guard();
    root.validate();
  } });
  if (sha256(source) !== autoloopKernelSha256) throw new Error('AUTOLOOP_BOOTSTRAP_SOURCE_INVALID');
  const code = Buffer.from(stripTypeScriptTypes(source.toString('utf8'))).toString('base64');
  const kernel = await import('data:text/javascript;base64,' + code) as {
    initialize(database: DatabaseSync): void;
    View: new(database: DatabaseSync, seq: number, next: Record<string, number>, format: string) => unknown;
    evolve(view: unknown, facts: Iterable<KernelFact>, database: DatabaseSync): { seq: number };
  };
  guard();
  return kernel;
}

export function replayAutoloopProjection(kernel: Awaited<ReturnType<typeof loadAutoloopKernel>>,
  source: DatabaseSync, expectedSeq: number, guard: () => void): void {
  const metadata = source.prepare('SELECT format FROM projection_meta WHERE id = 1').get();
  const scratch = new DatabaseSync('');
  try {
    function* facts() {
      let previous = 0;
      for (const row of source.prepare('SELECT seq, fact FROM facts ORDER BY seq').iterate()) {
        guard();
        const fact = JSON.parse(String(row.fact)) as KernelFact | null;
        if (fact?.version !== 1 || fact.seq !== row.seq || fact.seq !== previous + 1 || !Array.isArray(fact.changes)) {
          throw new Error('UPGRADE_HUB_FACT_INVALID');
        }
        previous = fact.seq;
        yield fact;
      }
    }
    scratch.exec('BEGIN');
    const view = kernel.evolve(new kernel.View(scratch, 0, {}, String(metadata?.format ?? '')), facts(), scratch);
    scratch.exec('COMMIT');
    if (view.seq !== expectedSeq) throw new Error('UPGRADE_HUB_PROJECTION_MISMATCH');
    if (source.prepare('SELECT COUNT(*) AS n FROM projection_meta').get()?.n !== 1) {
      throw new Error('UPGRADE_HUB_PROJECTION_MISMATCH');
    }
    const checks = [
      'SELECT id, seq, next, format FROM projection_meta ORDER BY id',
      'SELECT collection, key, data FROM projections ORDER BY collection, key',
      'SELECT collection, key, seq FROM projection_refs ORDER BY collection, key, seq',
      'SELECT key, card_id, channel FROM projection_pending ORDER BY key',
    ];
    for (const sql of checks) {
      const replayed = scratch.prepare(sql).iterate();
      try {
        for (const row of source.prepare(sql).iterate()) {
          guard();
          const probe = replayed.next();
          if (probe.done || JSON.stringify(row) !== JSON.stringify(probe.value)) {
            throw new Error('UPGRADE_HUB_PROJECTION_MISMATCH');
          }
        }
        if (!replayed.next().done) throw new Error('UPGRADE_HUB_PROJECTION_MISMATCH');
      } finally { replayed.return?.(); }
    }
    guard();
  } finally { scratch.close(); }
}
