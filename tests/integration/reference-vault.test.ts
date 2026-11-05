import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRuntime } from '../../src/runtime.js';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import type { SourceRevision } from '../../src/domain.js';

const roots: string[] = [], runtimes: Awaited<ReturnType<typeof createRuntime>>[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(r => r.close())); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'reference-vault-')); roots.push(root);
  const config = readConfig({ PATRICK_MODE: 'test', PATRICK_DATA_DIR: root, PATRICK_TOKEN: 'test-owner-token-at-least-32-characters' });
  config.projects = [{ id: 'p', projectId: 'p', domain: 'personal', ownerId: config.ownerId, name: 'P', description: '', repository: 'a/b', repositoryProvider: 'github', prdPath: 'PRD.md', allowedPaths: ['PRD.md'], trustedChecks: [], trustedAppIds: [], autoMerge: false, budgetUsd: 1, createdAt: new Date().toISOString() }];
  const runtime = await createRuntime(config); runtimes.push(runtime);
  return { root, config, runtime };
}
function sourcePath(root: string, id: string) {
  const vault = join(root, 'vault');
  const path = readdirSync(vault, { recursive: true }).map(String).find(p => p.endsWith(`${id}.md`))!;
  expect(path).toBeTruthy(); return join(vault, path);
}
function edit(path: string, purpose: 'reference' | 'task' | undefined, addition: string) {
  const original = readFileSync(path, 'utf8');
  const text = original.replace(/^patrick_entity: (.+)$/m, (_, raw) => {
    const entity = JSON.parse(raw) as SourceRevision;
    if (purpose === undefined) delete entity.purpose; else entity.purpose = purpose;
    return `patrick_entity: ${JSON.stringify(entity)}`;
  });
  writeFileSync(path, `${text}\n${addition}\n`);
}
it.each(['task', undefined] as const)('keeps imported references non-executable through scans and restart despite frontmatter purpose %s', async purpose => {
  const { root, config, runtime } = await setup(), app = createApp(runtime);
  const response = await app.request('/api/reference-sources', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${config.authToken}` }, body: JSON.stringify({ projectId: 'p', domain: 'personal', externalId: 'reference', revision: 'v1', title: 'Reference', content: 'Synthetic reference', retention: 'permanent' }) });
  expect(response.status).toBe(200); const { source } = await response.json();
  expect(runtime.store.list('tasks')).toHaveLength(0);
  const path = sourcePath(root, source.id); edit(path, purpose, 'First independent edit.');
  await runtime.collector.scan(); await runtime.collector.scan();
  expect(runtime.store.list('tasks')).toHaveLength(0);
  const edits = runtime.store.list('sources').filter(s => s.externalId.startsWith('vault:'));
  expect(edits).toHaveLength(1); expect(edits[0]).toMatchObject({ purpose: 'reference', status: 'active' });
  expect(runtime.store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest'&&a.payload.sourceId===edits[0]!.id)).toHaveLength(1);
  edit(path, purpose, 'Second independent edit.');
  await runtime.close();
  const next = await createRuntime(config); runtimes.push(next);
  expect(next.store.list('tasks')).toHaveLength(0);
  expect(next.store.list('sources').filter(s => s.externalId.startsWith('vault:'))).toHaveLength(2);
  expect(next.store.list('sources').every(s => s.purpose === 'reference')).toBe(true);
  for(const recovered of next.store.list('sources').filter(s=>s.status==='active'))expect(next.store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest'&&a.payload.sourceId===recovered.id)).toHaveLength(1);
  await next.collector.scan(); await next.collector.scan();
  expect(next.store.list('tasks')).toHaveLength(0);
  const before = next.store.list('sources'); await next.close();
  const final = await createRuntime(config); runtimes.push(final);
  expect(final.store.list('tasks')).toHaveLength(0); expect(final.store.list('sources')).toEqual(before);
});
it('keeps prior task-source recovery behavior when frontmatter pretends to be a reference', async () => {
  const { root, config, runtime } = await setup();
  const task = runtime.engine.ingest({ projectId: 'p', externalId: 'task', revision: 'v1', title: 'Task', content: 'Synthetic task source', purpose: 'task', retention: 'permanent' })!;
  const path = sourcePath(root, task.sourceId); edit(path, 'reference', 'Independent task edit.');
  await runtime.collector.scan(); await runtime.collector.scan();
  expect(runtime.store.list('tasks')).toHaveLength(2);
  expect(runtime.store.list('sources').filter(s => s.externalId.startsWith('vault:'))).toMatchObject([{ purpose: 'task' }]);
  await runtime.close(); const next = await createRuntime(config); runtimes.push(next);
  expect(next.store.list('tasks')).toHaveLength(2);
});

it.each([
  ['reading', 'task'], ['reading', undefined], ['file', 'task'], ['file', undefined],
] as const)('keeps a Vault-only %s reference non-executable with purpose %s when restoring an older ledger', async (kind, purpose) => {
  const { root, config, runtime } = await setup(), restoredDir = join(root, 'older-ledger');
  await runtime.store.backup(join(restoredDir, 'patrick.db'));
  runtime.engine.ingest({ projectId: 'p', kind: 'reading', purpose: 'reference', externalId: 'newer-reference', revision: 'v1', title: 'Newer reference', content: 'Synthetic newer reference', retention: 'permanent' });
  const original = runtime.store.list('sources')[0]!;
  if (kind === 'file') {
    edit(sourcePath(root, original.id), 'reference', 'Earlier independent reference edit.');
    await runtime.collector.scan();
    expect(runtime.store.list('sources').some(s => s.kind === 'file' && s.purpose === 'reference')).toBe(true);
  }
  const target = runtime.store.list('sources').find(s => s.kind === kind)!;
  const path = sourcePath(root, target.id); edit(path, purpose, 'Tampered reference with a newer body.');
  await runtime.close();
  const restoredConfig = { ...config, dataDir: restoredDir };
  const recovered = await createRuntime(restoredConfig); runtimes.push(recovered);
  expect(recovered.store.list('tasks')).toHaveLength(0);
  expect(recovered.store.get('sources', target.id)?.purpose).toBe('reference');
  expect(recovered.store.list('sources').every(s => s.purpose === 'reference')).toBe(true);
  const before = recovered.store.list('sources');
  await recovered.collector.scan(); await recovered.collector.scan();
  expect(recovered.store.list('tasks')).toHaveLength(0); expect(recovered.store.list('sources')).toEqual(before);
  await recovered.close();
  edit(path, 'task', 'Another attempted escalation after recovery.');
  const restarted = await createRuntime(restoredConfig); runtimes.push(restarted);
  await restarted.collector.scan(); await restarted.collector.scan();
  expect(restarted.store.list('tasks')).toHaveLength(0);
  expect(restarted.store.list('sources').every(s => s.purpose === 'reference')).toBe(true);
  const durable = restarted.store.list('sources'); await restarted.close();
  const final = await createRuntime(restoredConfig); runtimes.push(final);
  expect(final.store.list('tasks')).toHaveLength(0); expect(final.store.list('sources')).toEqual(durable);
});

it.each(['matching', 'wrong_revision', 'wrong_scope'] as const)('requires %s trusted execution provenance for a missing task source', async provenance => {
  const { root, config, runtime } = await setup(), restoredDir = join(root, 'task-ledger');
  const task = runtime.engine.ingest({ projectId: 'p', externalId: 'known-task', revision: 'v1', title: 'Known task', content: 'Synthetic known task', retention: 'permanent' })!;
  if (provenance !== 'matching') runtime.store.save('tasks', { ...task, ...(provenance === 'wrong_revision' ? { sourceRevision: 'other-revision' } : { domain: 'other-domain' }) });
  await runtime.store.backup(join(restoredDir, 'patrick.db'));
  const path = sourcePath(root, task.sourceId); edit(path, provenance === 'matching' ? 'reference' : 'task', 'Recovered task-source edit.');
  await runtime.close();
  // Remove only the source row from the restored ledger; its actual task record is still trusted SQLite data.
  const { Store } = await import('../../src/store.js');
  const ledger = new Store(join(restoredDir, 'patrick.db')); ledger.delete('sources', task.sourceId); ledger.close();
  const restoredConfig = { ...config, dataDir: restoredDir };
  const recovered = await createRuntime(restoredConfig); runtimes.push(recovered);
  const executable = provenance === 'matching';
  expect(recovered.store.get('sources', task.sourceId)?.purpose).toBe(executable ? 'task' : 'reference');
  expect(recovered.store.list('tasks')).toHaveLength(executable ? 2 : 1);
  expect(recovered.store.list('sources').filter(s => s.externalId.startsWith('vault:')).every(s => s.purpose === (executable ? 'task' : 'reference'))).toBe(true);
  await recovered.collector.scan(); await recovered.collector.scan(); await recovered.close();
  const restarted = await createRuntime(restoredConfig); runtimes.push(restarted);
  expect(restarted.store.list('tasks')).toHaveLength(executable ? 2 : 1);
});
