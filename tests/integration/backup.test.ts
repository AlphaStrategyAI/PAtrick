import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../../src/store.js';
import { createBackup, verifyBackup } from '../../src/backup.js';
import { now, stableId } from '../../src/domain.js';
import { ingestSource, withdrawSource } from '../../src/intake.js';
import { publishKnowledge } from '../../src/knowledge.js';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));
it('creates an online snapshot with withdrawal tombstones and no credentials',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-backup-'));dirs.push(dir);const store=new Store(join(dir,'patrick.db'),join(dir,'vault'));
  store.save('sources',{id:'s',projectId:'p',domain:'personal',kind:'manual',externalId:'e',revision:'v1',title:'Retracted',content:'',locator:'note',authorId:'owner',retention:'permanent',status:'withdrawn',createdAt:now()});
  await createBackup(store,join(dir,'snapshot'));
  const manifest=verifyBackup(join(dir,'snapshot'));expect(manifest.files.some(file=>file.path==='patrick.db')).toBe(true);expect(manifest.files.some(file=>file.path.includes('token'))).toBe(false);
  const restored=new Store(join(dir,'snapshot','patrick.db'),join(dir,'restored-vault'));
  expect(restored.get('sources','s')?.status).toBe('withdrawn');expect(restored.searchCards('草稿',{projectId:'p',domain:'personal'})).toEqual([]);
  restored.close();store.close();
});
it('finds the same active card after opening an online backup, while Vault recovery stays separate from database projection',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-backup-search-'));dirs.push(dir);
  const db=join(dir,'patrick.db'),vault=join(dir,'vault'),scope={projectId:'p',domain:'personal'};
  const store=new Store(db,vault);
  const project={id:'p',projectId:'p',domain:'personal',name:'Project',description:'',repository:'owner/repo',repositoryProvider:'github' as const,prdPath:'docs/PRD.md',allowedPaths:['docs/PRD.md'],trustedChecks:['validate'],trustedAppIds:[1],ownerId:'owner',autoMerge:false,budgetUsd:1,createdAt:now()};
  store.save('projects',project);
  const content='导出失败后应恢复草稿。';
  const task=ingestSource(store,{projects:[]},{projectId:'p',kind:'manual',externalId:'idea',revision:'v1',title:'草稿恢复',content,authorId:'owner',locator:'productIdeas/草稿.md'})!;
  const source=store.get('sources',task.sourceId)!;
  const card=publishKnowledge(store,source,{cards:[{title:'草稿恢复',body:'保留草稿以供恢复',quote:'应恢复草稿',aliases:['draft'],verification:'reported',kind:'fact'}]})[0]!;
  const projected=join(vault,'p','personal','cards',`${card.id}.md`);
  const projectedText=readFileSync(projected,'utf8');
  expect(projectedText).toContain('应恢复草稿');
  const destination=join(dir,'snapshot');
  await createBackup(store,destination,{mode:'test'});
  store.close();
  const opened=new Store(join(destination,'patrick.db'),join(destination,'vault'));
  expect(opened.searchCards('恢复',scope).map(item=>item.id)).toEqual([card.id]);
  expect(opened.searchCards('draft',scope).map(item=>item.id)).toEqual([card.id]);
  opened.close();
  const recovered=new Store(join(dir,'recovered.sqlite'),join(destination,'vault'));
  expect(recovered.searchCards('恢复',scope).map(item=>item.id)).toEqual([card.id]);
  const recoveredSource=recovered.get('sources',source.id)!;
  withdrawSource(recovered,recoveredSource.id);
  writeFileSync(join(destination,'vault','p','personal','cards',`${card.id}.md`),projectedText);
  recovered.rebuildIndex();
  expect(recovered.searchCards('恢复',scope)).toEqual([]);
  expect(recovered.searchCards('draft',scope)).toEqual([]);
  recovered.close();
});
it('preserves independent Vault edits and conflict versions in a verified snapshot',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-vault-backup-'));dirs.push(dir);const store=new Store(join(dir,'patrick.db'),join(dir,'vault'));
  store.save('sources',{id:'s',projectId:'p',domain:'personal',kind:'manual',externalId:'e',revision:'v1',title:'Idea',content:'Original authorized note',locator:'note',authorId:'owner',retention:'permanent',status:'active',createdAt:now()});
  const path=join(dir,'vault','p','personal','sources','s.md');appendFileSync(path,'\nINDEPENDENT_VAULT_EDIT\n');
  await createBackup(store,join(dir,'snapshot'));
  const snapshot=join(dir,'snapshot','vault','p','personal','sources');const text=readdirSync(snapshot).map(name=>readFileSync(join(snapshot,name),'utf8')).join('\n');expect(text).toContain('INDEPENDENT_VAULT_EDIT');verifyBackup(join(dir,'snapshot'));store.close();
});

it('backs up a populated clean upgraded Vault with ledger-backed edits and conflict versions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-upgraded-vault-'));dirs.push(dir);
  const db=join(dir,'patrick.db'),vault=join(dir,'vault'),destination=join(dir,'snapshot');let store=new Store(db,vault);
  try{
    store.save('projects',{id:'p',projectId:'p',domain:'personal',name:'Project',description:'',repository:'owner/repo',repositoryProvider:'github',prdPath:'docs/PRD.md',allowedPaths:['docs/PRD.md'],trustedChecks:['validate'],trustedAppIds:[1],ownerId:'owner',autoMerge:false,budgetUsd:1,createdAt:now()});
    const source={id:'host-source',projectId:'p',domain:'personal',kind:'manual' as const,externalId:'source',revision:'v1',title:'Source',content:'Authorized source',locator:'source',authorId:'owner',retention:'permanent' as const,status:'active' as const,createdAt:now()};
    store.save('sources',source);
    store.save('cards',{id:'host-card',projectId:'p',domain:'personal',sourceId:source.id,sourceRevision:source.revision,title:'Card',body:'Card body',quote:source.content,locator:source.locator,kind:'knowledge',verification:'reported',status:'active',aliases:[],createdAt:now()});
    const path=join(vault,'p','personal','cards','host-card.md');appendFileSync(path,'\nINDEPENDENT_UPGRADE_EDIT\n');
    store.rebuildIndex();
    expect(store.list('sources').some(row=>row.kind==='file'&&row.content.includes('INDEPENDENT_UPGRADE_EDIT'))).toBe(true);
    const edited=readFileSync(path,'utf8'),conflict=path.replace(/\.md$/,'.conflict-saved.md');writeFileSync(conflict,edited);
    store.close();
    const legacy=new Database(db);legacy.exec("DROP TABLE vault_projection_origins; DROP TABLE vault_origins; DELETE FROM vault_state");legacy.close();
    store=new Store(db,vault);await createBackup(store,destination,{mode:'test'});
    expect(readFileSync(path,'utf8')).toBe(edited);expect(readFileSync(conflict,'utf8')).toBe(edited);
    expect(readFileSync(join(destination,'vault','p','personal','cards','host-card.md'),'utf8')).toBe(edited);
    expect(readFileSync(join(destination,'vault','p','personal','cards','host-card.conflict-saved.md'),'utf8')).toBe(edited);
  }finally{store.close();}
});

it('refuses to copy an unattached Vault while committed redaction intents await that Vault',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-unattached-vault-'));dirs.push(dir);
  const db=join(dir,'patrick.db'),vault=join(dir,'vault'),destination=join(dir,'snapshot');let store=new Store(db,vault);
  try{
    const source={id:'host-source',projectId:'p',domain:'personal',kind:'manual' as const,externalId:'source',revision:'v1',title:'Source',content:'Source',locator:'source',authorId:'owner',retention:'permanent' as const,status:'active' as const,createdAt:now()};
    store.save('sources',source);
    store.save('cards',{id:'host-card',projectId:'p',domain:'personal',sourceId:source.id,sourceRevision:source.revision,title:'UNATTACHED_VAULT_PRIVATE_SENTINEL',body:'Private',quote:source.content,locator:source.locator,kind:'knowledge',verification:'reported',status:'active',aliases:[],createdAt:now()});
    const cardPath=join(vault,'p','personal','cards','host-card.md'),oldProjection=readFileSync(cardPath,'utf8');expect(oldProjection).toContain('UNATTACHED_VAULT_PRIVATE_SENTINEL');
    store.close();store=new Store(db);store.save('sources',{...source,retention:'ephemeral'});
    await expect(createBackup(store,destination,{mode:'test',vaultDir:vault})).rejects.toThrowError(expect.objectContaining({code:'vault_cleanup_unavailable'}));
    expect(readFileSync(cardPath,'utf8')).toContain('UNATTACHED_VAULT_PRIVATE_SENTINEL');
    store.close();store=new Store(db,vault);expect(readFileSync(cardPath,'utf8')).not.toContain('UNATTACHED_VAULT_PRIVATE_SENTINEL');
    await createBackup(store,destination,{mode:'test',vaultDir:vault});
    expect(readFileSync(join(destination,'vault','p','personal','cards','host-card.md'),'utf8')).not.toContain('UNATTACHED_VAULT_PRIVATE_SENTINEL');
    // A legacy last-origin value cannot certify a projection whose old obligation was lost.
    store.close();writeFileSync(cardPath,oldProjection);
    const legacy=new Database(db);legacy.exec("DROP TABLE vault_projection_origins; DROP TABLE vault_origins; DELETE FROM vault_state WHERE key IN ('redaction_history','origin_history_incomplete')");legacy.close();
    store=new Store(db,vault);
    expect(readFileSync(cardPath,'utf8')).toContain('UNATTACHED_VAULT_PRIVATE_SENTINEL');
    const legacyDestination=join(dir,'legacy-unverified-backup');
    await expect(createBackup(store,legacyDestination,{mode:'test',vaultDir:vault})).rejects.toThrowError(expect.objectContaining({code:'vault_cleanup_unavailable'}));
    expect(existsSync(legacyDestination)).toBe(false);
  }finally{store.close();}
});

it('retains legacy unbound redactions instead of inferring their Vault',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-legacy-vault-intent-'));dirs.push(dir);
  const db=join(dir,'patrick.db'),vault=join(dir,'vault'),other=join(dir,'other');let store=new Store(db,vault);
  const intent={version:1,table:'cards',id:'legacy-card'},cursor={id:`vault-redaction:${stableId('vault-redaction','p','personal',intent.table,intent.id)}`,projectId:'p',domain:'personal',value:JSON.stringify(intent),updatedAt:''};
  try{
    store.save('cursors',cursor);store.close();store=new Store(db,other);
    expect(store.get('cursors',cursor.id)).toEqual(cursor);
    await expect(createBackup(store,join(dir,'other-backup'),{vaultDir:vault})).rejects.toThrowError(expect.objectContaining({code:'vault_cleanup_unavailable'}));
    store.close();store=new Store(db,vault);
    expect(store.get('cursors',cursor.id)).toEqual(cursor);
    await expect(createBackup(store,join(dir,'original-backup'),{vaultDir:vault})).rejects.toThrowError(expect.objectContaining({code:'vault_cleanup_unavailable'}));
  }finally{store.close();}
});

it('runs the real read-only backup CLI for a live clean Vault and rejects an unbound redaction',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-cli-backup-'));dirs.push(dir);
  const db=join(dir,'patrick.db'),vault=join(dir,'vault'),destination=join(dir,'snapshot');
  const store=new Store(db,vault);
  try{
    store.save('sources',{id:'s',projectId:'p',domain:'personal',kind:'manual',externalId:'e',revision:'v1',title:'CLI source',content:'Authorized',locator:'note',authorId:'owner',retention:'permanent',status:'active',createdAt:now()});
    const path=join(vault,'p','personal','sources','s.md'),before=readFileSync(path,'utf8');
    const run=(target:string)=>spawnSync(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),fileURLToPath(new URL('../../scripts/backup.ts',import.meta.url)),target],{
      cwd:dir,env:{PATH:process.env.PATH,PATRICK_MODE:'test',PATRICK_DATA_DIR:dir,PATRICK_VAULT_DIR:vault},encoding:'utf8'
    });
    const clean=run(destination);
    expect(clean.status,clean.stderr).toBe(0);expect(clean.stdout).toContain('Verified snapshot:');
    verifyBackup(destination);expect(readFileSync(join(destination,'vault','p','personal','sources','s.md'),'utf8')).toBe(before);
    expect(readFileSync(path,'utf8')).toBe(before);expect(store.get('sources','s')?.title).toBe('CLI source');
    const ledger=new Database(db,{readonly:true});
    const origin=(ledger.prepare('SELECT origin FROM vault_origins WHERE verified=1').get() as {origin:string}).origin;ledger.close();
    const intent={version:2,origin,table:'cards',id:'legacy-card'},cursor={id:`vault-redaction:${stableId('vault-redaction','p','personal',intent.table,intent.id)}`,projectId:'p',domain:'personal',value:JSON.stringify(intent),updatedAt:''};
    store.save('cursors',cursor);
    const rejected=join(dir,'rejected'),dirty=run(rejected);
    expect(dirty.status).not.toBe(0);expect(dirty.stderr).toContain('vault_cleanup_unavailable');
    expect(existsSync(rejected)).toBe(false);expect(readdirSync(dir).some(name=>name.startsWith('rejected.partial-'))).toBe(false);
    expect(readFileSync(path,'utf8')).toBe(before);expect(store.get('cursors',cursor.id)).toEqual(cursor);
    store.save('cursors',{...cursor,value:JSON.stringify({version:1,table:intent.table,id:intent.id})});
    const unbound=join(dir,'unbound'),legacy=run(unbound);
    expect(legacy.status).not.toBe(0);expect(legacy.stderr).toContain('vault_cleanup_unavailable');expect(existsSync(unbound)).toBe(false);
    expect(readdirSync(dir).some(name=>name.startsWith('unbound.partial-'))).toBe(false);
  }finally{store.close();}
});
