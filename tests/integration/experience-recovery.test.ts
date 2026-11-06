import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ingestSource, invalidateSource, withdrawSource } from '../../src/intake.js';
import { ingestStructuredExperience } from '../../src/integrations/experience-ci.js';
import { createBackup } from '../../src/backup.js';
import { knowledgeReference } from '../../src/knowledge-use.js';
import { knowledgeSourceRefs } from '../../src/knowledge-records.js';
import { ingestStructuredKnowledge, publishKnowledge } from '../../src/knowledge.js';
import { prepareFactualContext } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';
import { recordDecisionSnapshot, recordOwnerDecision } from '../../src/standards.js';
import { digest, stableId, type DecisionSnapshot, type KnowledgeCard, type Project, type Task, type WorkerInput } from '../../src/domain.js';
import { repositoryKnowledgeFixture, H, reportPath } from '../fixtures/repository-knowledge.js';

const project: Project = {id:'p',projectId:'p',domain:'personal',name:'P',description:'',repository:'owner/repo',repositoryProvider:'gitlab',prdPath:'docs/PRD.md',allowedPaths:['docs/'],trustedChecks:['validate'],trustedAppIds:[731],ownerId:'owner',autoMerge:false,budgetUsd:0,createdAt:''};

it.each(['wrong','exact'] as const)('keeps %s parent identity across opaque restart and reingestion',async identity=>{
  const root=mkdtempSync(join(tmpdir(),'g8-opaque-parent-')),db=join(root,'db.sqlite');let store=new Store(db);
  try{
    const parentInput={projectId:'p',externalId:'opaque-parent',revision:'parent-v1',title:'Parent',content:'Parent',purpose:'reference' as const,retention:identity==='exact'?'ephemeral' as const:'permanent' as const};
    ingestSource(store,{projects:[project]},parentInput);
    const parent=store.list('sources').find(value=>value.externalId==='opaque-parent')!;
    const originalRevision=identity==='exact'?parent.revision:store.auditTemporaryRevision(parent.revision);
    const input={projectId:'p',externalId:`opaque-${identity}`,revision:'child-v1',title:'Child',content:`OPAQUE_${identity.toUpperCase()}_PRIVATE_SENTINEL`,purpose:'reference' as const};
    ingestSource(store,{projects:[project]},input,[{id:parent.id,revision:originalRevision}]);
    const child=store.list('sources').find(value=>value.externalId===input.externalId)!;
    expect(!!knowledgeSourceRefs(store,child.id,project)).toBe(identity==='exact');
    store.close();store=new Store(db);
    if(identity==='exact')ingestSource(store,{projects:[project]},parentInput);
    ingestSource(store,{projects:[project]},input);
    const restored=store.get('sources',child.id)!;
    expect(!!knowledgeSourceRefs(store,child.id,project)).toBe(identity==='exact');
    if(identity==='wrong')expect(restored.parentSources?.[0]?.revision).not.toBe(parent.revision);
    else expect(restored.parentSources?.[0]?.revision).toBe(parent.revision);
    store.save('sources',restored);await store.backup(join(root,'backup.sqlite'));store.close();
    if(identity==='wrong')for(const path of [db,join(root,'backup.sqlite')])expect(readFileSync(path).includes(Buffer.from(input.content))).toBe(false);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('keeps literal hash-shaped external identifiers independent of their preimages',()=>{
  const store=new Store(':memory:');
  try{
    const raw='literal-external-id',hashed=store.auditTemporaryRevision(raw);
    for(const externalId of [hashed,raw])ingestSource(store,{projects:[project]},{projectId:'p',externalId,revision:'v1',title:'Source',content:'Source',purpose:'reference'});
    const sources=store.list('sources').filter(value=>[raw,hashed].includes(value.externalId));
    expect(sources).toHaveLength(2);expect(sources.every(value=>value.status==='active')).toBe(true);
  }finally{store.close();}
});

it('keeps a dormant opaque external identifier independent of a new literal digest identifier',()=>{
  const root=mkdtempSync(join(tmpdir(),'g8-opaque-external-')),db=join(root,'db.sqlite');let store=new Store(db);
  try{
    const input={projectId:'p',externalId:'dormant-external',revision:'v1',title:'Source',content:'Content',retention:'ephemeral' as const,purpose:'reference' as const};
    const literal=store.auditTemporaryRevision(input.externalId);ingestSource(store,{projects:[project]},input);
    const first=store.list('sources').find(source=>source.externalId===input.externalId)!;store.close();store=new Store(db);
    ingestSource(store,{projects:[project]},{...input,externalId:literal});
    const second=store.list('sources').find(source=>source.externalId===literal&&source.content==='Content')!;
    expect(second.id).not.toBe(first.id);expect(store.get('sources',first.id)?.status).toBe('active');
    ingestSource(store,{projects:[project]},input);expect(store.get('sources',first.id)?.content).toBe('Content');expect(store.get('sources',second.id)?.status).toBe('active');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['authorId','locator'] as const)('rejects hash-shaped %s aliases while preserving exact opaque reauthorization',field=>{
  const root=mkdtempSync(join(tmpdir(),'g8-opaque-metadata-')),db=join(root,'db.sqlite');let store=new Store(db);
  try{
    const input={projectId:'p',externalId:'metadata-source',revision:'v1',title:'Source',content:'Metadata source',authorId:'author-literal',locator:'locator-literal',retention:'ephemeral' as const,purpose:'reference' as const};
    ingestSource(store,{projects:[project]},input);const source=store.list('sources').find(value=>value.externalId===input.externalId)!;
    const alias=store.auditTemporaryRevision(input[field]);store.close();store=new Store(db);
    expect(()=>ingestSource(store,{projects:[project]},{...input,[field]:alias})).toThrowError(expect.objectContaining({code:'revision_conflict'}));
    ingestSource(store,{projects:[project]},input);
    expect(store.get('sources',source.id)).toMatchObject({authorId:input.authorId,locator:input.locator,content:input.content});
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['authorId','locator'] as const)('rejects changing active source %s to its hash-shaped alias',field=>{
  const store=new Store(':memory:');
  try{
    const input={projectId:'p',externalId:'active-metadata',revision:'v1',title:'Source',content:'Content',authorId:'active-author',locator:'active-locator',purpose:'reference' as const};
    ingestSource(store,{projects:[project]},input);
    expect(()=>ingestSource(store,{projects:[project]},{...input,[field]:store.auditTemporaryRevision(input[field])})).toThrowError(expect.objectContaining({code:'revision_conflict'}));
    expect(()=>ingestSource(store,{projects:[project]},input)).not.toThrow();
  }finally{store.close();}
});

it.each(['authorId','locator'] as const)('does not substitute a preimage for a literal hash-shaped %s on reauthorization',field=>{
  const root=mkdtempSync(join(tmpdir(),'g8-literal-metadata-')),db=join(root,'db.sqlite');let store=new Store(db);
  try{
    const raw=field==='authorId'?'raw-author':'raw-locator';
    const input={projectId:'p',externalId:'literal-metadata',revision:'v1',title:'Source',content:'Content',authorId:'raw-author',locator:'raw-locator',retention:'ephemeral' as const,purpose:'reference' as const,[field]:store.auditTemporaryRevision(raw)};
    ingestSource(store,{projects:[project]},input);store.close();store=new Store(db);
    expect(()=>ingestSource(store,{projects:[project]},{...input,[field]:raw})).toThrowError(expect.objectContaining({code:'revision_conflict'}));
    expect(()=>ingestSource(store,{projects:[project]},input)).not.toThrow();
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('preserves recoverable raw legacy identity before startup redaction',()=>{
  const root=mkdtempSync(join(tmpdir(),'g8-legacy-raw-')),db=join(root,'db.sqlite');let store=new Store(db);
  try{
    const input={projectId:'p',externalId:'legacy-raw-id',revision:'legacy-raw-revision',title:'Temporary',content:'Synthetic body',authorId:'legacy-raw-author',locator:'legacy-raw-locator',retention:'ephemeral' as const,purpose:'reference' as const};
    ingestSource(store,{projects:[project]},input);const source=store.list('sources').find(value=>value.externalId===input.externalId)!;store.close();
    const ledger=new Database(db);const row=JSON.parse((ledger.prepare('SELECT data FROM sources WHERE id=?').get(source.id) as {data:string}).data);
    delete row.__hostOpaqueIdentity;Object.assign(row,{externalId:input.externalId,revision:input.revision,authorId:input.authorId,locator:input.locator,title:'Temporary source',content:''});
    ledger.prepare('UPDATE sources SET data=? WHERE id=?').run(JSON.stringify(row),source.id);ledger.close();
    store=new Store(db);expect(store.sourceHasOpaqueIdentity(store.get('sources',source.id)!)).toBe(true);
    expect(()=>ingestSource(store,{projects:[project]},{...input,authorId:'wrong'})).toThrowError(expect.objectContaining({code:'revision_conflict'}));
    ingestSource(store,{projects:[project]},input);expect(store.get('sources',source.id)?.content).toBe(input.content);
    withdrawSource(store,source.id);expect(()=>ingestSource(store,{projects:[project]},input)).toThrow();
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('fails closed for an untagged legacy source whose author and locator preimages were lost',()=>{
  const root=mkdtempSync(join(tmpdir(),'g8-legacy-opaque-')),db=join(root,'db.sqlite');let store=new Store(db);
  try{
    const input={projectId:'p',externalId:'legacy-opaque',revision:'v1',title:'Source',content:'Content',authorId:'old-author',locator:'old-locator',retention:'ephemeral' as const,purpose:'reference' as const};
    ingestSource(store,{projects:[project]},input);const source=store.list('sources').find(value=>value.externalId===input.externalId)!;store.close();
    const old=new Database(db);old.prepare("UPDATE sources SET data=json_remove(data,'$.__hostOpaqueIdentity') WHERE id=?").run(source.id);old.close();
    store=new Store(db);expect(()=>ingestSource(store,{projects:[project]},input)).toThrowError(expect.objectContaining({code:'revision_conflict'}));
    expect(store.get('sources',source.id)?.content).toBe('');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['active','superseded'] as const)('rejects a direct host deletion that would leave a %s child without lineage',async status=>{
  const root=mkdtempSync(join(tmpdir(),'g8-host-delete-')),db=join(root,'db.sqlite'),store=new Store(db);
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'delete-parent',revision:'v1',title:'Parent',content:'Parent',purpose:'reference'});
    const parent=store.list('sources').find(source=>source.externalId==='delete-parent')!;
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'delete-child',revision:'v1',title:'Child',content:'HOST_DELETE_CHILD_SENTINEL',purpose:'reference'},[{id:parent.id,revision:parent.revision}]);
    const child=store.list('sources').find(source=>source.externalId==='delete-child')!;
    if(status==='superseded')store.save('sources',{...child,status});
    expect(()=>store.delete('sources',parent.id)).toThrowError(expect.objectContaining({code:'source_has_dependents'}));
    expect(store.get('sources',parent.id)?.content).toBe('Parent');expect(store.get('sources',child.id)?.content).toBe('HOST_DELETE_CHILD_SENTINEL');
    if(status==='active')expect(knowledgeSourceRefs(store,child.id,project)).toBeDefined();
    await store.backup(join(root,'backup.sqlite'));
    const backup=new Store(join(root,'backup.sqlite'));try{expect(backup.get('sources',parent.id)?.content).toBe('Parent');if(status==='active')expect(knowledgeSourceRefs(backup,child.id,project)).toBeDefined();}finally{backup.close();}
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('removes both ordinary-card claim forms from the Vault tombstone and a new backup',async()=>{
  const root=mkdtempSync(join(tmpdir(),'g8-ordinary-claim-')),db=join(root,'db.sqlite'),vault=join(root,'vault'),backup=join(root,'backup');
  let store=new Store(db,vault);
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'ordinary-claim-source',revision:'v1',title:'Source',content:'ORDINARY_CLAIM_QUOTE_SENTINEL',purpose:'reference'});
    const source=store.list('sources').find(value=>value.externalId==='ordinary-claim-source')!;
    const card=publishKnowledge(store,source,{cards:[{title:'Ordinary fact',body:'Reported fact',quote:source.content,aliases:['ordinary'],verification:'reported',kind:'fact',
      claim:{schemaVersion:1,interpretation:'reported',quote:source.content,claim:{kind:'ci-result',subject:{provider:'gitlab',repository:'CLAIM_REPOSITORY_SENTINEL',headSha:H,runId:'52',jobId:'71',checkName:'CLAIM_CHECK_SENTINEL'},value:{conclusion:'success'}}},
      pendingClaim:{kind:'ci-result',repository:'PENDING_REPOSITORY_SENTINEL',headSha:H,runId:'52',jobId:'71',checkName:'PENDING_CHECK_SENTINEL'}}]})[0]!;
    const cardPath=join(vault,'p','personal','cards',`${card.id}.md`);
    expect(readFileSync(cardPath,'utf8')).toContain('CLAIM_CHECK_SENTINEL');
    expect(readFileSync(cardPath,'utf8')).toContain('PENDING_CHECK_SENTINEL');
    store.save('sources',{...source,retention:'ephemeral'});
    const tombstone=readFileSync(cardPath,'utf8');
    for(const marker of ['ORDINARY_CLAIM_QUOTE_SENTINEL','CLAIM_REPOSITORY_SENTINEL','CLAIM_CHECK_SENTINEL','PENDING_REPOSITORY_SENTINEL','PENDING_CHECK_SENTINEL'])expect(tombstone).not.toContain(marker);
    const encoded=JSON.parse(tombstone.match(/^patrick_entity: (.+)$/m)![1]!);
    expect(encoded).toMatchObject({id:card.id,status:'withdrawn'});
    expect(encoded.claim).toBeUndefined();expect(encoded.pendingClaim).toBeUndefined();
    await createBackup(store,backup,{mode:'test',vaultDir:vault});store.close();
    const saved=readFileSync(join(backup,'vault','p','personal','cards',`${card.id}.md`),'utf8');
    for(const marker of ['CLAIM_REPOSITORY_SENTINEL','CLAIM_CHECK_SENTINEL','PENDING_REPOSITORY_SENTINEL','PENDING_CHECK_SENTINEL'])expect(saved).not.toContain(marker);
    store=new Store(db,vault);expect(store.get('cards',card.id)).toBeUndefined();
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['cards','rules','cases'] as const)('replays committed %s Vault redaction after a publication fault and restart',async failedTable=>{
  const root=mkdtempSync(join(tmpdir(),'g8-vault-redaction-retry-')),db=join(root,'db.sqlite'),vault=join(root,'vault'),otherPopulated=join(root,'populated-vault'),backup=join(root,'backup');
  let store=new Store(db,vault);
  try{
    const task=ingestSource(store,{projects:[project]},{projectId:'p',externalId:'redaction-task',revision:'v1',title:'Task',content:'Redaction source'})!;
    const source=store.get('sources',task.sourceId)!;
    const card=publishKnowledge(store,source,{cards:[{title:'CARD_PROJECTION_PRIVATE_SENTINEL',body:'Card',quote:source.content,aliases:[],verification:'reported',kind:'knowledge'}]})[0]!;
    const option={label:'Keep',description:'Keep it',rationale:'Reason',tradeoff:'Storage',evidenceUrls:[]};
    const question={id:'redaction-question',projectId:'p',domain:'personal',taskId:task.id,taskVersion:task.version,version:1,ownerId:project.ownerId,title:'Question',context:'Choice',options:{A:option,B:{...option,label:'Discard'}},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:new Date().toISOString()};
    const decisionCase=recordOwnerDecision(store,task,question,{questionId:question.id,taskVersion:task.version,questionVersion:1,choice:'A',actorId:project.ownerId,eventId:'redaction-answer'});
    const rule=store.get('rules',decisionCase.ruleIds[0]!)!;
    store.save('rules',{...rule,title:'RULE_PROJECTION_PRIVATE_SENTINEL'});
    store.save('cases',{...decisionCase,rationale:'CASE_PROJECTION_PRIVATE_SENTINEL'});
    const paths={cards:join(vault,'p','personal','cards',`${card.id}.md`),rules:join(vault,'p','personal','rules',`${rule.id}.md`),cases:join(vault,'p','personal','cases',`${decisionCase.id}.md`)};
    const marker={cards:'CARD_PROJECTION_PRIVATE_SENTINEL',rules:'RULE_PROJECTION_PRIVATE_SENTINEL',cases:'CASE_PROJECTION_PRIVATE_SENTINEL'};
    for(const table of ['cards','rules','cases'] as const)expect(readFileSync(paths[table],'utf8')).toContain(marker[table]);
    if(failedTable==='cards'){
      store.close();store=new Store(db,otherPopulated);
      expect(readFileSync(join(otherPopulated,'p','personal','cards',`${card.id}.md`),'utf8')).toContain(marker.cards);
      expect(readFileSync(join(otherPopulated,'p','personal','sources',`${source.id}.md`),'utf8')).toContain(source.content);
      store.close();store=new Store(db,vault);
    }
    const internal=store as unknown as {publish:(job:{table:string})=>void},publish=internal.publish.bind(store);
    internal.publish=job=>{if(job.table===failedTable)throw new Error('synthetic projection fault');publish(job);};
    expect(()=>store.save('sources',{...source,retention:'ephemeral'})).toThrowError(expect.objectContaining({code:'vault_sync_unavailable'}));
    expect(readFileSync(paths[failedTable],'utf8')).toContain(marker[failedTable]);
    await expect(createBackup(store,join(root,'must-fail'),{mode:'test',vaultDir:vault})).rejects.toThrow();
    if(failedTable==='cards'){
      const pending=store.list('cursors').filter(cursor=>cursor.id.startsWith('vault-redaction:'));
      expect(pending.length).toBeGreaterThan(0);
      store.close();store=new Store(db,join(root,'other-vault'));
      expect(store.list('cursors').filter(cursor=>cursor.id.startsWith('vault-redaction:'))).toEqual(pending);
      expect(readFileSync(paths.cards,'utf8')).toContain(marker.cards);
      const rejected=join(root,'wrong-vault-backup');
      await expect(createBackup(store,rejected,{mode:'test',vaultDir:vault})).rejects.toThrowError(expect.objectContaining({code:'vault_cleanup_unavailable'}));
      expect(existsSync(rejected)).toBe(false);
      expect(readdirSync(root).filter(name=>name.startsWith('wrong-vault-backup.partial-'))).toEqual([]);
      expect(readFileSync(paths.cards,'utf8')).toContain(marker.cards);
    }
    store.close();store=new Store(db,vault);
    if(failedTable==='cards'){
      const waitingForOther=store.list('cursors').filter(cursor=>cursor.id.startsWith('vault-redaction:'));
      expect(waitingForOther.length).toBeGreaterThan(0);
      expect(waitingForOther.some(cursor=>JSON.parse(cursor.value).table==='sources')).toBe(true);
      expect(waitingForOther.some(cursor=>JSON.parse(cursor.value).table==='cards')).toBe(true);
      store.reconcileVault();
      expect(store.list('cursors').filter(cursor=>cursor.id.startsWith('vault-redaction:'))).toEqual(waitingForOther);
      expect(readFileSync(join(otherPopulated,'p','personal','cards',`${card.id}.md`),'utf8')).toContain(marker.cards);
      expect(readFileSync(join(otherPopulated,'p','personal','sources',`${source.id}.md`),'utf8')).toContain(source.content);
      await expect(createBackup(store,join(root,'dirty-other-backup'),{mode:'test',vaultDir:otherPopulated})).rejects.toThrowError(expect.objectContaining({code:'vault_cleanup_unavailable'}));
      expect(existsSync(join(root,'dirty-other-backup'))).toBe(false);
      await createBackup(store,backup,{mode:'test',vaultDir:vault});
      expect(readFileSync(join(backup,'vault','p','personal','cards',`${card.id}.md`),'utf8')).not.toContain(marker.cards);
      expect(readFileSync(join(backup,'vault','p','personal','sources',`${source.id}.md`),'utf8')).not.toContain(source.content);
      store.close();store=new Store(db,otherPopulated);
      expect(store.list('cursors').filter(cursor=>cursor.id.startsWith('vault-redaction:'))).toEqual([]);
      expect(readFileSync(join(otherPopulated,'p','personal','cards',`${card.id}.md`),'utf8')).not.toContain(marker.cards);
      expect(readFileSync(join(otherPopulated,'p','personal','sources',`${source.id}.md`),'utf8')).not.toContain(source.content);
      const otherBackup=join(root,'other-backup');await createBackup(store,otherBackup,{mode:'test',vaultDir:otherPopulated});
      expect(readFileSync(join(otherBackup,'vault','p','personal','cards',`${card.id}.md`),'utf8')).not.toContain(marker.cards);
      expect(readFileSync(join(otherBackup,'vault','p','personal','sources',`${source.id}.md`),'utf8')).not.toContain(source.content);
    }
    for(const table of ['cards','rules','cases'] as const)expect(readFileSync(paths[table],'utf8')).not.toContain(marker[table]);
    expect(store.get('cards',card.id)).toBeUndefined();expect(store.get('rules',rule.id)).toBeUndefined();expect(store.get('cases',decisionCase.id)).toBeUndefined();
    expect(store.searchCards(marker.cards,project)).toEqual([]);
    if(failedTable!=='cards')await createBackup(store,backup,{mode:'test',vaultDir:vault});
    for(const table of ['cards','rules','cases'] as const){
      const path=join(backup,'vault','p','personal',table,`${table==='cards'?card.id:table==='rules'?rule.id:decisionCase.id}.md`);
      expect(readFileSync(path,'utf8')).not.toContain(marker[table]);
      expect(readFileSync(db).includes(Buffer.from(marker[table]))).toBe(false);
      expect(readFileSync(join(backup,'patrick.db')).includes(Buffer.from(marker[table]))).toBe(false);
    }
    if(failedTable==='cards'){
      // The earlier Vault must also remain pending when a later, clean switch is followed by withdrawal.
      store.close();store=new Store(db,vault);
      const source2={...source,id:'clean-switch-source',externalId:'clean-switch-source',content:'CLEAN_SWITCH_SOURCE_PRIVATE'};
      const card2={...card,id:'clean-switch-card',sourceId:source2.id,title:'CLEAN_SWITCH_CARD_PRIVATE',quote:source2.content};
      store.save('sources',source2);store.save('cards',card2);
      store.close();store=new Store(db,otherPopulated);
      expect(readFileSync(join(otherPopulated,'p','personal','cards',`${card2.id}.md`),'utf8')).toContain(card2.title);
      withdrawSource(store,source2.id);
      expect(readFileSync(join(otherPopulated,'p','personal','cards',`${card2.id}.md`),'utf8')).not.toContain(card2.title);
      expect(readFileSync(join(vault,'p','personal','cards',`${card2.id}.md`),'utf8')).toContain(card2.title);
      await expect(createBackup(store,join(root,'dirty-first-backup'),{mode:'test',vaultDir:vault})).rejects.toThrowError(expect.objectContaining({code:'vault_cleanup_unavailable'}));
      store.close();store=new Store(db,vault);
      expect(store.list('cursors').filter(cursor=>cursor.id.startsWith('vault-redaction:'))).toEqual([]);
      const cleanBackup=join(root,'clean-first-backup');await createBackup(store,cleanBackup,{mode:'test',vaultDir:vault});
      expect(readFileSync(join(cleanBackup,'vault','p','personal','cards',`${card2.id}.md`),'utf8')).not.toContain(card2.title);
      expect(readFileSync(join(cleanBackup,'vault','p','personal','sources',`${source2.id}.md`),'utf8')).not.toContain(source2.content);
    }
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['reference','task'] as const)('keeps a permanent %s child of an ephemeral source out of durable bytes', async purpose => {
  const root=mkdtempSync(join(tmpdir(),'g8-ancestry-')),db=join(root,'db.sqlite'),vault=join(root,'vault');
  let store=new Store(db,vault);
  try {
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'PARENT_PRIVATE_EXTERNAL_SENTINEL',authorId:'PARENT_PRIVATE_AUTHOR_SENTINEL',revision:'PARENT_PRIVATE_VERSION_SENTINEL',title:'Parent',content:'PARENT_PRIVATE_SENTINEL',retention:'ephemeral',purpose:'reference'});
    const parent=store.list('sources').find(s=>s.externalId==='PARENT_PRIVATE_EXTERNAL_SENTINEL')!;
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'CHILD_PRIVATE_EXTERNAL_SENTINEL',authorId:'CHILD_PRIVATE_AUTHOR_SENTINEL',revision:'CHILD_PRIVATE_VERSION_SENTINEL',title:'CHILD_PRIVATE_TITLE_SENTINEL',content:'CHILD_PRIVATE_BODY_SENTINEL',locator:'CHILD_PRIVATE_LOCATOR_SENTINEL',retention:'permanent',purpose},[{id:parent.id,revision:parent.revision}]);
    const child=store.list('sources').find(s=>s.externalId==='CHILD_PRIVATE_EXTERNAL_SENTINEL')!;
    expect(child.content).toBe('CHILD_PRIVATE_BODY_SENTINEL');
    await store.backup(join(root,'backup.sqlite'));
    store.close();
    const files=[db,join(root,'backup.sqlite'),...readdirSync(vault,{recursive:true}).map(String).filter(p=>p.endsWith('.md')).map(p=>join(vault,p))];
    for(const path of files)for(const marker of ['PARENT_PRIVATE_SENTINEL','PARENT_PRIVATE_VERSION_SENTINEL','PARENT_PRIVATE_EXTERNAL_SENTINEL','PARENT_PRIVATE_AUTHOR_SENTINEL','CHILD_PRIVATE_TITLE_SENTINEL','CHILD_PRIVATE_BODY_SENTINEL','CHILD_PRIVATE_LOCATOR_SENTINEL','CHILD_PRIVATE_VERSION_SENTINEL','CHILD_PRIVATE_EXTERNAL_SENTINEL','CHILD_PRIVATE_AUTHOR_SENTINEL'])expect(readFileSync(path).includes(Buffer.from(marker)),`${path} contains ${marker}`).toBe(false);
    store=new Store(db,vault);
    expect(store.get('sources',child.id)?.content).not.toContain('CHILD_PRIVATE_BODY_SENTINEL');
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'PARENT_PRIVATE_EXTERNAL_SENTINEL',authorId:'PARENT_PRIVATE_AUTHOR_SENTINEL',revision:'PARENT_PRIVATE_VERSION_SENTINEL',title:'Parent',content:'PARENT_PRIVATE_SENTINEL',retention:'ephemeral',purpose:'reference'});
    const restoredParent=store.get('sources',parent.id)!;
    expect(()=>ingestSource(store,{projects:[project]},{projectId:'p',externalId:'CHILD_PRIVATE_EXTERNAL_SENTINEL',authorId:'wrong',revision:'CHILD_PRIVATE_VERSION_SENTINEL',title:'CHILD_PRIVATE_TITLE_SENTINEL',content:'CHILD_PRIVATE_BODY_SENTINEL',locator:'changed',retention:'permanent',purpose},[{id:restoredParent.id,revision:restoredParent.revision}])).toThrow();
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'CHILD_PRIVATE_EXTERNAL_SENTINEL',authorId:'CHILD_PRIVATE_AUTHOR_SENTINEL',revision:'CHILD_PRIVATE_VERSION_SENTINEL',title:'CHILD_PRIVATE_TITLE_SENTINEL',content:'CHILD_PRIVATE_BODY_SENTINEL',locator:'CHILD_PRIVATE_LOCATOR_SENTINEL',retention:'permanent',purpose},[{id:restoredParent.id,revision:restoredParent.revision}]);
    expect(store.get('sources',child.id)?.content).toBe('CHILD_PRIVATE_BODY_SENTINEL');
    if(purpose==='task')expect(store.list('tasks').find(task=>task.sourceId===child.id)?.sourceRevision).toBe('CHILD_PRIVATE_VERSION_SENTINEL');
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});

it('recovers genuine history after restart, while copied Vault metadata cannot recreate its private authority',async()=>{
  const root=mkdtempSync(join(tmpdir(),'g8-history-recovery-')),db=join(root,'db.sqlite'),vault=join(root,'vault');
  let store=new Store(db,vault);const fixture=repositoryKnowledgeFixture('gitlab',{store,project,path:'docs/recovery.test.ts',command:'test recovery'});
  try{
    const content=JSON.stringify({schemaVersion:1,quote:'Recovered reported problem',details:{schemaVersion:1,problem:'恢复历史记录',symptomAliases:['重启后查询历史'],solution:'重建索引',files:['docs/recovery.test.ts'],productId:project.id,codeVersion:H,environment:'synthetic',invalidationConditions:['changed']},repository:project.repository,headSha:H,runId:'52',jobId:'71',checkIds:['validate'],testReportPath:reportPath});
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'retained-history',revision:'v1',title:'恢复历史记录',content,purpose:'reference'});
    const source=store.list('sources').find(s=>s.externalId==='retained-history')!;
    expect(await ingestStructuredExperience(store,fixture.reader,source.id,new AbortController().signal)).toBe(true);
    const original=store.searchCards('重启后查询历史',project).find(c=>c.kind==='experience')!;expect(original.experienceReference).toBeDefined();
    store.close();store=new Store(db,vault);
    const recovered=store.searchCards('重启后查询历史',project,20,{current:{projectId:'p',domain:'personal',repository:project.repository,revision:'c'.repeat(40),environment:{node:'25'},observedAt:new Date().toISOString()}}).find(c=>c.id===original.id);
    expect(recovered?.experienceReference?.currentApplicability.status).toBe('needs-revalidation');
    expect(recovered?.experienceReference?.observationIds).toEqual(original.experienceReference?.observationIds);
    store.close();
    const cardPath=join(vault,'p','personal','cards',`${encodeURIComponent(original.id).replaceAll('.','%2E')}.md`),markdown=readFileSync(cardPath,'utf8');
    writeFileSync(cardPath,markdown.replace(/^patrick_entity: (.+)$/m,(_,json)=>{const card=JSON.parse(json);card.verification='verified';card.experienceReference={label:'historical-test-backed-reference',observed:[{checks:[{result:'success'}]}]};return `patrick_entity: ${JSON.stringify(card)}`;}));
    const clean=join(root,'vault-only.sqlite');store=new Store(clean);store.save('projects',project);store.close();store=new Store(clean,vault);
    expect(store.searchCards('重启后查询历史',project).some(c=>c.id===original.id)).toBe(false);
    const browse=store.searchCards('重启后查询历史',project,20,{usage:'browse'}).find(c=>c.id===original.id);
    if(browse)expect(browse.experienceReference).toBeUndefined();
    expect(store.list('actions').filter(a=>a.kind==='experience.test-observation'||a.kind==='experience.evidence-link')).toEqual([]);
  }finally{fixture.close();store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['reference','task'] as const)('keeps admitted temporary %s history, links and descriptive fields only in the active process',async purpose=>{
  const root=mkdtempSync(join(tmpdir(),'g8-temporary-history-')),db=join(root,'db.sqlite'),vault=join(root,'vault'),backup=join(root,'backup');
  let store=new Store(db,vault);
  const file='docs/TEMP_HISTORY_FILE_SENTINEL.ts',command='TEMP_HISTORY_COMMAND_SENTINEL';
  const fixture=repositoryKnowledgeFixture('gitlab',{store,project,path:file,command});
  const markers=['TEMP_HISTORY_TITLE_SENTINEL','TEMP_HISTORY_QUOTE_SENTINEL','TEMP_HISTORY_PROBLEM_SENTINEL','TEMP_HISTORY_ALIAS_SENTINEL','TEMP_HISTORY_SOLUTION_SENTINEL','TEMP_HISTORY_FILE_SENTINEL','TEMP_HISTORY_COMMAND_SENTINEL','TEMP_HISTORY_ENVIRONMENT_SENTINEL','TEMP_HISTORY_INVALIDATION_SENTINEL','TEMP_HISTORY_LOCATOR_SENTINEL','TEMP_HISTORY_VERSION_SENTINEL'];
  try{
    const content=JSON.stringify({schemaVersion:1,quote:markers[1],details:{schemaVersion:1,problem:markers[2],symptomAliases:[markers[3]],solution:markers[4],files:[file],productId:project.id,codeVersion:'unknown',environment:markers[7],invalidationConditions:[markers[8]]},repository:project.repository,headSha:H,runId:'52',jobId:'71',checkIds:['validate'],testReportPath:reportPath});
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:`temporary-${purpose}`,revision:markers[10],title:markers[0]!,content,locator:markers[9],retention:'ephemeral',purpose});
    const source=store.list('sources').find(s=>s.externalId===`temporary-${purpose}`)!;
    expect(await ingestStructuredExperience(store,fixture.reader,source.id,new AbortController().signal)).toBe(true);
    const card=store.list('cards').find(c=>c.sourceId===source.id&&c.kind==='experience')!;
    expect(knowledgeReference(store,card,project)?.experienceReference?.reportedSolution.text).toBe(markers[4]);
    expect(store.list('actions').some(a=>a.kind==='experience.test-observation')).toBe(true);
    expect(store.list('actions').some(a=>a.kind==='experience.evidence-link')).toBe(true);
    await createBackup(store,backup,{mode:'test',vaultDir:vault});store.close();
    const trees=[vault,backup],files=[db,...trees.flatMap(tree=>readdirSync(tree,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name)))];
    for(const path of files)for(const marker of markers.flatMap(value=>[value,value.toLowerCase()]))expect(readFileSync(path).includes(Buffer.from(marker)),`${path} contains ${marker}`).toBe(false);
    store=new Store(db,vault);expect(store.searchCards(markers[3]!,project)).toEqual([]);
    expect(store.list('actions').filter(a=>a.kind==='experience.test-observation'||a.kind==='experience.evidence-link')).toEqual([]);
  }finally{fixture.close();store.close();rmSync(root,{recursive:true,force:true});}
});

it('retracts admitted history and all of its readable source metadata before rebuilding or backing up',async()=>{
  const root=mkdtempSync(join(tmpdir(),'g8-withdrawal-')),db=join(root,'db.sqlite'),vault=join(root,'vault'),backup=join(root,'backup');let store=new Store(db,vault);
  const file='docs/RETRACT_FILE_SENTINEL.ts',command='RETRACT_COMMAND_SENTINEL',fixture=repositoryKnowledgeFixture('gitlab',{store,project,path:file,command});
  const markers=['RETRACT_TITLE_SENTINEL','RETRACT_QUOTE_SENTINEL','RETRACT_PROBLEM_SENTINEL','RETRACT_ALIAS_SENTINEL','RETRACT_SOLUTION_SENTINEL','RETRACT_FILE_SENTINEL','RETRACT_COMMAND_SENTINEL','RETRACT_ENVIRONMENT_SENTINEL','RETRACT_INVALIDATION_SENTINEL','RETRACT_LOCATOR_SENTINEL','RETRACT_VERSION_SENTINEL'];
  try{
    const content=JSON.stringify({schemaVersion:1,quote:markers[1],details:{schemaVersion:1,problem:markers[2],symptomAliases:[markers[3]],solution:markers[4],files:[file],productId:project.id,codeVersion:'unknown',environment:markers[7],invalidationConditions:[markers[8]]},repository:project.repository,headSha:H,runId:'52',jobId:'71',checkIds:['validate'],testReportPath:reportPath});
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'withdraw-history',revision:markers[10],title:markers[0]!,content,locator:markers[9],purpose:'reference'});
    const source=store.list('sources').find(s=>s.externalId==='withdraw-history')!;
    expect(await ingestStructuredExperience(store,fixture.reader,source.id,new AbortController().signal)).toBe(true);
    const card=store.list('cards').find(c=>c.sourceId===source.id&&c.kind==='experience')!;expect(knowledgeReference(store,card,project)?.experienceReference).toBeDefined();
    withdrawSource(store,source.id);
    expect(store.searchCards(markers[3]!,project)).toEqual([]);
    const retired=store.get('cards',card.id)!;expect(retired.experience).toBeUndefined();expect(retired.body+retired.quote).toBe('');
    const state=JSON.stringify(['sources','cards','actions','events','tasks'].flatMap(table=>store.list(table as 'sources')));
    for(const marker of markers)expect(state).not.toContain(marker);
    if(existsSync(`${db}-wal`))for(const marker of markers)expect(readFileSync(`${db}-wal`).includes(Buffer.from(marker)),`WAL contains ${marker}`).toBe(false);
    await createBackup(store,backup,{mode:'test',vaultDir:vault});store.close();
    const files=[db,...[vault,backup].flatMap(tree=>readdirSync(tree,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name)))];
    for(const path of files)for(const marker of markers.flatMap(value=>[value,value.toLowerCase()]))expect(readFileSync(path).includes(Buffer.from(marker)),`${path} contains ${marker}`).toBe(false);
    store=new Store(db,vault);expect(store.searchCards(markers[3]!,project)).toEqual([]);
  }finally{fixture.close();store.close();rmSync(root,{recursive:true,force:true});}
});

it('reports a blocked WAL cleanup and retries it after the reader closes',()=>{
  const root=mkdtempSync(join(tmpdir(),'g8-reader-')),db=join(root,'db.sqlite'),store=new Store(db,join(root,'vault'));
  let reader:Database.Database|undefined;
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'reader-source',revision:'v1',title:'READER_PRIVATE_SENTINEL',content:'READER_PRIVATE_SENTINEL',purpose:'reference'});
    const source=store.list('sources').find(s=>s.externalId==='reader-source')!;
    reader=new Database(db);reader.exec('BEGIN');reader.prepare('SELECT * FROM sources').all();
    (store as unknown as {db:Database.Database}).db.pragma('busy_timeout = 10');
    expect(()=>store.save('sources',{...source,retention:'ephemeral'})).toThrowError(expect.objectContaining({code:'privacy_checkpoint_unavailable'}));
    expect(readFileSync(`${db}-wal`).includes(Buffer.from('READER_PRIVATE_SENTINEL'))).toBe(true);
    reader.exec('ROLLBACK');reader.close();reader=undefined;
    store.reconcileVault();
    if(existsSync(`${db}-wal`))expect(readFileSync(`${db}-wal`).includes(Buffer.from('READER_PRIVATE_SENTINEL'))).toBe(false);
  }finally{if(reader){reader.exec('ROLLBACK');reader.close();}store.close();rmSync(root,{recursive:true,force:true});}
});

it('retries a committed withdrawal cleanup after restart while an old reader remains open',()=>{
  const root=mkdtempSync(join(tmpdir(),'g8-restart-reader-')),db=join(root,'db.sqlite'),vault=join(root,'vault');let store:Store|undefined=new Store(db,vault),reader:Database.Database|undefined;
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'withdraw-reader',revision:'v1',title:'RESTART_WITHDRAW_PRIVATE_SENTINEL',content:'RESTART_WITHDRAW_PRIVATE_SENTINEL',purpose:'reference'});
    const source=store.list('sources').find(s=>s.externalId==='withdraw-reader')!;
    reader=new Database(db);reader.exec('BEGIN');reader.prepare('SELECT * FROM sources').all();
    (store as unknown as {db:Database.Database}).db.pragma('busy_timeout = 10');
    expect(()=>withdrawSource(store!,source.id)).toThrowError(expect.objectContaining({code:'privacy_checkpoint_unavailable'}));
    store.close();store=undefined;
    expect(()=>{store=new Store(db,vault);}).toThrowError(expect.objectContaining({code:'privacy_checkpoint_unavailable'}));
    reader.exec('ROLLBACK');reader.close();reader=undefined;
    store=new Store(db,vault);expect(store.get('sources',source.id)?.status).toBe('withdrawn');
    if(existsSync(`${db}-wal`))expect(readFileSync(`${db}-wal`).includes(Buffer.from('RESTART_WITHDRAW_PRIVATE_SENTINEL'))).toBe(false);
  }finally{if(reader){reader.exec('ROLLBACK');reader.close();}store?.close();rmSync(root,{recursive:true,force:true});}
},15000);

it('migrates a shared descendant DAG and its ordinary cards when an ancestor becomes ephemeral', async () => {
  const root=mkdtempSync(join(tmpdir(),'g8-transition-')),db=join(root,'db.sqlite'),vault=join(root,'vault');let store=new Store(db,vault);
  try{
    const add=(externalId:string,content:string,parents?:{id:string;revision:string}[],revision='v1')=>{
      ingestSource(store,{projects:[project]},{projectId:'p',externalId,revision,title:content,content,locator:`locator:${content}`,retention:'permanent',purpose:'reference'},parents);
      return store.list('sources').find(s=>s.externalId===externalId)!;
    };
    const ancestor=add('ancestor','TRANSITION_ANCESTOR_SENTINEL',undefined,'TRANSITION_ANCESTOR_VERSION_SENTINEL'),independent=add('independent','INDEPENDENT_AUTHORIZED_SENTINEL');
    const refs=[ancestor,independent].map(s=>({id:s.id,revision:s.revision}));
    const child=add('child','TRANSITION_CHILD_SENTINEL',refs,'TRANSITION_CHILD_VERSION_SENTINEL'),grandchild=add('grandchild','TRANSITION_GRANDCHILD_SENTINEL',[{id:child.id,revision:child.revision},{id:independent.id,revision:independent.revision}]);
    const card:KnowledgeCard={id:'ordinary-child-card',projectId:'p',domain:'personal',sourceId:grandchild.id,sourceRevision:grandchild.revision,title:'TRANSITION_CARD_TITLE_SENTINEL',body:'TRANSITION_CARD_BODY_SENTINEL',quote:grandchild.content,locator:grandchild.locator,aliases:['transition sentinel'],kind:'fact',verification:'reported',status:'active',createdAt:''};store.save('cards',card);
    store.save('sources',{...ancestor,retention:'ephemeral'});
    expect(store.get('sources',grandchild.id)?.content).toBe(grandchild.content);
    await store.backup(join(root,'backup.sqlite'));
    const markers=['TRANSITION_ANCESTOR_SENTINEL','TRANSITION_CHILD_SENTINEL','TRANSITION_GRANDCHILD_SENTINEL','TRANSITION_CARD_TITLE_SENTINEL','TRANSITION_CARD_BODY_SENTINEL','TRANSITION_ANCESTOR_VERSION_SENTINEL','TRANSITION_CHILD_VERSION_SENTINEL'];
    if(existsSync(`${db}-wal`))for(const marker of markers)expect(readFileSync(`${db}-wal`).includes(Buffer.from(marker)),`WAL contains ${marker}`).toBe(false);
    store.close();
    const files=[db,join(root,'backup.sqlite'),...readdirSync(vault,{recursive:true}).map(String).filter(p=>p.endsWith('.md')).map(p=>join(vault,p))];
    for(const path of files){const bytes=readFileSync(path);for(const marker of markers.flatMap(value=>[value,value.toLowerCase()]))expect(bytes.includes(Buffer.from(marker)),`${path} contains ${marker}`).toBe(false);}
    store=new Store(db,vault);expect(store.get('sources',independent.id)?.content).toBe('INDEPENDENT_AUTHORIZED_SENTINEL');
    expect(JSON.stringify(store.list('sources'))).not.toContain('TRANSITION_GRANDCHILD_SENTINEL');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['missing','wrong-revision','hashed-wrong-revision','wrong-scope','cycle'] as const)('does not durably retain a source with %s ancestry',async kind=>{
  const root=mkdtempSync(join(tmpdir(),'g8-invalid-lineage-')),db=join(root,'db.sqlite');let store=new Store(db,join(root,'vault'));
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'lineage-parent',revision:'v1',title:'Parent',content:'Parent',purpose:'reference'});
    const parent=store.list('sources').find(s=>s.externalId==='lineage-parent')!;
    const foreign={...parent,id:'foreign',projectId:'other',domain:'other'};store.save('sources',foreign);
    const refs=kind==='missing'?[{id:'missing',revision:'v1'}]:kind==='wrong-revision'?[{id:parent.id,revision:'wrong'}]:kind==='hashed-wrong-revision'?[{id:parent.id,revision:store.auditTemporaryRevision(parent.revision)}]:kind==='wrong-scope'?[{id:foreign.id,revision:foreign.revision}]:undefined;
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'invalid-child',revision:'v1',title:'INVALID_ANCESTRY_SENTINEL',content:'INVALID_ANCESTRY_SENTINEL',purpose:'reference'},refs);
    const child=store.list('sources').find(s=>s.externalId==='invalid-child')!;
    if(kind==='cycle')store.save('sources',{...child,parentSources:[{id:child.id,revision:child.revision}]});
    await store.backup(join(root,'backup.sqlite'));store.close();
    for(const path of [db,join(root,'backup.sqlite')])expect(readFileSync(path).includes(Buffer.from('INVALID_ANCESTRY_SENTINEL'))).toBe(false);
    store=new Store(db,join(root,'vault'));expect(JSON.stringify(store.list('sources'))).not.toContain('INVALID_ANCESTRY_SENTINEL');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['non-array','extra-field','duplicate','empty-ref'] as const)('fails closed and removes readable malformed %s ancestry',async kind=>{
  const root=mkdtempSync(join(tmpdir(),'g8-malformed-lineage-')),db=join(root,'db.sqlite'),store=new Store(db,join(root,'vault'));
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'parent',revision:'v1',title:'Parent',content:'Parent',purpose:'reference'});
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'bad-lineage',revision:'v1',title:'MALFORMED_LINEAGE_BODY_SENTINEL',content:'MALFORMED_LINEAGE_BODY_SENTINEL',purpose:'reference'});
    const parent=store.list('sources').find(s=>s.externalId==='parent')!,source=store.list('sources').find(s=>s.externalId==='bad-lineage')!;
    const ref={id:parent.id,revision:parent.revision};
    const parentSources=kind==='non-array'?{description:'MALFORMED_LINEAGE_METADATA_SENTINEL'}:kind==='extra-field'?[{...ref,description:'MALFORMED_LINEAGE_METADATA_SENTINEL'}]:kind==='duplicate'?[ref,ref]:[{id:'',revision:''}];
    store.save('sources',{...source,parentSources:parentSources as typeof source.parentSources});
    await store.backup(join(root,'backup.sqlite'));store.close();
    const files=[db,join(root,'backup.sqlite'),...readdirSync(join(root,'vault'),{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name))];
    for(const path of files)for(const marker of ['MALFORMED_LINEAGE_BODY_SENTINEL','MALFORMED_LINEAGE_METADATA_SENTINEL'])expect(readFileSync(path).includes(Buffer.from(marker)),`${path} contains ${marker}`).toBe(false);
    const reopened=new Store(db,join(root,'vault'));try{expect(reopened.get('sources',source.id)?.content).toBe('');}finally{reopened.close();}
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['withdrawn','superseded'] as const)('does not persist a new child of a %s source',async status=>{
  const root=mkdtempSync(join(tmpdir(),'g8-inactive-lineage-')),db=join(root,'db.sqlite'),store=new Store(db,join(root,'vault'));
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'inactive-parent',revision:'v1',title:'Parent',content:'Parent',purpose:'reference'});
    const parent=store.list('sources').find(s=>s.externalId==='inactive-parent')!;store.transaction(()=>invalidateSource(store,parent.id,status));
    const inactive=store.get('sources',parent.id)!;
    expect(()=>ingestSource(store,{projects:[project]},{projectId:'p',externalId:'inactive-child',revision:'v1',title:'INACTIVE_PARENT_CHILD_SENTINEL',content:'INACTIVE_PARENT_CHILD_SENTINEL',purpose:'reference'},[{id:inactive.id,revision:inactive.revision}])).toThrowError(expect.objectContaining({code:'stale_source'}));
    await store.backup(join(root,'backup.sqlite'));store.close();
    for(const path of [db,join(root,'backup.sqlite')])expect(readFileSync(path).includes(Buffer.from('INACTIVE_PARENT_CHILD_SENTINEL'))).toBe(false);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['reference','task'] as const)('cleans a genuine recovered Vault edit when its %s parent becomes temporary',async purpose=>{
  const root=mkdtempSync(join(tmpdir(),'g8-vault-edit-')),db=join(root,'db.sqlite'),vault=join(root,'vault'),backup=join(root,'backup');let store=new Store(db,vault);
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'vault-parent',revision:'v1',title:'VAULT_PARENT_SENTINEL',content:'VAULT_PARENT_SENTINEL',purpose});
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'vault-independent',revision:'v1',title:'Independent',content:'VAULT_INDEPENDENT_SENTINEL',purpose:'reference'});
    const parent=store.list('sources').find(s=>s.externalId==='vault-parent')!,path=join(vault,'p','personal','sources',`${parent.id}.md`);
    writeFileSync(path,`${readFileSync(path,'utf8')}\nVAULT_EDIT_PRIVATE_SENTINEL\n`);
    store.rebuildIndex();
    const child=store.list('sources').find(s=>s.externalId.startsWith('vault:')&&s.parentSources?.some(ref=>ref.id===parent.id))!;
    expect(child).toBeDefined();expect(child.purpose).toBe(purpose);expect(child.content).toContain('VAULT_EDIT_PRIVATE_SENTINEL');
    store.save('sources',{...parent,retention:'ephemeral'});expect(store.get('sources',child.id)?.content).toContain('VAULT_EDIT_PRIVATE_SENTINEL');
    store.rebuildIndex();await createBackup(store,backup,{mode:'test',vaultDir:vault});store.close();
    const files=[db,...[vault,backup].flatMap(tree=>readdirSync(tree,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name)))];
    for(const file of files)for(const marker of ['VAULT_PARENT_SENTINEL','VAULT_EDIT_PRIVATE_SENTINEL'])expect(readFileSync(file).includes(Buffer.from(marker)),`${file} contains ${marker}`).toBe(false);
    store=new Store(db,vault);expect(JSON.stringify(store.list('sources'))).not.toContain('VAULT_EDIT_PRIVATE_SENTINEL');
    expect(store.list('sources').find(s=>s.externalId==='vault-independent')?.content).toBe('VAULT_INDEPENDENT_SENTINEL');
    store.close();const clean=join(root,'vault-only.sqlite');store=new Store(clean);store.save('projects',project);store.close();store=new Store(clean,vault);
    expect(JSON.stringify(store.list('sources'))).not.toContain('VAULT_EDIT_PRIVATE_SENTINEL');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('migrates a permanent task, case, rule and snapshot when an independent cited source becomes temporary',async()=>{
  const root=mkdtempSync(join(tmpdir(),'g8-external-dependency-')),db=join(root,'db.sqlite'),vault=join(root,'vault');let store=new Store(db,vault);
  try{
    const task=ingestSource(store,{projects:[project]},{projectId:'p',externalId:'independent-task',revision:'v1',title:'Independent task',content:'INDEPENDENT_TASK_BODY',purpose:'task'})!;
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'external-reference',revision:'v1',title:'External',content:'EXTERNAL_REFERENCE_PRIVATE_SENTINEL',purpose:'reference'});
    const source=store.get('sources',task.sourceId)!,reference=store.list('sources').find(s=>s.externalId==='external-reference')!;
    const citation={sourceId:reference.id,revision:reference.revision,quote:reference.content,locator:reference.locator};
    const rule={id:'external-rule',projectId:'p',domain:'personal',title:'EXTERNAL_RULE_PRIVATE_SENTINEL',statement:'EXTERNAL_RULE_PRIVATE_SENTINEL',conditions:'Private conditions',exceptions:'None',version:1,kind:'observation' as const,status:'active' as const,caseIds:[],citations:[citation],createdAt:'',reviewAt:''};store.save('rules',rule);
    const decision={action:'proceed' as const,summary:'EXTERNAL_DECISION_PRIVATE_SENTINEL',rationale:'External evidence',citations:[citation],ruleIds:[rule.id]};
    const attemptId='attempt',snapshot:DecisionSnapshot={schemaVersion:1,id:stableId('decision-snapshot',task.id,task.version,attemptId),taskId:task.id,taskVersion:task.version,attemptId,inputHash:'input',projectId:'p',domain:'personal',sourceId:source.id,sourceRevision:source.revision,goal:{title:task.title,description:task.description},decision,rules:[rule],sourceRefs:[{id:source.id,revision:source.revision},{id:reference.id,revision:reference.revision}],expectedOutcome:'EXTERNAL_SNAPSHOT_PRIVATE_SENTINEL',recordedAt:''};
    store.save('tasks',{...task,decision,decisionSnapshotId:snapshot.id});
    store.save('actions',{id:snapshot.id,projectId:'p',domain:'personal',taskId:task.id,kind:'decision.snapshot',status:'completed',payload:{snapshot},updatedAt:''});
    store.save('cases',{id:'external-case',projectId:'p',domain:'personal',taskId:task.id,questionId:'q',decisionId:snapshot.id,actorId:'owner',choice:'A',originalWords:'EXTERNAL_CASE_PRIVATE_SENTINEL',rationale:'External rationale',alternatives:[],ruleIds:[rule.id],sourceId:source.id,status:'active',createdAt:'',decisionSnapshot:snapshot});
    store.save('sources',{...reference,retention:'ephemeral'});
    expect(store.get('sources',source.id)?.content).toBe('INDEPENDENT_TASK_BODY');
    await createBackup(store,join(root,'backup'),{mode:'test',vaultDir:vault});store.close();
    const files=[db,...[vault,join(root,'backup')].flatMap(tree=>readdirSync(tree,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name)))];
    for(const file of files)for(const marker of ['EXTERNAL_REFERENCE_PRIVATE_SENTINEL','EXTERNAL_RULE_PRIVATE_SENTINEL','EXTERNAL_DECISION_PRIVATE_SENTINEL','EXTERNAL_SNAPSHOT_PRIVATE_SENTINEL','EXTERNAL_CASE_PRIVATE_SENTINEL'])expect(readFileSync(file).includes(Buffer.from(marker)),`${file} contains ${marker}`).toBe(false);
    store=new Store(db,vault);expect(store.get('sources',source.id)?.content).toBe('INDEPENDENT_TASK_BODY');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('preserves a real permanent factual audit tombstone when a superseded ancestor later becomes temporary',async()=>{
  const root=mkdtempSync(join(tmpdir(),'g8-factual-audit-')),db=join(root,'db.sqlite');let store=new Store(db);
  const fixture=repositoryKnowledgeFixture('gitlab',{store,project});fixture.routes['/merge_requests/17'].sha=H;fixture.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'audit-parent',revision:'AUDIT_PARENT_REVISION_SENTINEL',title:'AUDIT_PARENT_TITLE_SENTINEL',content:'AUDIT_PARENT_BODY_SENTINEL',purpose:'reference'});
    const parent=store.list('sources').find(s=>s.externalId==='audit-parent')!;
    fixture.source.parentSources=[{id:parent.id,revision:parent.revision}];store.save('sources',fixture.source);
    expect(await ingestStructuredKnowledge(store,fixture.reader,fixture.source.id,new AbortController().signal)).toBe('processed');
    const task:Task={id:'audit-task',projectId:'p',domain:'personal',sourceId:fixture.source.id,sourceRevision:fixture.source.revision,title:'Requested check',description:'Requested check',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:0,spentUsd:0,stage:'decide'};
    store.save('tasks',task);const context=await prepareFactualContext(store,fixture.reader,task,new AbortController().signal);expect(context).toBeDefined();
    store.transaction(()=>invalidateSource(store,parent.id,'superseded'));
    const tombstone=store.get('actions',context!.id);expect(tombstone?.payload).toMatchObject({retracted:true,phase:'invalid'});
    store.save('sources',{...store.get('sources',parent.id)!,retention:'ephemeral'});
    expect(store.get('actions',context!.id)).toEqual(tombstone);
    await store.backup(join(root,'backup.sqlite'));store.close();
    for(const path of [db,join(root,'backup.sqlite')])for(const marker of ['AUDIT_PARENT_REVISION_SENTINEL','AUDIT_PARENT_TITLE_SENTINEL','AUDIT_PARENT_BODY_SENTINEL'])expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false);
    store=new Store(db);expect(store.get('actions',context!.id)).toEqual(tombstone);
  }finally{fixture.close();store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['reference','task'] as const)('cleans released legacy permanent %s descendants at startup without reviving them',async purpose=>{
  const root=mkdtempSync(join(tmpdir(),'g8-legacy-startup-')),db=join(root,'db.sqlite'),vault=join(root,'vault');let store=new Store(db,vault);
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'legacy-parent',revision:'v1',title:'LEGACY_PARENT_PRIVATE_SENTINEL',content:'LEGACY_PARENT_PRIVATE_SENTINEL',purpose:'reference'});
    const parent=store.list('sources').find(s=>s.externalId==='legacy-parent')!;
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'legacy-child',revision:'v1',title:'LEGACY_CHILD_PRIVATE_SENTINEL',content:'LEGACY_CHILD_PRIVATE_SENTINEL',purpose},[{id:parent.id,revision:parent.revision}]);
    const child=store.list('sources').find(s=>s.externalId==='legacy-child')!;store.close();
    // Recreate the released pre-fix durable policy state; the source and edge came from real ingestion.
    const legacy=new Database(db);legacy.prepare("UPDATE sources SET data=json_set(data,'$.retention','ephemeral') WHERE id=?").run(parent.id);legacy.close();
    store=new Store(db,vault);expect(store.get('sources',child.id)?.content).toBe('');
    await store.backup(join(root,'backup.sqlite'));store.close();
    const files=[db,join(root,'backup.sqlite'),...readdirSync(vault,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name))];
    for(const path of files)for(const marker of ['LEGACY_PARENT_PRIVATE_SENTINEL','LEGACY_CHILD_PRIVATE_SENTINEL'])expect(readFileSync(path).includes(Buffer.from(marker)),`${path} contains ${marker}`).toBe(false);
    store=new Store(db,vault);expect(store.get('sources',child.id)?.content).toBe('');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('visits each member of a shared permanent ancestry DAG a bounded number of times',()=>{
  const store=new Store(':memory:');
  try{
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'dag-root',revision:'v1',title:'Root',content:'Root',purpose:'reference'});
    let parents=[store.list('sources').find(s=>s.externalId==='dag-root')!];
    for(let layer=0;layer<10;layer++){
      const previous=parents;parents=[];
      for(let side=0;side<2;side++){
        const externalId=`dag-${layer}-${side}`;
        ingestSource(store,{projects:[project]},{projectId:'p',externalId,revision:'v1',title:'Node',content:'Node',purpose:'reference'},previous.map(s=>({id:s.id,revision:s.revision})));
        parents.push(store.list('sources').find(s=>s.externalId===externalId)!);
      }
    }
    const get=vi.spyOn(store,'get');
    try{expect(store.sourceRequiresTemporaryRetention(parents[0]!)).toBe(false);expect(get.mock.calls.filter(([table])=>table==='sources').length).toBeLessThan(100);}finally{get.mockRestore();}
  }finally{store.close();}
});

it('bounds source resolution during a scoped shared-DAG retention transition',async()=>{
  const store=new Store(':memory:'),other={...project,id:'other',projectId:'other',domain:'other'};
  try{
    const add=(scope:Project,id:string,parents:{id:string;revision:string}[]=[])=>{
      ingestSource(store,{projects:[scope]},{projectId:scope.id,externalId:id,revision:'v1',title:'Node',content:'Node',purpose:'reference'},parents);
      return store.list('sources').find(source=>source.projectId===scope.id&&source.externalId===id)!;
    };
    const root=add(project,'bounded-root');let layer=[root];const affected=[root];
    for(let depth=0;depth<9;depth++){
      const next=[0,1].map(side=>add(project,`bounded-${depth}-${side}`,layer.map(source=>({id:source.id,revision:source.revision}))));
      affected.push(...next);layer=next;
    }
    let foreign=add(other,'unrelated-root');const unrelated=[foreign.id];
    for(let depth=0;depth<12;depth++){foreign=add(other,`unrelated-${depth}`,[{id:foreign.id,revision:foreign.revision}]);unrelated.push(foreign.id);}
    for(let index=0;index<4;index++){
      const content=JSON.stringify({schemaVersion:1,quote:`Independent ${index}`,details:{schemaVersion:1,problem:`Unrelated problem ${index}`,symptomAliases:[`Unrelated alias ${index}`],solution:'Independent',files:[`docs/unrelated-${index}.ts`],productId:project.id,codeVersion:H,environment:'synthetic',invalidationConditions:['changed']},repository:project.repository,headSha:H,runId:'52',jobId:'71',checkIds:['validate'],testReportPath:reportPath});
      ingestSource(store,{projects:[project]},{projectId:'p',externalId:`unrelated-card-${index}`,revision:'v1',title:'Independent',content,purpose:'reference'});
      const source=store.list('sources').find(value=>value.externalId===`unrelated-card-${index}`)!;unrelated.push(source.id);
      expect(await ingestStructuredExperience(store,undefined,source.id,new AbortController().signal)).toBe(false);
    }
    const independentTask=ingestSource(store,{projects:[project]},{projectId:'p',externalId:'unrelated-case-task',title:'Independent task',content:'Independent task'})!,independentSource=store.get('sources',independentTask.sourceId)!;
    unrelated.push(independentSource.id);
    store.save('events',{id:'unrelated-source-event',projectId:'p',domain:'personal',taskId:independentTask.id,type:'source.updated',message:'Independent',data:{sourceId:independentSource.id},createdAt:''});
    store.save('events',{id:'affected-source-event',projectId:'p',domain:'personal',taskId:independentTask.id,type:'source.updated',message:'Sensitive',data:{sourceId:root.id,revision:root.revision},createdAt:''});
    const independentInput={task:independentTask,source:independentSource,project,role:'decide',cards:[],facts:[],rules:[]} as WorkerInput;
    store.save('attempts',{id:'unrelated-case-attempt',projectId:'p',domain:'personal',taskId:independentTask.id,taskVersion:independentTask.version,role:'decide',runner:'grok',model:'local',provider:'local',inputHash:digest(independentInput),status:'succeeded',costUsd:0,startedAt:new Date().toISOString()});
    const independentSnapshot=recordDecisionSnapshot(store,independentTask,independentInput,{action:'proceed',summary:'Independent',rationale:'Reason',citations:[],ruleIds:[]});
    const option={label:'Keep',description:'Independent',rationale:'Reason',tradeoff:'Storage',evidenceUrls:[]};
    const question={id:'unrelated-case-question',projectId:'p',domain:'personal',taskId:independentTask.id,taskVersion:independentTask.version,version:1,ownerId:project.ownerId,title:'Keep?',context:'Choice',options:{A:option,B:{...option,label:'Discard'}},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:independentSnapshot.recordedAt,decisionSnapshotId:independentSnapshot.id};
    recordOwnerDecision(store,independentTask,question,{questionId:question.id,taskVersion:question.taskVersion,questionVersion:question.version,choice:'A',actorId:project.ownerId,eventId:'unrelated-case-answer'});
    const get=vi.spyOn(store,'get'),prepare=vi.spyOn((store as any).db,'prepare'),dependency=vi.spyOn(store as any,'temporarySourceDependency');
    try{
      store.save('sources',{...root,retention:'ephemeral'});
      expect(prepare.mock.calls.filter(([sql])=>sql==='SELECT data FROM sources WHERE id = ?').length).toBeLessThan(affected.length*3);
      expect(dependency.mock.calls.filter(([id,scope])=>id===independentSource.id&&(scope as {id?:string}|undefined)?.id==='unrelated-source-event')).toHaveLength(0);
      expect(dependency.mock.calls.some(([id,scope])=>id===root.id&&(scope as {id?:string}|undefined)?.id==='affected-source-event')).toBe(true);
      const durableEvent=JSON.parse(((store as any).db.prepare('SELECT data FROM events WHERE id = ?').get('affected-source-event') as {data:string}).data);
      expect(durableEvent.message).toBe('Temporary source event.');
      expect(durableEvent.data.revision).toBe(`sha256:${digest(root.revision)}`);
      const lookups=get.mock.calls.filter(([table])=>table==='sources').map(([,id])=>id);
      expect(lookups.filter(id=>unrelated.includes(id))).toHaveLength(0);
      expect(get.mock.calls.filter(([table,id])=>table==='actions'&&id===independentSnapshot.id)).toHaveLength(0);
      expect(lookups.length).toBeLessThan(affected.length*12+30);
      expect(store.get('sources',layer[0]!.id)?.content).toBe('Node');
    }finally{get.mockRestore();prepare.mockRestore();dependency.mockRestore();}
  }finally{store.close();}
});

it('does not browse pending descriptions whose source lineage is unresolved',()=>{
  const store=new Store(':memory:');
  try{
    const add=(externalId:string,parents?:{id:string;revision:string}[])=>{
      ingestSource(store,{projects:[project]},{projectId:'p',externalId,revision:'v1',title:externalId,content:'A reported quotation',purpose:'reference'},parents);
      const source=store.list('sources').find(s=>s.externalId===externalId)!;
      return publishKnowledge(store,source,{cards:[{title:externalId,body:'A pending description',quote:'A reported quotation',aliases:['pending'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'Pending problem',symptomAliases:['pending'],solution:'Pending solution',files:['docs/test.ts'],productId:'p',codeVersion:H,environment:'synthetic',invalidationConditions:['changed']}}]})[0]!;
    };
    const authorized=add('authorized'),unresolved=add('unresolved',[{id:'missing-parent',revision:'v1'}]);
    expect(knowledgeReference(store,authorized,project,{usage:'browse'})?.experienceState?.state).toBe('pending');
    expect(knowledgeReference(store,unresolved,project,{usage:'browse'})).toBeUndefined();
    store.save('cards',{...authorized,status:'withdrawn'});
    const withdrawn=knowledgeReference(store,authorized,project,{usage:'browse'});
    expect(withdrawn).toMatchObject({title:'[withdrawn]',body:'',quote:'',aliases:[],locator:`withdrawn:${authorized.sourceId}`});
    expect(withdrawn?.experience).toBeUndefined();
  }finally{store.close();}
});

// The case is made by the actual owner-decision path and explicitly re-saved after
// its rule, so this isolates startup with an already durable, trusted case.
it.each([true,false])('defers a trusted case while its snapshot source may recover (projection present=%s)', restorePrimary => {
  const root=mkdtempSync(join(tmpdir(),'g8-case-startup-')),db=join(root,'db.sqlite'),vault=join(root,'vault');let store=new Store(db,vault);
  try {
    const task=ingestSource(store,{projects:[project]},{projectId:project.id,externalId:'case-task',title:'Case task',content:'CASE_PRIMARY_SENTINEL'})!;
    const source=store.get('sources',task.sourceId)!;
    const input={task,source,project,role:'decide',cards:[],facts:[],rules:[]} as WorkerInput;
    store.save('attempts',{id:'case-attempt',projectId:project.id,domain:project.domain,taskId:task.id,taskVersion:task.version,role:'decide',runner:'grok',model:'local',provider:'local',inputHash:digest(input),status:'succeeded',costUsd:0,startedAt:new Date().toISOString()});
    const snapshot=recordDecisionSnapshot(store,task,input,{action:'proceed',summary:'Case judgment',rationale:'Case reason',citations:[],ruleIds:[]});
    const option={label:'Keep',description:'CASE_RECOVERY_SENTINEL',rationale:'Reason',tradeoff:'Storage',evidenceUrls:[]};
    const question={id:'case-recovery-question',projectId:project.id,domain:project.domain,taskId:task.id,taskVersion:task.version,version:1,ownerId:project.ownerId,title:'Keep?',context:'Choice',options:{A:option,B:{...option,label:'Discard'}},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:snapshot.recordedAt,decisionSnapshotId:snapshot.id};
    const decisionCase=recordOwnerDecision(store,task,question,{questionId:question.id,taskVersion:task.version,questionVersion:1,choice:'A',actorId:project.ownerId,eventId:'case-recovery-event'});
    store.save('questions',{...question,answer:{choice:'A',text:decisionCase.originalWords,actorId:project.ownerId,eventId:'case-recovery-event'}});
    store.save('cases',decisionCase);
    const casePath=join(vault,project.id,project.domain,'cases',`${decisionCase.id}.md`),sourcePath=join(vault,project.id,project.domain,'sources',`${source.id}.md`);
    expect(readFileSync(casePath,'utf8')).toContain('CASE_RECOVERY_SENTINEL');
    // Simulate a pre-existing missing row for recovery; the live Store now rejects
    // deleting a source with an accepted answer dependent on it.
    store.close();const ledger=new Database(db);ledger.prepare('DELETE FROM sources WHERE id = ?').run(source.id);ledger.close();
    if(!restorePrimary)rmSync(sourcePath);
    else writeFileSync(casePath,readFileSync(casePath,'utf8').replace(/^patrick_entity: (.+)$/m,(_,raw)=>{const forged=JSON.parse(raw);forged.decisionSnapshot.goal.title='FORGED_VAULT_SNAPSHOT_SENTINEL';return `patrick_entity: ${JSON.stringify(forged)}`;}));
    store=new Store(db,vault);
    if(restorePrimary){
      expect(store.get('sources',source.id)).toMatchObject({status:'active',revision:source.revision,purpose:'task'});
      expect(store.get('cases',decisionCase.id)).toEqual(decisionCase);
      expect(store.get('cases',decisionCase.id)?.decisionSnapshot).toEqual(snapshot);
      expect(JSON.stringify(store.get('cases',decisionCase.id))).not.toContain('FORGED_VAULT_SNAPSHOT_SENTINEL');
      expect(store.get('cases',decisionCase.id)?.sourceId).toBe(decisionCase.sourceId);
      expect(readFileSync(casePath,'utf8')).toContain('CASE_RECOVERY_SENTINEL');
    }else{
      expect(store.get('cases',decisionCase.id)).toBeUndefined();
      expect(readFileSync(casePath,'utf8')).not.toContain('CASE_RECOVERY_SENTINEL');
      const raw=new Database(db,{readonly:true});try{expect(raw.prepare('SELECT data FROM cases WHERE id=?').get(decisionCase.id)).toBeUndefined();}finally{raw.close();}
    }
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

// Reuse the actual owner-created case and rule while withholding or invalidating
// only its rule; no alternate authority is minted by these scenarios.
it.each(['missing','cross-scope','temporary','wrong-revision','withdrawn'] as const)('does not publish an owner case with a %s rule dependency', kind => {
  const root=mkdtempSync(join(tmpdir(),'g8-case-rule-')),db=join(root,'db.sqlite'),vault=join(root,'vault');let store=new Store(db,vault);
  try {
    const task=ingestSource(store,{projects:[project]},{projectId:project.id,externalId:'rule-task',title:'Task',content:'Permanent task'})!;
    const option={label:'Keep',description:'CASE_RULE_PRIVATE_SENTINEL',rationale:'Reason',tradeoff:'Storage',evidenceUrls:[]};
    const question={id:'case-rule-question',projectId:project.id,domain:project.domain,taskId:task.id,taskVersion:task.version,version:1,ownerId:project.ownerId,title:'Keep?',context:'Choice',options:{A:option,B:{...option,label:'Discard'}},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:new Date().toISOString()};
    const decisionCase=recordOwnerDecision(store,task,question,{questionId:question.id,taskVersion:task.version,questionVersion:1,choice:'A',actorId:project.ownerId,eventId:'rule-answer'});
    store.save('questions',{...question,answer:{choice:'A',text:decisionCase.originalWords,actorId:project.ownerId,eventId:'rule-answer'}});
    const rule=store.get('rules',decisionCase.ruleIds[0]!)!;
    store.delete('cases',decisionCase.id);store.delete('rules',rule.id);store.save('cases',decisionCase);
    if(kind==='cross-scope')store.save('rules',{...rule,projectId:'other',citations:[]});
    if(kind==='wrong-revision')store.save('rules',{...rule,citations:rule.citations.map(c=>({...c,revision:'forged'}))});
    if(kind==='temporary'||kind==='withdrawn'){
      ingestSource(store,{projects:[project]},{projectId:project.id,externalId:`rule-${kind}`,revision:'v1',title:'Rule input',content:'Rule input',retention:kind==='temporary'?'ephemeral':'permanent',purpose:'reference'});
      const source=store.list('sources').find(s=>s.externalId===`rule-${kind}`)!;
      if(kind==='withdrawn')withdrawSource(store,source.id);
      const dependency=store.get('sources',source.id)!;
      store.save('rules',{...rule,citations:[{sourceId:dependency.id,revision:dependency.revision,quote:dependency.content||'[withdrawn]',locator:dependency.locator}]});
    }
    const raw=new Database(db,{readonly:true});try{expect(raw.prepare('SELECT data FROM cases WHERE id=?').get(decisionCase.id)).toBeUndefined();}finally{raw.close();}
    const casePath=join(vault,project.id,project.domain,'cases',`${decisionCase.id}.md`);
    if(existsSync(casePath))expect(readFileSync(casePath,'utf8')).not.toContain('CASE_RULE_PRIVATE_SENTINEL');
    store.close();store=new Store(db,vault);expect(store.get('cases',decisionCase.id)).toBeUndefined();
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('does not publish an owner case from an active source with a stale ancestor', () => {
  const root=mkdtempSync(join(tmpdir(),'g8-case-stale-')),db=join(root,'db.sqlite'),vault=join(root,'vault');let store=new Store(db,vault);
  try {
    ingestSource(store,{projects:[project]},{projectId:project.id,externalId:'case-ancestor',revision:'v1',title:'Ancestor',content:'Ancestor',purpose:'reference'});
    const parent=store.list('sources').find(s=>s.externalId==='case-ancestor')!;
    const task=ingestSource(store,{projects:[project]},{projectId:project.id,externalId:'case-descendant',title:'Task',content:'Task',purpose:'task'},[{id:parent.id,revision:parent.revision}])!;
    // Recreate the legacy stale-child state without authorizing a new source.
    store.save('sources',{...parent,status:'superseded'});
    const option={label:'Keep',description:'STALE_CASE_PRIVATE_SENTINEL',rationale:'Reason',tradeoff:'Storage',evidenceUrls:[]};
    const question={id:'stale-case-question',projectId:project.id,domain:project.domain,taskId:task.id,taskVersion:task.version,version:1,ownerId:project.ownerId,title:'Keep?',context:'Choice',options:{A:option,B:{...option,label:'Discard'}},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:new Date().toISOString()};
    const decisionCase=recordOwnerDecision(store,task,question,{questionId:question.id,taskVersion:task.version,questionVersion:1,choice:'A',actorId:project.ownerId,eventId:'stale-answer'});
    const raw=new Database(db,{readonly:true});try{expect(raw.prepare('SELECT data FROM cases WHERE id=?').get(decisionCase.id)).toBeUndefined();}finally{raw.close();}
    const casePath=join(vault,project.id,project.domain,'cases',`${decisionCase.id}.md`);
    if(existsSync(casePath))expect(readFileSync(casePath,'utf8')).not.toContain('STALE_CASE_PRIVATE_SENTINEL');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('does not recover a case or trust a forged Vault rule when its rule row is missing', () => {
  const root=mkdtempSync(join(tmpdir(),'g8-case-missing-rule-')),db=join(root,'db.sqlite'),vault=join(root,'vault');let store=new Store(db,vault);
  try {
    const task=ingestSource(store,{projects:[project]},{projectId:project.id,externalId:'missing-rule-task',title:'Task',content:'Task'})!;
    const option={label:'Keep',description:'MISSING_RULE_CASE_SENTINEL',rationale:'Reason',tradeoff:'Storage',evidenceUrls:[]};
    const question={id:'missing-rule-question',projectId:project.id,domain:project.domain,taskId:task.id,taskVersion:task.version,version:1,ownerId:project.ownerId,title:'Keep?',context:'Choice',options:{A:option,B:{...option,label:'Discard'}},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:new Date().toISOString()};
    const decisionCase=recordOwnerDecision(store,task,question,{questionId:question.id,taskVersion:task.version,questionVersion:1,choice:'A',actorId:project.ownerId,eventId:'missing-rule-answer'});
    store.save('questions',{...question,answer:{choice:'A',text:decisionCase.originalWords,actorId:project.ownerId,eventId:'missing-rule-answer'}});
    const ruleId=decisionCase.ruleIds[0]!,casePath=join(vault,project.id,project.domain,'cases',`${decisionCase.id}.md`),rulePath=join(vault,project.id,project.domain,'rules',`${ruleId}.md`);
    store.close();const ledger=new Store(db);ledger.delete('rules',ruleId);ledger.close();
    writeFileSync(rulePath,readFileSync(rulePath,'utf8').replace(/^patrick_entity: (.+)$/m,(_,raw)=>{const forged=JSON.parse(raw);forged.statement='FORGED_RULE_AUTHORITY_SENTINEL';return `patrick_entity: ${JSON.stringify(forged)}`;}));
    store=new Store(db,vault);
    expect(store.get('cases',decisionCase.id)).toBeUndefined();
    expect(store.get('rules',ruleId)?.statement).not.toBe('FORGED_RULE_AUTHORITY_SENTINEL');
    expect(readFileSync(casePath,'utf8')).not.toContain('MISSING_RULE_CASE_SENTINEL');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('withholds an owner case whose snapshot is missing its source references', () => {
  const root=mkdtempSync(join(tmpdir(),'g8-case-malformed-')),db=join(root,'db.sqlite'),vault=join(root,'vault');let store=new Store(db,vault);
  try {
    const task=ingestSource(store,{projects:[project]},{projectId:project.id,externalId:'malformed-case-task',title:'Task',content:'Task'})!,source=store.get('sources',task.sourceId)!;
    const input={task,source,project,role:'decide',cards:[],facts:[],rules:[]} as WorkerInput;
    store.save('attempts',{id:'malformed-case-attempt',projectId:project.id,domain:project.domain,taskId:task.id,taskVersion:task.version,role:'decide',runner:'grok',model:'local',provider:'local',inputHash:digest(input),status:'succeeded',costUsd:0,startedAt:new Date().toISOString()});
    const snapshot=recordDecisionSnapshot(store,task,input,{action:'proceed',summary:'Judgment',rationale:'Reason',citations:[],ruleIds:[]});
    const option={label:'Keep',description:'MALFORMED_CASE_SENTINEL',rationale:'Reason',tradeoff:'Storage',evidenceUrls:[]};
    const question={id:'malformed-case-question',projectId:project.id,domain:project.domain,taskId:task.id,taskVersion:task.version,version:1,ownerId:project.ownerId,title:'Keep?',context:'Choice',options:{A:option,B:{...option,label:'Discard'}},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:snapshot.recordedAt,decisionSnapshotId:snapshot.id};
    const decisionCase=recordOwnerDecision(store,task,question,{questionId:question.id,taskVersion:task.version,questionVersion:1,choice:'A',actorId:project.ownerId,eventId:'malformed-answer'});
    store.delete('cases',decisionCase.id);
    const malformed={...decisionCase,decisionSnapshot:{...snapshot,sourceRefs:undefined} as unknown as DecisionSnapshot};
    expect(()=>store.save('cases',malformed)).not.toThrow();
    const raw=new Database(db,{readonly:true});try{expect(raw.prepare('SELECT data FROM cases WHERE id=?').get(decisionCase.id)).toBeUndefined();}finally{raw.close();}
    const casePath=join(vault,project.id,project.domain,'cases',`${decisionCase.id}.md`);
    if(existsSync(casePath))expect(readFileSync(casePath,'utf8')).not.toContain('MALFORMED_CASE_SENTINEL');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it.each(['empty-refs','existing-case-empty-refs','missing-citation','missing-rule-citation','snapshot-id','task-id','scope','version','source-id','source-revision','changed-decision'] as const)('withholds a case whose host snapshot has %s',mode=>{
  const root=mkdtempSync(join(tmpdir(),'g8-case-snapshot-identity-')),db=join(root,'db.sqlite'),store=new Store(db,join(root,'vault'));
  try{
    const task=ingestSource(store,{projects:[project]},{projectId:'p',externalId:'case-host-task',title:'Task',content:'Task'})!,source=store.get('sources',task.sourceId)!;
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'case-host-reference',revision:'v1',title:'Reference',content:'Reference',purpose:'reference'});
    const reference=store.list('sources').find(value=>value.externalId==='case-host-reference')!;
    ingestSource(store,{projects:[project]},{projectId:'p',externalId:'case-rule-reference',revision:'v1',title:'Rule reference',content:'Rule reference',purpose:'reference'});
    const ruleSource=store.list('sources').find(value=>value.externalId==='case-rule-reference')!;
    const rule={id:'case-host-rule',projectId:'p',domain:'personal',title:'Rule',statement:'Rule reference',conditions:'Always',exceptions:'None',version:1,kind:'observation' as const,status:'active' as const,caseIds:[],citations:[{sourceId:ruleSource.id,revision:ruleSource.revision,quote:ruleSource.content,locator:ruleSource.locator}],createdAt:'',reviewAt:'2099-01-01T00:00:00Z'};store.save('rules',rule);
    const input={task,source,project,role:'decide',cards:[],facts:[],rules:[rule]} as WorkerInput;
    store.save('attempts',{id:'case-host-attempt',projectId:'p',domain:'personal',taskId:task.id,taskVersion:task.version,role:'decide',runner:'grok',model:'local',provider:'local',inputHash:digest(input),status:'succeeded',costUsd:0,startedAt:new Date().toISOString()});
    const snapshot=recordDecisionSnapshot(store,task,input,{action:'proceed',summary:'Decision',rationale:'Reason',citations:[{sourceId:reference.id,revision:reference.revision,quote:reference.content,locator:reference.locator}],ruleIds:[rule.id]});
    const option={label:'Keep',description:'CASE_BOUND_SNAPSHOT_SENTINEL',rationale:'Reason',tradeoff:'Storage',evidenceUrls:[]};
    const question={id:'case-host-question',projectId:'p',domain:'personal',taskId:task.id,taskVersion:task.version,version:1,ownerId:project.ownerId,title:'Keep?',context:'Choice',options:{A:option,B:{...option,label:'Discard'}},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:snapshot.recordedAt,decisionSnapshotId:snapshot.id};
    const decisionCase=recordOwnerDecision(store,task,question,{questionId:question.id,taskVersion:task.version,questionVersion:1,choice:'A',actorId:project.ownerId,eventId:'case-host-answer'});
    const altered=structuredClone(snapshot);
    if(mode==='empty-refs'||mode==='existing-case-empty-refs')altered.sourceRefs=[];
    if(mode==='missing-citation')altered.sourceRefs=altered.sourceRefs.filter(ref=>ref.id!==reference.id);
    if(mode==='missing-rule-citation')altered.sourceRefs=altered.sourceRefs.filter(ref=>ref.id!==ruleSource.id);
    if(mode==='snapshot-id')altered.id='different-snapshot';
    if(mode==='task-id')altered.taskId='different-task';
    if(mode==='scope')altered.domain='other';
    if(mode==='version')altered.taskVersion++;
    if(mode==='source-id')altered.sourceId=reference.id;
    if(mode==='source-revision')altered.sourceRevision='different-revision';
    if(mode==='changed-decision')altered.decision.summary='Forged decision';
    if(mode!=='existing-case-empty-refs')store.delete('cases',decisionCase.id);
    store.save('cases',{...decisionCase,decisionSnapshot:altered});
    const raw=new Database(db,{readonly:true});try{expect(raw.prepare('SELECT data FROM cases WHERE id=?').get(decisionCase.id)).toBeUndefined();}finally{raw.close();}
    const casePath=join(root,'vault','p','personal','cases',`${decisionCase.id}.md`);if(existsSync(casePath))expect(readFileSync(casePath,'utf8')).not.toContain('CASE_BOUND_SNAPSHOT_SENTINEL');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('does not recreate a missing host case or its snapshot from a forged Vault projection', () => {
  const root=mkdtempSync(join(tmpdir(),'g8-forged-missing-case-')),db=join(root,'db.sqlite'),vault=join(root,'vault');let store=new Store(db,vault);
  try {
    const task=ingestSource(store,{projects:[project]},{projectId:project.id,externalId:'forged-case-task',title:'Task',content:'Task'})!,source=store.get('sources',task.sourceId)!;
    const input={task,source,project,role:'decide',cards:[],facts:[],rules:[]} as WorkerInput;
    store.save('attempts',{id:'forged-case-attempt',projectId:project.id,domain:project.domain,taskId:task.id,taskVersion:task.version,role:'decide',runner:'grok',model:'local',provider:'local',inputHash:digest(input),status:'succeeded',costUsd:0,startedAt:new Date().toISOString()});
    const snapshot=recordDecisionSnapshot(store,task,input,{action:'proceed',summary:'Judgment',rationale:'Reason',citations:[],ruleIds:[]});
    const option={label:'Keep',description:'FORGED_CASE_SOURCE_SENTINEL',rationale:'Reason',tradeoff:'Storage',evidenceUrls:[]};
    const question={id:'forged-case-question',projectId:project.id,domain:project.domain,taskId:task.id,taskVersion:task.version,version:1,ownerId:project.ownerId,title:'Keep?',context:'Choice',options:{A:option,B:{...option,label:'Discard'}},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:snapshot.recordedAt,decisionSnapshotId:snapshot.id};
    const decisionCase=recordOwnerDecision(store,task,question,{questionId:question.id,taskVersion:task.version,questionVersion:1,choice:'A',actorId:project.ownerId,eventId:'forged-answer'});
    store.save('questions',{...question,answer:{choice:'A',text:decisionCase.originalWords,actorId:project.ownerId,eventId:'forged-answer'}});
    const casePath=join(vault,project.id,project.domain,'cases',`${decisionCase.id}.md`);
    store.close();const ledger=new Store(db);ledger.delete('cases',decisionCase.id);ledger.close();
    writeFileSync(casePath,readFileSync(casePath,'utf8').replace(/^patrick_entity: (.+)$/m,(_,raw)=>{const forged=JSON.parse(raw);forged.decisionSnapshot.goal.title='FORGED_CASE_AUTHORITY_SENTINEL';return `patrick_entity: ${JSON.stringify(forged)}`;}));
    for(let restart=0;restart<2;restart++){
      store=new Store(db,vault);
      expect(store.get('cases',decisionCase.id)).toBeUndefined();
      expect(store.list('sources').some(s=>s.externalId.endsWith(`/cases/${decisionCase.id}.md`))).toBe(false);
      expect(JSON.stringify(store.list('cases'))).not.toContain('FORGED_CASE_AUTHORITY_SENTINEL');
      store.close();
    }
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
