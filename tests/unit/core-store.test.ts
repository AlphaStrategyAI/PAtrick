import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ingestSource } from '../../src/intake.js';
import type { KnowledgeCard, SourceRevision } from '../../src/domain.js';

const roots: string[] = [];
const stores: Store[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'patrick-core-store-')); roots.push(root);
  const store = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(store);
  return { store, root };
}
function source(id = 'source', projectId = 'one', domain = 'personal'): SourceRevision {
  return { id, projectId, domain, kind: 'manual', externalId: id, revision: 'r1', title: '草稿恢复', content: '导出失败后保留草稿，允许恢复。', locator: 'manual:test', authorId: 'owner', retention: 'permanent', status: 'active', createdAt: new Date().toISOString() };
}
function card(s: SourceRevision): KnowledgeCard {
  return { id: `card-${s.id}`, projectId: s.projectId, domain: s.domain, sourceId: s.id, sourceRevision: s.revision, title: '草稿恢复', body: '导出失败后保留草稿以恢复', quote: '导出失败后保留草稿', locator: s.locator, aliases: ['draft'], kind: 'fact', verification: 'reported', status: 'active', createdAt: s.createdAt };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('durable scoped knowledge store', () => {
  it('finds Chinese two-character terms and aliases only within the current scope', () => {
    const { store } = setup();
    for (const s of [source(), source('other', 'two'), source('company', 'one', 'company')]) { store.save('sources', s); store.save('cards', card(s)); }
    expect(store.searchCards('恢复', { projectId: 'one', domain: 'personal' }).map(c => c.id)).toEqual(['card-source']);
    expect(store.searchCards('draft', { projectId: 'one', domain: 'personal' })).toHaveLength(1);
    expect(store.searchCards('" OR *', { projectId: 'one', domain: 'personal' })).toEqual([]);
  });

  it('rolls back both entities and published markdown when a transaction fails', () => {
    const { store, root } = setup(); const s = source(); store.save('sources', s);
    expect(() => store.transaction(() => { store.save('cards', card(s)); throw new Error('abort'); })).toThrow('abort');
    expect(store.list('cards')).toEqual([]);
    const paths = readdirSync(join(root, 'vault'), { recursive: true }).map(String);
    expect(paths.filter(p => p.includes('card-source'))).toEqual([]);
  });

  it('does not resurrect withdrawn or superseded source cards when rebuilding FTS', () => {
    const { store } = setup(); const s = source(); store.save('sources', s); store.save('cards', card(s));
    store.save('sources', { ...s, status: 'withdrawn' }); store.rebuildIndex();
    expect(store.searchCards('草稿', s)).toEqual([]);
    store.save('sources', { ...s, status: 'superseded' }); store.rebuildIndex();
    expect(store.searchCards('草稿', s)).toEqual([]);
  });

  it('retains metadata but never persists temporary source bodies or publishes their cards', async () => {
    const { store, root } = setup(); const s = { ...source(), retention: 'ephemeral' as const, content: 'PRIVATE_EPHEMERAL_BODY' };
    store.save('sources', s); store.save('cards', { ...card(s), body: s.content, quote: s.content });
    expect(store.get('sources', s.id)?.content).toBe(s.content);
    store.close(); const reopened = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(reopened);
    expect(reopened.get('sources', s.id)?.content).toBe('');
    expect(readFileSync(join(root, 'db.sqlite')).includes(Buffer.from(s.content))).toBe(false);
    const files = readdirSync(join(root, 'vault'), { recursive: true }).map(String).filter(p => p.endsWith('.md'));
    expect(files).toEqual([]);
    await reopened.backup(join(root, 'backup.sqlite'));
    const backup = new Store(join(root, 'backup.sqlite')); stores.push(backup);
    expect(backup.get('sources', s.id)?.status).toBe('active');
  });

  it('recovers missing SQLite knowledge from permanent Vault cards without reviving revoked evidence', () => {
    const { store, root } = setup();
    store.save('projects', { id: 'one', projectId: 'one', domain: 'personal', name: 'One', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [1], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: new Date().toISOString() });
    const task = ingestSource(store, { projects: [] }, { projectId: 'one', externalId: 'source', revision: 'r1', title: '草稿恢复', content: source().content, locator: 'manual:test', authorId: 'owner' })!;
    const s = store.get('sources', task.sourceId)!; store.save('cards', card(s));
    const recovered = new Store(join(root, 'recovered.sqlite'), join(root, 'vault')); stores.push(recovered);
    expect(recovered.searchCards('恢复', s).map(c => c.id)).toEqual([`card-${s.id}`]);
    const cardPath = readdirSync(join(root, 'vault'), { recursive: true }).map(String).find(p => p.endsWith(`card-${s.id}.md`))!;
    const old = readFileSync(join(root, 'vault', cardPath), 'utf8');
    recovered.save('sources', { ...s, status: 'withdrawn', content: '' });
    writeFileSync(join(root, 'vault', cardPath), old);
    recovered.rebuildIndex();
    expect(recovered.searchCards('恢复', s)).toEqual([]);
    recovered.close();
    const tombstones = new Store(join(root, 'tombstones.sqlite'), join(root, 'vault')); stores.push(tombstones);
    expect(tombstones.searchCards('恢复', s)).toEqual([]);
  });

  it('preserves an independently edited Vault file on reopening', () => {
    const { store, root } = setup(); const s = source(); store.save('sources', s); store.save('cards', card(s));
    const cardPath = readdirSync(join(root, 'vault'), { recursive: true }).map(String).find(p => p.endsWith('card-source.md'))!;
    const path = join(root, 'vault', cardPath); const edited = `${readFileSync(path, 'utf8')}\nA newer independent edit.\n`;
    writeFileSync(path, edited); store.close();
    const reopened = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(reopened);
    expect(readFileSync(path, 'utf8')).toBe(edited);
  });
  it('captures independent Vault A to B to A edits as new occurrences while deduplicating rescans',()=>{
    const {store,root}=setup(),s=source();store.save('projects',{id:'one',projectId:'one',domain:'personal',name:'One',description:'',repository:'owner/repo',repositoryProvider:'github',prdPath:'docs/PRD.md',allowedPaths:['docs/PRD.md'],trustedChecks:['validate'],trustedAppIds:[1],ownerId:'owner',autoMerge:false,budgetUsd:1,createdAt:s.createdAt});store.save('sources',s);store.save('cards',card(s));
    const cardPath=readdirSync(join(root,'vault'),{recursive:true}).map(String).find(path=>path.endsWith('card-source.md'))!,path=join(root,'vault',cardPath),original=readFileSync(path,'utf8');
    for(const edit of ['EDIT_A','EDIT_B','EDIT_A']){writeFileSync(path,`${original}\n${edit}\n`);store.rebuildIndex();}
    store.rebuildIndex();const lineage=store.list('sources').filter(source=>source.externalId.startsWith('vault:'));
    expect(lineage).toHaveLength(3);expect(lineage.filter(source=>source.status==='active')).toHaveLength(1);expect(lineage.find(source=>source.status==='active')?.content).toContain('EDIT_A');
  });
});
