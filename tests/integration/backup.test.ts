import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { createBackup, verifyBackup } from '../../src/backup.js';
import { now } from '../../src/domain.js';
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
it('preserves independent Vault edits and conflict versions in a verified snapshot',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-vault-backup-'));dirs.push(dir);const store=new Store(join(dir,'patrick.db'),join(dir,'vault'));
  store.save('sources',{id:'s',projectId:'p',domain:'personal',kind:'manual',externalId:'e',revision:'v1',title:'Idea',content:'Original authorized note',locator:'note',authorId:'owner',retention:'permanent',status:'active',createdAt:now()});
  const path=join(dir,'vault','p','personal','sources','s.md');appendFileSync(path,'\nINDEPENDENT_VAULT_EDIT\n');
  await createBackup(store,join(dir,'snapshot'));
  const snapshot=join(dir,'snapshot','vault','p','personal','sources');const text=readdirSync(snapshot).map(name=>readFileSync(join(snapshot,name),'utf8')).join('\n');expect(text).toContain('INDEPENDENT_VAULT_EDIT');verifyBackup(join(dir,'snapshot'));store.close();
});

it('refuses to copy an unattached Vault while committed redaction intents await that Vault',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-unattached-vault-'));dirs.push(dir);
  const db=join(dir,'patrick.db'),vault=join(dir,'vault'),destination=join(dir,'snapshot');let store=new Store(db,vault);
  try{
    const source={id:'host-source',projectId:'p',domain:'personal',kind:'manual' as const,externalId:'source',revision:'v1',title:'Source',content:'Source',locator:'source',authorId:'owner',retention:'permanent' as const,status:'active' as const,createdAt:now()};
    store.save('sources',source);
    store.save('cards',{id:'host-card',projectId:'p',domain:'personal',sourceId:source.id,sourceRevision:source.revision,title:'UNATTACHED_VAULT_PRIVATE_SENTINEL',body:'Private',quote:source.content,locator:source.locator,kind:'knowledge',verification:'reported',status:'active',aliases:[],createdAt:now()});
    const cardPath=join(vault,'p','personal','cards','host-card.md');expect(readFileSync(cardPath,'utf8')).toContain('UNATTACHED_VAULT_PRIVATE_SENTINEL');
    store.close();store=new Store(db);store.save('sources',{...source,retention:'ephemeral'});
    await expect(createBackup(store,destination,{mode:'test',vaultDir:vault})).rejects.toThrowError(expect.objectContaining({code:'vault_cleanup_unavailable'}));
    expect(readFileSync(cardPath,'utf8')).toContain('UNATTACHED_VAULT_PRIVATE_SENTINEL');
    store.close();store=new Store(db,vault);expect(readFileSync(cardPath,'utf8')).not.toContain('UNATTACHED_VAULT_PRIVATE_SENTINEL');
    await createBackup(store,destination,{mode:'test',vaultDir:vault});
    expect(readFileSync(join(destination,'vault','p','personal','cards','host-card.md'),'utf8')).not.toContain('UNATTACHED_VAULT_PRIVATE_SENTINEL');
  }finally{store.close();}
});
