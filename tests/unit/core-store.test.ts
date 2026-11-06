import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import fsDefault from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { createBackup, verifyBackup } from '../../src/backup.js';
import { ingestSource, withdrawSource } from '../../src/intake.js';
import type { KnowledgeCard, SourceRevision } from '../../src/domain.js';

vi.mock('node:fs',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs')>();return {...actual,linkSync:vi.fn(actual.linkSync),rmSync:vi.fn(actual.rmSync)};});

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
  it.each((['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_SCHEMA'] as const).flatMap(code => (['new', 'withdraw'] as const).map(operation => [code, operation] as const)))('rolls back a direct %s card %s when FTS fails', (code, operation) => {
    const { store, root } = setup(), s = source(), c = { ...card(s), body: 'DIRECT_CARD_SENTINEL' };
    store.save('sources', s); if (operation === 'withdraw') store.save('cards', c);
    const state = store as unknown as { db: import('better-sqlite3').Database; vaultJobs: Map<string, unknown> };
    const path = join(root, 'vault', 'one', 'personal', 'cards', `${c.id}.md`);
    const beforeRows = state.db.prepare('SELECT data FROM cards WHERE id = ?').all(c.id);
    const beforeFts = state.db.prepare('SELECT * FROM cards_fts WHERE id = ?').all(c.id);
    const beforeVault = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    const spy = vi.spyOn(store, 'indexCard').mockImplementation(value => {
      state.db.prepare('DELETE FROM cards_fts WHERE id = ?').run(value.id);
      throw Object.assign(new Error('injected FTS fault'), { code });
    });
    try {
      const next = operation === 'new' ? c : { ...c, status: 'withdrawn' as const, body: '', quote: '' };
      expect(() => store.save('cards', next)).toThrowError(expect.objectContaining({ code }));
    } finally { spy.mockRestore(); }
    expect(state.db.prepare('SELECT data FROM cards WHERE id = ?').all(c.id)).toEqual(beforeRows);
    expect(state.db.prepare('SELECT * FROM cards_fts WHERE id = ?').all(c.id)).toEqual(beforeFts);
    expect(state.vaultJobs.size).toBe(0);
    store.reconcileVault();
    expect(existsSync(path) ? readFileSync(path, 'utf8') : undefined).toBe(beforeVault);
    store.close(); const reopened = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(reopened);
    expect(reopened.get('cards', c.id)?.status).toBe(operation === 'new' ? undefined : 'active');
    reopened.save('cards', operation === 'new' ? c : { ...c, status: 'withdrawn', body: '', quote: '' });
    expect(reopened.get('cards', c.id)?.status).toBe(operation === 'new' ? 'active' : 'withdrawn');
    expect(readFileSync(path, 'utf8').includes(c.body)).toBe(operation === 'new');
    expect((reopened as unknown as { vaultJobs: Map<string, unknown> }).vaultJobs.size).toBe(0);
  });
  it.each((['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_SCHEMA'] as const).flatMap(code => (['publication', 'withdrawal'] as const).map(operation => [code, operation] as const)))('retains committed Vault %s work for %s and reconciles it', (code, operation) => {
    const { store, root } = setup(), s = source(), c = { ...card(s), body: 'VAULT_WITHDRAWAL_SENTINEL' };
    store.save('sources', s); if (operation === 'withdrawal') store.save('cards', c);
    const path = join(root, 'vault', 'one', 'personal', 'cards', `${c.id}.md`);
    const conflict = path.replace(/\.md$/, '.conflict-synthetic.md');
    if(operation==='withdrawal')writeFileSync(conflict, `old conflict ${c.body}`);
    const state = store as unknown as { db: { inTransaction: boolean }; vaultJobs: Map<string, unknown> };
    const get = store.get.bind(store); let injected = false;
    const spy = vi.spyOn(store, 'get').mockImplementation(((...args: Parameters<typeof get>) => {
      if (!injected && !state.db.inTransaction && args[0] === 'sources' && args[1] === s.id && new Error().stack?.includes('publish')) {
        injected = true; throw Object.assign(new Error('private database fault'), { code });
      }
      return get(...args);
    }) as typeof store.get);
    let failure: unknown;
    try { operation === 'publication' ? store.transaction(() => store.save('cards', c)) : withdrawSource(store, s.id); } catch (error) { failure = error; }
    spy.mockRestore();
    expect(injected).toBe(true); expect(store.get('cards', c.id)?.status).toBe(operation === 'publication' ? 'active' : 'withdrawn');
    expect(state.vaultJobs.size).toBeGreaterThan(0);
    expect(failure).toMatchObject({ code: 'vault_sync_unavailable', status: 503 });
    store.transaction(() => {});
    expect(state.vaultJobs.size).toBe(0); expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8').includes(c.body)).toBe(operation === 'publication');
    if(operation==='withdrawal')expect(readFileSync(conflict,'utf8')).not.toContain(c.body);
  });

  it('retries a failed later Vault job and all remaining jobs without replaying a successful one', () => {
    const { store, root } = setup(), sources = ['a', 'b', 'c'].map(id => source(id));
    for (const s of sources) store.save('sources', s);
    const state = store as unknown as { db: { inTransaction: boolean }; vaultJobs: Map<string, unknown> }, get = store.get.bind(store); let injected = false;
    const spy = vi.spyOn(store, 'get').mockImplementation(((...args: Parameters<typeof get>) => {
      if (!injected && !state.db.inTransaction && args[0] === 'sources' && args[1] === 'b' && new Error().stack?.includes('publish')) { injected = true; throw Object.assign(new Error('private fault'), { code: 'SQLITE_BUSY' }); }
      return get(...args);
    }) as typeof store.get);
    let failure: unknown; try { store.transaction(() => { for (const s of sources) store.save('cards', card(s)); }); } catch (error) { failure = error; } spy.mockRestore();
    const path = (id: string) => join(root, 'vault', 'one', 'personal', 'cards', `card-${id}.md`);
    expect(injected).toBe(true); expect(store.list('cards')).toHaveLength(3); expect(existsSync(path('a'))).toBe(true);
    expect([...state.vaultJobs.keys()]).toEqual(['cards:card-b', 'cards:card-c']); expect(failure).toMatchObject({ code: 'vault_sync_unavailable' });
    store.transaction(() => {}); expect(state.vaultJobs.size).toBe(0); expect(sources.every(s => existsSync(path(s.id)))).toBe(true);
  });

  it('retains committed Vault work on a filesystem failure and retries after repair', () => {
    const { store, root } = setup(), s = source(); store.save('sources', s);
    const parent = join(root, 'vault', 'one', 'personal'), blocked = join(parent, 'cards'); mkdirSync(parent, { recursive: true }); writeFileSync(blocked, 'synthetic obstruction');
    const state = store as unknown as { vaultJobs: Map<string, unknown> }; let failure: unknown;
    try { store.transaction(() => store.save('cards', card(s))); } catch (error) { failure = error; }
    expect(store.get('cards', `card-${s.id}`)).toBeDefined(); expect(state.vaultJobs.size).toBe(1); expect(failure).toMatchObject({ code: 'vault_sync_unavailable', status: 503 });
    rmSync(blocked); store.transaction(() => {}); expect(state.vaultJobs.size).toBe(0); expect(existsSync(join(blocked, `card-${s.id}.md`))).toBe(true);
  });

  it('rechecks current authorization before retrying an older queued projection', () => {
    const { store, root } = setup(), s = { ...source(), content: 'OLD_AUTHORIZATION_SENTINEL' }; store.save('sources', s);
    const state = store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }; vaultJobs: Map<string, unknown>; publish: (job: { table: string }) => void };
    const publish = state.publish.bind(store); let injected = false;
    const spy = vi.spyOn(state, 'publish').mockImplementation(job => { if (!injected) { injected = true; throw new Error('synthetic filesystem failure'); } return publish(job); });
    try { store.save('sources', { ...s, title: 'Queued update' }); } catch {} spy.mockRestore();
    expect(injected).toBe(true); expect(state.vaultJobs.size).toBe(1);
    state.db.prepare('UPDATE sources SET data = ? WHERE id = ?').run(JSON.stringify({ ...s, status: 'withdrawn', title: '[withdrawn]', content: '', locator: `withdrawn:${s.id}` }), s.id);
    store.reconcileVault(); expect(state.vaultJobs.size).toBe(0);
    const path = join(root, 'vault', 'one', 'personal', 'sources', `${s.id}.md`);
    expect(readFileSync(path, 'utf8')).not.toContain('OLD_AUTHORIZATION_SENTINEL');
    const all = readdirSync(join(root, 'vault'), { recursive: true }).map(String).filter(name => name.endsWith('.md')).map(name => readFileSync(join(root, 'vault', name), 'utf8')).join('\n');
    expect(all).not.toContain('OLD_AUTHORIZATION_SENTINEL');
  });

  it('retries at most 32 queued projections per background reconciliation', () => {
    const { store } = setup(), s = source(); store.save('sources', s);
    const state = store as unknown as { vaultJobs: Map<string, unknown>; publish: (job: { table: string }) => void };
    const spy = vi.spyOn(state, 'publish').mockImplementation(() => { throw new Error('synthetic filesystem failure'); });
    try { store.transaction(() => { for (let i = 0; i < 35; i++) store.save('cards', { ...card(s), id: `bounded-${i}` }); }); } catch {} spy.mockRestore();
    expect(state.vaultJobs.size).toBe(35); store.reconcileVault(); expect(state.vaultJobs.size).toBe(3);
    store.reconcileVault(); expect(state.vaultJobs.size).toBe(0);
  });

  it('keeps committed temporary state only in memory after a projection failure and preserves it across rollback', async () => {
    const { store, root } = setup(), permanent = source(), secret = 'EPHEMERAL_POSTCOMMIT_SENTINEL', temporary = { ...source('temporary'), title: secret, content: secret, retention: 'ephemeral' as const };
    store.save('sources', permanent);
    const state = store as unknown as { db: { inTransaction: boolean }; vaultJobs: Map<string, unknown> }, get = store.get.bind(store); let injected = false;
    const spy = vi.spyOn(store, 'get').mockImplementation(((...args: Parameters<typeof get>) => {
      if (!injected && !state.db.inTransaction && args[0] === 'sources' && args[1] === permanent.id && new Error().stack?.includes('publish')) { injected = true; throw Object.assign(new Error('private fault'), { code: 'SQLITE_BUSY' }); }
      return get(...args);
    }) as typeof store.get);
    try { store.transaction(() => { store.save('sources', temporary); store.save('cards', card(permanent)); }); } catch {} spy.mockRestore();
    expect(injected).toBe(true); expect(store.get('sources', temporary.id)?.content).toBe(secret); expect(state.vaultJobs.size).toBe(1);
    expect(() => store.transaction(() => { store.save('sources', { ...temporary, content: 'ROLLBACK_SENTINEL' }); throw new Error('pre-commit abort'); })).toThrow('pre-commit abort');
    expect(store.get('sources', temporary.id)?.content).toBe(secret); expect(state.vaultJobs.size).toBe(1);
    await store.backup(join(root, 'backup.sqlite'));
    for (const path of [join(root, 'db.sqlite'), join(root, 'db.sqlite-wal'), join(root, 'backup.sqlite')]) if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
    const files = readdirSync(join(root, 'vault'), { recursive: true }).map(String).filter(name => name.endsWith('.md'));
    expect(files.every(name => !readFileSync(join(root, 'vault', name), 'utf8').includes(secret))).toBe(true);
    store.reconcileVault(); expect(state.vaultJobs.size).toBe(0);
  });

  it.each(['normal','retry-after-fault'] as const)('does not project a temporary normalization overlay during %s', async mode => {
    const { store, root } = setup(), s = source(); store.save('sources', s);
    const experience = { schemaVersion: 1 as const, problem: 'temporary version', symptomAliases: ['draft'], solution: 'save draft', files: ['docs/PRD.md'], productId: s.projectId, codeVersion: 'unknown', environment: 'unknown', invalidationConditions: ['change'] };
    const original: KnowledgeCard = { ...card(s), kind: 'experience', experience }; store.save('cards', original);
    const normalized = { ...original, experience: { ...experience, codeVersion: 'PRIVATE_TRANSIENT_REVISION_SENTINEL' } };
    store.saveTemporaryNormalizedExperienceCard(normalized);
    const state = store as unknown as { vaultJobs: Map<string, unknown>; publish: (job: { table: string }) => void }, publish = state.publish.bind(store); let injected = false;
    const spy = vi.spyOn(state, 'publish').mockImplementation(job => { if (mode === 'retry-after-fault' && !injected && job.table === 'cards') { injected = true; throw new Error('projection fault'); } return publish(job); });
    try { store.save('cards', { ...normalized, title: 'Updated title' }); } catch (error) { if (mode !== 'retry-after-fault') throw error; } finally { spy.mockRestore(); }
    expect(injected).toBe(mode === 'retry-after-fault'); expect(store.get('cards', original.id)?.title).toBe('Updated title');
    if (mode === 'retry-after-fault') { expect(state.vaultJobs.size).toBe(1); store.reconcileVault(); }
    const path = join(root, 'vault', 'one', 'personal', 'cards', `${original.id}.md`), markdown = readFileSync(path, 'utf8');
    expect(markdown).toContain('Updated title'); expect(markdown).not.toContain('PRIVATE_TRANSIENT_REVISION_SENTINEL');
    await store.backup(join(root,'overlay-backup.sqlite'));
    for(const filename of ['db.sqlite','db.sqlite-wal','overlay-backup.sqlite']){const location=join(root,filename);if(existsSync(location))expect(readFileSync(location).includes(Buffer.from('PRIVATE_TRANSIENT_REVISION_SENTINEL'))).toBe(false);}
    const files=readdirSync(join(root,'vault'),{recursive:true}).map(String).filter(name=>name.endsWith('.md'));
    expect(files.every(name=>!readFileSync(join(root,'vault',name),'utf8').includes('PRIVATE_TRANSIENT_REVISION_SENTINEL'))).toBe(true);
  });

  it('reconciles a committed withdrawal after reopen when its Vault removal failed', () => {
    const { store, root } = setup(), s = source(), c = { ...card(s), body: 'VAULT_REOPEN_SENTINEL' }; store.save('sources', s); store.save('cards', c);
    const path = join(root, 'vault', 'one', 'personal', 'cards', `${c.id}.md`), state = store as unknown as { db: { inTransaction: boolean } }, get = store.get.bind(store); let injected = false;
    const spy = vi.spyOn(store, 'get').mockImplementation(((...args: Parameters<typeof get>) => {
      if (!injected && !state.db.inTransaction && args[0] === 'sources' && args[1] === s.id && new Error().stack?.includes('publish')) { injected = true; throw Object.assign(new Error('private fault'), { code: 'SQLITE_BUSY' }); }
      return get(...args);
    }) as typeof store.get);
    try { withdrawSource(store, s.id); } catch {} spy.mockRestore(); expect(injected).toBe(true); expect(store.get('cards', c.id)?.status).toBe('withdrawn');
    store.close(); const reopened = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(reopened);
    expect(reopened.get('cards', c.id)?.status).toBe('withdrawn'); expect(readFileSync(path, 'utf8')).not.toContain(c.body);
  });

  it('fails before copying an unreconciled Vault while its projection fault remains active',async()=>{
    const {store,root}=setup(),s=source(),c={...card(s),body:'PENDING_PRECOPY_SENTINEL'};store.save('sources',s);store.save('cards',c);
    const state=store as unknown as {db:{inTransaction:boolean}},get=store.get.bind(store),path=join(root,'vault','one','personal','cards',`${c.id}.md`);
    const spy=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
      if(!state.db.inTransaction&&args[0]==='sources'&&args[1]===s.id&&new Error().stack?.includes('publish'))throw Object.assign(new Error('persistent synthetic projection fault'),{code:'SQLITE_BUSY'});
      return get(...args);
    }) as typeof store.get);
    const backup=vi.spyOn(store,'backup'),destination=join(root,'snapshot'),foreign=join(root,'snapshot.partial-foreign');mkdirSync(foreign);writeFileSync(join(foreign,'keep'),'foreign');
    try{
      expect(()=>withdrawSource(store,s.id)).toThrow();const original=readFileSync(path,'utf8');expect(original).toContain(c.body);
      await expect(createBackup(store,destination,{vaultDir:join(root,'vault')})).rejects.toBeDefined();
      expect(backup).not.toHaveBeenCalled();expect(existsSync(destination)).toBe(false);expect(readFileSync(path,'utf8')).toBe(original);
      expect(readdirSync(root).filter(name=>name.startsWith('snapshot.partial-')&&name!=='snapshot.partial-foreign')).toEqual([]);
      expect(readFileSync(join(foreign,'keep'),'utf8')).toBe('foreign');
    }finally{backup.mockRestore();spy.mockRestore();}
  });

  it.each(['complete','backup-fails','source-rebuild-fails','snapshot-rebuild-fails','rename-fails'] as const)('does not leave stale withdrawn Vault text in a %s backup', async mode => {
    const { store, root } = setup(), s = source(), c = { ...card(s), body: 'WITHDRAWN_BACKUP_SENTINEL' }; store.save('sources', s); store.save('cards', c);
    const state = store as unknown as { db: { inTransaction: boolean }; vaultJobs: Map<string, unknown> }, get = store.get.bind(store); let failures = 0;
    const spy = vi.spyOn(store, 'get').mockImplementation(((...args: Parameters<typeof get>) => {
      if (!state.db.inTransaction && args[0] === 'sources' && args[1] === s.id && new Error().stack?.includes('publish')) { failures++; throw Object.assign(new Error('persistent synthetic projection fault'), { code: 'SQLITE_BUSY' }); }
      return get(...args);
    }) as typeof store.get);
    try {
      try { withdrawSource(store, s.id); } catch {}
      expect(failures).toBeGreaterThan(0); expect(state.vaultJobs.size).toBeGreaterThan(0);
      const destination = join(root, 'snapshot');
      const sourcePath=join(root,'vault','one','personal','cards',`${c.id}.md`);expect(readFileSync(sourcePath,'utf8')).toContain(c.body);
      const completed=join(root,'completed-backup'),foreign=join(root,'snapshot.partial-foreign');mkdirSync(completed);mkdirSync(foreign);writeFileSync(join(completed,'keep'),'completed');writeFileSync(join(foreign,'keep'),'foreign');
      spy.mockRestore();store.reconcileVault();const original=readFileSync(sourcePath,'utf8');expect(original).not.toContain(c.body);
      let reached='';
      const backupOnly = {
        prepareVaultBackup:store.prepareVaultBackup.bind(store),
        ...(mode==='source-rebuild-fails'?{rebuildIndex(){reached='source-rebuild';throw new Error('synthetic source rebuild failure');}}:{}),
        async backup(path:string){
          reached='backup';
          if(mode==='backup-fails')throw new Error('synthetic backup failure');
          if(mode==='snapshot-rebuild-fails'){writeFileSync(path,'not a database');return;}
          if(mode==='rename-fails'){mkdirSync(destination);writeFileSync(join(destination,'keep'),'concurrent destination');}
          await store.backup(path);
        },
      } as unknown as Store;
      if (mode !== 'complete') {
        await expect(createBackup(backupOnly, destination, { vaultDir: join(root, 'vault') })).rejects.toBeDefined();
        const partials=readdirSync(root).filter(name=>name.startsWith('snapshot.partial-')&&name!=='snapshot.partial-foreign');
        for(const partial of partials){const vault=join(root,partial,'vault');if(existsSync(vault)){const files=readdirSync(vault,{recursive:true}).map(String).filter(name=>name.endsWith('.md'));expect(files.every(name=>!readFileSync(join(vault,name),'utf8').includes(c.body))).toBe(true);}}
        expect(partials).toEqual([]);
        if(mode==='rename-fails')expect(readFileSync(join(destination,'keep'),'utf8')).toBe('concurrent destination');
      } else {
        await createBackup(backupOnly, destination, { vaultDir: join(root, 'vault') });
        const vault = join(destination, 'vault'); const files = readdirSync(vault, { recursive: true }).map(String).filter(name => name.endsWith('.md'));
        expect(files.every(name => !readFileSync(join(vault, name), 'utf8').includes(c.body))).toBe(true);
      }
      expect(reached).toBe(mode==='source-rebuild-fails'?'source-rebuild':'backup');
      expect(readFileSync(sourcePath,'utf8')).toBe(original);expect(readFileSync(join(completed,'keep'),'utf8')).toBe('completed');expect(readFileSync(join(foreign,'keep'),'utf8')).toBe('foreign');
    } finally { spy.mockRestore(); }
  });

  it.each(['empty','nonempty'] as const)('does not replace a concurrently created %s backup destination',async kind=>{
    const {store,root}=setup(),destination=join(root,'snapshot');let identity:{dev:number;ino:number;mode:number}|undefined;
    const backupOnly={async backup(path:string){
      mkdirSync(destination,{mode:0o751});if(kind==='nonempty')writeFileSync(join(destination,'foreign'),'untouched');
      const stat=statSync(destination);identity={dev:stat.dev,ino:stat.ino,mode:stat.mode};await store.backup(path);
    }} as unknown as Store;
    await expect(createBackup(backupOnly,destination)).rejects.toBeDefined();
    const stat=statSync(destination);expect({dev:stat.dev,ino:stat.ino,mode:stat.mode}).toEqual(identity);
    expect(readdirSync(destination)).toEqual(kind==='empty'?[]:['foreign']);
    if(kind==='nonempty')expect(readFileSync(join(destination,'foreign'),'utf8')).toBe('untouched');
    expect(readdirSync(root).filter(name=>name.startsWith('snapshot.partial-'))).toEqual([]);
  });

  it.each(['replaced','populated'] as const)('does not clean up a %s backup reservation after publication fails',async mode=>{
    const {store,root}=setup(),destination=join(root,'snapshot'),displaced=join(root,'displaced');let injected=false;
    const link=vi.mocked(nodeFs.linkSync).mockImplementationOnce(()=>{
      injected=true;if(mode==='replaced'){nodeFs.renameSync(destination,displaced);mkdirSync(destination);}writeFileSync(join(destination,'foreign'),'keep');
      throw new Error('injected publication failure');
    });
    try{
      await expect(createBackup(store,destination)).rejects.toThrow('injected publication failure');
      expect(injected).toBe(true);expect(readFileSync(join(destination,'foreign'),'utf8')).toBe('keep');
      expect(existsSync(displaced)).toBe(mode==='replaced');expect(readdirSync(root).filter(name=>name.startsWith('snapshot.partial-'))).toEqual([]);
    }finally{link.mockReset();link.mockImplementation(fsDefault.linkSync);}
  });

  it('reports both the backup failure and the staging cleanup failure',async()=>{
    const {store,root}=setup(),destination=join(root,'snapshot');
    const primary=new Error('publication fault'),cleanup=new Error('cleanup fault');
    const link=vi.mocked(nodeFs.linkSync).mockImplementationOnce(()=>{throw primary;});
    const remove=vi.mocked(nodeFs.rmSync).mockImplementationOnce(()=>{throw cleanup;});
    try{
      const failure=await createBackup(store,destination).then(()=>undefined,error=>error);
      expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toEqual([primary,cleanup]);expect(failure.cause).toBe(primary);
      expect(existsSync(join(destination,'manifest.json'))).toBe(false);
    }finally{link.mockReset();link.mockImplementation(fsDefault.linkSync);remove.mockReset();remove.mockImplementation(fsDefault.rmSync);}
  });

  it('refuses to overwrite a file that appears inside a reserved backup destination',async()=>{
    const {store,root}=setup(),destination=join(root,'snapshot');let foreign='';
    const link=vi.mocked(nodeFs.linkSync).mockImplementationOnce((source,target)=>{
      foreign=String(target);writeFileSync(foreign,'concurrent content');return fsDefault.linkSync(source,target);
    });
    try{
      await expect(createBackup(store,destination)).rejects.toMatchObject({code:'EEXIST'});
      expect(readFileSync(foreign,'utf8')).toBe('concurrent content');
      expect(existsSync(join(destination,'manifest.json'))).toBe(false);
      expect(readdirSync(root).filter(name=>name.startsWith('snapshot.partial-'))).toEqual([]);
    }finally{link.mockReset();link.mockImplementation(fsDefault.linkSync);}
  });

  it('rejects an installed backup containing an unrelated concurrent child',async()=>{
    const {store,root}=setup(),destination=join(root,'snapshot');let injected=false;
    const link=vi.mocked(nodeFs.linkSync).mockImplementationOnce((source,target)=>{
      injected=true;writeFileSync(join(destination,'foreign.txt'),'foreign content');
      return fsDefault.linkSync(source,target);
    });
    try{
      await expect(createBackup(store,destination)).rejects.toMatchObject({code:'invalid_backup'});
      expect(injected).toBe(true);
      expect(readFileSync(join(destination,'foreign.txt'),'utf8')).toBe('foreign content');
      expect(existsSync(join(destination,'manifest.json'))).toBe(true);
      expect(()=>verifyBackup(destination)).toThrowError(expect.objectContaining({code:'invalid_backup'}));
      expect(readdirSync(root).filter(name=>name.startsWith('snapshot.partial-'))).toEqual([]);
    }finally{link.mockReset();link.mockImplementation(fsDefault.linkSync);}
  });

  it('leaves only rebuilt withdrawn Vault data in an incomplete destination after an install fault',async()=>{
    const {store,root}=setup(),s=source(),c={...card(s),body:'RETAINED_BACKUP_WITHDRAWN_SENTINEL'};
    store.save('sources',s);store.save('cards',c);
    const state=store as unknown as {db:{inTransaction:boolean}},get=store.get.bind(store);
    const projection=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
      if(!state.db.inTransaction&&args[0]==='sources'&&args[1]===s.id&&new Error().stack?.includes('publish'))throw new Error('stale source Vault');
      return get(...args);
    }) as typeof store.get);
    try{try{withdrawSource(store,s.id);}catch{}expect(readFileSync(join(root,'vault','one','personal','cards',`${c.id}.md`),'utf8')).toContain(c.body);}
    finally{projection.mockRestore();}
    store.reconcileVault();
    const destination=join(root,'snapshot'),backupOnly={prepareVaultBackup:store.prepareVaultBackup.bind(store),async backup(path:string){await store.backup(path);}} as unknown as Store;let markdowns=0;
    const link=vi.mocked(nodeFs.linkSync).mockImplementation((from,to)=>{
      if(String(from).endsWith('.md')&&++markdowns===2)throw new Error('injected install failure');
      return fsDefault.linkSync(from,to);
    });
    try{
      await expect(createBackup(backupOnly,destination,{vaultDir:join(root,'vault')})).rejects.toThrow('injected install failure');
      const paths=readdirSync(destination,{recursive:true}).map(String).filter(path=>path.endsWith('.md'));
      expect(paths.length).toBeGreaterThan(0);expect(paths.every(path=>!readFileSync(join(destination,path),'utf8').includes(c.body))).toBe(true);
      expect(existsSync(join(destination,'manifest.json'))).toBe(false);
      expect(readdirSync(root).filter(name=>name.startsWith('snapshot.partial-'))).toEqual([]);
    }finally{link.mockReset();link.mockImplementation(fsDefault.linkSync);}
  });

  it.each(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_SCHEMA'] as const)('propagates %s during edited Vault recovery and preserves the edit for a fresh constructor', code => {
    const { store, root } = setup(), s = source();
    store.save('projects', { id: 'one', projectId: 'one', domain: 'personal', name: 'One', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [1], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: s.createdAt });
    store.save('sources', s); store.save('cards', card(s));
    const path = join(root, 'vault', 'one', 'personal', 'cards', 'card-source.md'), edited = `${readFileSync(path, 'utf8')}\nAUTHORIZED_EDIT_FOR_RECOVERY\n`;
    writeFileSync(path, edited); store.close();
    const original = Store.prototype.get; let injected = false, unexpectedlyOpened: Store | undefined; let failure: unknown;
    const spy = vi.spyOn(Store.prototype, 'get').mockImplementation(function (this: Store, ...args: Parameters<typeof original>) {
      if (!injected && new Error().stack?.includes('ingestSource')) { injected = true; throw Object.assign(new Error('private startup fault'), { code }); }
      return original.apply(this, args);
    } as typeof original);
    try { unexpectedlyOpened = new Store(join(root, 'db.sqlite'), join(root, 'vault')); } catch (error) { failure = error; } finally { spy.mockRestore(); unexpectedlyOpened?.close(); }
    expect(injected).toBe(true); expect(failure).toMatchObject({ code }); expect(readFileSync(path, 'utf8')).toBe(edited);
    const reopened = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(reopened);
    expect(readFileSync(path, 'utf8')).toBe(edited);
    expect(reopened.list('sources').some(value => value.externalId.startsWith('vault:') && value.content.includes('AUTHORIZED_EDIT_FOR_RECOVERY'))).toBe(true);
  });

  it('preserves a conflicting edited file when ordinary recovery validation fails', () => {
    const { store, root } = setup(), s = source();
    store.save('projects', { id: 'one', projectId: 'one', domain: 'personal', name: 'One', description: '', repository: 'owner/repo', repositoryProvider: 'github', prdPath: 'docs/PRD.md', allowedPaths: ['docs/PRD.md'], trustedChecks: ['validate'], trustedAppIds: [1], ownerId: 'owner', autoMerge: false, budgetUsd: 1, createdAt: s.createdAt });
    store.save('sources', s); store.save('cards', card(s));
    const path = join(root, 'vault', 'one', 'personal', 'cards', 'card-source.md'), edited = `${readFileSync(path, 'utf8')}\nCONFLICTING_EDIT\n`; writeFileSync(path, edited); store.close();
    const original = Store.prototype.get; let rejected = false;
    const spy = vi.spyOn(Store.prototype, 'get').mockImplementation(function (this: Store, ...args: Parameters<typeof original>) {
      if (new Error().stack?.includes('ingestSource')) { rejected = true; throw new Error('ordinary conflicting edit'); }
      return original.apply(this, args);
    } as typeof original);
    let reopened: Store;
    try { reopened = new Store(join(root, 'db.sqlite'), join(root, 'vault')); stores.push(reopened); } finally { spy.mockRestore(); }
    expect(rejected).toBe(true); expect(readFileSync(path, 'utf8')).toBe(edited);
    expect(reopened.list('sources').some(value => value.externalId.startsWith('vault:'))).toBe(false);
    reopened.rebuildIndex(); expect(reopened.list('sources').some(value => value.content.includes('CONFLICTING_EDIT'))).toBe(true);
  });
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

  it('rolls back a temporary ancestor transition and preserves the independent durable projections', () => {
    const { store, root } = setup(), parent=source('rollback-parent'),child={...source('rollback-child'),parentSources:[{id:parent.id,revision:parent.revision}]};
    store.save('sources',parent);store.save('sources',child);
    const path=join(root,'vault','one','personal','sources',`${child.id}.md`),before=readFileSync(path,'utf8');
    expect(()=>store.transaction(()=>{store.save('sources',{...parent,retention:'ephemeral'});throw new Error('abort policy change');})).toThrow('abort policy change');
    expect(store.get('sources',parent.id)).toEqual(parent);expect(store.get('sources',child.id)).toEqual(child);expect(readFileSync(path,'utf8')).toBe(before);
    store.close();const reopened=new Store(join(root,'db.sqlite'),join(root,'vault'));stores.push(reopened);
    expect(reopened.get('sources',child.id)?.content).toBe(child.content);
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
