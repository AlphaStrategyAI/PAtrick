import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createBackup } from '../../src/backup.js';
import { now, type KnowledgeCard, type SourceRevision } from '../../src/domain.js';
import { Store } from '../../src/store.js';
import { acquireHostLease } from '../../src/lease.js';
import { restoreBackup } from '../../scripts/restore.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const source: SourceRevision = { id: 's', projectId: 'p', domain: 'personal', kind: 'manual', externalId: 'e', revision: 'v1', title: 'Recovery evidence', content: 'Never resurrect this private sentence.', locator: 'note', authorId: 'owner', retention: 'permanent', status: 'active', createdAt: now() };
const card: KnowledgeCard = { id: 'c', projectId: 'p', domain: 'personal', sourceId: source.id, sourceRevision: source.revision, title: 'Recovery evidence', body: source.content, quote: source.content, locator: 'note', kind: 'knowledge', verification: 'reported', status: 'active', aliases: [], createdAt: now() };

async function fixture(mode: 'live' | 'demo' | 'test' = 'live') {
  const root = mkdtempSync(join(tmpdir(), 'patrick-restore-')); dirs.push(root);
  const store = new Store(join(root, 'source', 'patrick.db'), join(root, 'source', 'vault'));
  store.save('sources', source); store.save('cards', card);
  writeFileSync(join(root, 'source', 'access-token'), 'snapshot-token'); writeFileSync(join(root, 'source', '.env'), 'PATRICK_GITHUB_TOKEN=snapshot-secret');
  const snapshot = join(root, 'snapshot');
  try { await createBackup(store, snapshot, { mode }); } finally { store.close(); }
  return { root, snapshot, destination: join(root, 'destination') };
}

function updateManifest(snapshot: string, path: string) {
  const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[]; mode?: string };
  manifest.files = manifest.files.filter(file => file.path !== path);
  manifest.files.push({ path, sha256: createHash('sha256').update(readFileSync(join(snapshot, path))).digest('hex') });
  if (path === 'workspace-mode') manifest.mode = readFileSync(join(snapshot, path), 'utf8');
  writeFileSync(join(snapshot, 'manifest.json'), JSON.stringify(manifest));
}

it('rejects a corrupt snapshot before changing the destination', async () => {
  const { snapshot, destination } = await fixture();
  mkdirSync(destination); writeFileSync(join(destination, 'keep'), 'prior state');
  writeFileSync(join(snapshot, 'patrick.db'), 'damaged');
  expect(() => restoreBackup({ snapshot, destination, writerRevoked: true, reconciled: true })).toThrow(/integrity|unverified/i);
  expect(readFileSync(join(destination, 'keep'), 'utf8')).toBe('prior state');
});

it('refuses a live writer even when the operator flags are supplied', async () => {
  const { snapshot, destination } = await fixture();
  mkdirSync(destination); writeFileSync(join(destination, 'writer.lock'), JSON.stringify({ pid: process.pid, leaseId: 'a'.repeat(32), startedAt: now() }));
  expect(() => restoreBackup({ snapshot, destination, writerRevoked: true, reconciled: true })).toThrow(/writer.*active|active.*writer/i);
  expect(existsSync(join(destination, 'writer.lock'))).toBe(true);
});

it('refuses an unverifiable lease instead of guessing that it is stale', async () => {
  const { snapshot, destination } = await fixture();
  mkdirSync(destination); writeFileSync(join(destination, 'writer.lock'), JSON.stringify({ pid: -1, leaseId: 'unknown' }));
  expect(() => restoreBackup({ snapshot, destination, writerRevoked: true, reconciled: true })).toThrow(/ownership|lease/i);
});

it('refuses the live SQLite lease even if its diagnostic marker disappears', async () => {
  const { snapshot, destination } = await fixture();
  const owner = acquireHostLease(destination); unlinkSync(join(destination, 'writer.lock'));
  try { expect(() => restoreBackup({ snapshot, destination, writerRevoked: true, reconciled: true })).toThrow(/lease/i); }
  finally { owner.release(); }
  expect(existsSync(join(destination, 'patrick.db'))).toBe(false);
});

it('requires explicit writer-revocation and remote-reconciliation assertions', async () => {
  const { snapshot, destination } = await fixture();
  expect(() => restoreBackup({ snapshot, destination, writerRevoked: false, reconciled: true })).toThrow(/writer-revoked/);
  expect(() => restoreBackup({ snapshot, destination, writerRevoked: true, reconciled: false })).toThrow(/reconciled/);
  expect(existsSync(destination)).toBe(false);
});

it('replays withdrawal tombstones before the restored Vault and index can be used', async () => {
  const { snapshot, destination } = await fixture();
  // Simulate a tombstone whose derived card/Vault still contains the prior readable revision.
  const db = new Database(join(snapshot, 'patrick.db'));
  db.prepare('UPDATE sources SET data = ? WHERE id = ?').run(JSON.stringify({ ...source, status: 'withdrawn' }), source.id); db.close();
  updateManifest(snapshot, 'patrick.db');
  restoreBackup({ snapshot, destination, writerRevoked: true, reconciled: true });
  const restored = new Store(join(destination, 'patrick.db'), join(destination, 'vault'));
  try {
    expect(restored.get('sources', source.id)).toMatchObject({ status: 'withdrawn', content: '' });
    expect(restored.get('cards', card.id)).toMatchObject({ status: 'withdrawn', body: '', quote: '' });
    expect(restored.searchCards('private sentence', { projectId: 'p', domain: 'personal' })).toEqual([]);
    const walk = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : readFileSync(join(dir, entry.name), 'utf8')).join('\n');
    expect(walk(join(destination, 'vault'))).not.toContain(source.content);
  } finally { restored.close(); }
});

it('restores only ledger/Vault/mode files, keeps credentials external, and retains the prior directory', async () => {
  const { snapshot, destination } = await fixture();
  expect(existsSync(join(snapshot, 'access-token'))).toBe(false); expect(existsSync(join(snapshot, '.env'))).toBe(false);
  mkdirSync(destination); writeFileSync(join(destination, 'keep'), 'prior state'); writeFileSync(join(destination, 'access-token'), 'old-machine-token');
  const result = restoreBackup({ snapshot, destination, writerRevoked: true, reconciled: true });
  expect(result.previousDirectory).toBeTruthy();
  expect(readFileSync(join(result.previousDirectory!, 'keep'), 'utf8')).toBe('prior state');
  expect(readFileSync(join(result.previousDirectory!, 'access-token'), 'utf8')).toBe('old-machine-token');
  expect(existsSync(join(destination, 'patrick.db'))).toBe(true);
  expect(existsSync(join(destination, 'access-token'))).toBe(false);
  expect(existsSync(join(destination, '.env'))).toBe(false);
  expect(existsSync(join(destination, 'writer.lock'))).toBe(false);
});

it('backs up again after restoring a clean Vault with completed privacy cleanup', async () => {
  const root=mkdtempSync(join(tmpdir(),'patrick-restore-next-backup-'));dirs.push(root);
  const vault=join(root,'source','vault'),snapshot=join(root,'snapshot'),destination=join(root,'destination'),next=join(root,'next');
  let store=new Store(join(root,'source','patrick.db'),vault);
  try {
    store.save('sources',source);store.save('cards',card);store.save('sources',{...source,retention:'ephemeral'});
    expect(store.list('cursors').filter(cursor=>cursor.id.startsWith('vault-redaction:'))).toEqual([]);
    await createBackup(store,snapshot,{mode:'test'});store.close();
    const first=readFileSync(join(snapshot,'vault','p','personal','cards','c.md'),'utf8');expect(first).not.toContain(source.content);
    restoreBackup({snapshot,destination,writerRevoked:true,reconciled:true});
    store=new Store(join(destination,'patrick.db'),join(destination,'vault'));
    expect(store.list('cursors').filter(cursor=>cursor.id.startsWith('vault-redaction:'))).toEqual([]);
    expect(readFileSync(join(destination,'vault','p','personal','cards','c.md'),'utf8')).not.toContain(source.content);
    await createBackup(store,next,{mode:'test'});
    expect(readFileSync(join(next,'vault','p','personal','cards','c.md'),'utf8')).not.toContain(source.content);
  } finally { store.close(); }
});

it('preserves demo mode and refuses a snapshot whose mode cannot be established', async () => {
  const demo = await fixture('demo');
  restoreBackup({ ...demo, writerRevoked: true, reconciled: true });
  expect(readFileSync(join(demo.destination, 'workspace-mode'), 'utf8')).toBe('demo');
  const unknown = await fixture();
  const manifest = JSON.parse(readFileSync(join(unknown.snapshot, 'manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[]; mode?: string };
  manifest.files = manifest.files.filter(file => file.path !== 'workspace-mode'); delete manifest.mode;
  rmSync(join(unknown.snapshot, 'workspace-mode'));
  writeFileSync(join(unknown.snapshot, 'manifest.json'), JSON.stringify(manifest));
  expect(() => restoreBackup({ ...unknown, writerRevoked: true, reconciled: true })).toThrow(/mode/i);
});

it('refuses a credential file even if someone adds it to the integrity manifest', async () => {
  const { snapshot, destination } = await fixture();
  writeFileSync(join(snapshot, 'access-token'), 'snapshot-token'); updateManifest(snapshot, 'access-token');
  expect(() => restoreBackup({ snapshot, destination, writerRevoked: true, reconciled: true })).toThrow(/outside the ledger/i);
  expect(existsSync(join(destination, 'access-token'))).toBe(false);
});

it('refuses demo markers labelled as a live snapshot', async () => {
  const { snapshot, destination } = await fixture();
  const db = new Database(join(snapshot, 'patrick.db'));
  db.prepare('INSERT INTO cursors(id, project_id, domain, data) VALUES(?,?,?,?)').run('demo-seeded', 'p', 'personal', JSON.stringify({ id: 'demo-seeded', projectId: 'p', domain: 'personal', value: '1', updatedAt: now() })); db.close();
  updateManifest(snapshot, 'patrick.db');
  expect(() => restoreBackup({ snapshot, destination, writerRevoked: true, reconciled: true })).toThrow(/demo.*live/i);
  expect(existsSync(join(destination, 'patrick.db'))).toBe(false);
});
