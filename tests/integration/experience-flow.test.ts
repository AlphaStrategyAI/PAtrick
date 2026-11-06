import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ingestStructuredExperience } from '../../src/integrations/experience-ci.js';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { configureDemo, demoResearch, demoWriter, DemoWorker } from '../../src/demo.js';
import { Workbench } from '../../src/orchestrator.js';
import { publishKnowledge } from '../../src/knowledge.js';
import { digest, stableId, type Attempt, type Project, type Task } from '../../src/domain.js';
import type { TestObservation } from '../../src/knowledge-contract.js';
import { knowledgePolicyHash } from '../../src/knowledge-identity.js';
import { invalidateSource } from '../../src/intake.js';
import { canonicalCiTestObservationId, hostObservationId, hostObservationSchema, readCanonicalHostRecord, readHostObservation, readTestObservation, readTestObservationWithTimes } from '../../src/knowledge-records.js';
import { experienceReference, linkExperienceForCards, linkRetainedExperienceEvidence } from '../../src/experience.js';
import { acceptRepositoryReadback } from '../../src/knowledge-evidence.js';
import { takeRepositoryReadback } from '../../src/integrations/repository-knowledge.js';
import { createBackup, verifyBackup } from '../../src/backup.js';
import { restoreBackup } from '../../scripts/restore.js';
import { Store } from '../../src/store.js';
import { repositoryKnowledgeFixture, H, measured, reportPath } from '../fixtures/repository-knowledge.js';

function envelope(projectId:string,repository:string,codeVersion=H){
  return JSON.stringify({schemaVersion:1,quote:'Resolution report',details:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache miss'],solution:'Clear the cache',files:['docs/test.ts'],productId:projectId,codeVersion,environment:'reported',invalidationConditions:['cache format changes']},repository,headSha:H,runId:'52',jobId:'71',checkIds:['validate']});
}
function relations(...records:{problem:string;files:string[];checks:string[]}[]):string {
  return ['@@experience-relations-v1',...records.map(({problem,files,checks})=>JSON.stringify({problem,files,checks})),'@@end-experience-relations-v1.'].join('\n');
}
const legacyBinding="CREATE INDEX actions_host_binding_key ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.sourceHash'),json_extract(data,'$.payload.requestHash'),json_extract(data,'$.payload.observation.claim.kind'),knowledge_host_root_key(data)) WHERE json_extract(data,'$.kind') = 'knowledge.host-observation'";
const legacyRoot="CREATE INDEX actions_host_root_key ON actions(json_extract(data,'$.kind'),project_id,domain,knowledge_host_root_key(data)) WHERE json_extract(data,'$.kind') = 'knowledge.host-observation'";
function registerLegacyFunction(db:Database.Database):void {
  db.function('knowledge_host_root_key',{deterministic:true},(data:string)=>{const root=JSON.parse(data)?.payload?.observation?.origin?.originalEventId;return typeof root==='string'&&root.length>0&&root.length<=10000?Buffer.from(root,'utf16le'):null;});
}
function legacyDatabase(path:string,binding=legacyBinding,root=legacyRoot):void {
  const db=new Database(path);try{registerLegacyFunction(db);db.exec('CREATE TABLE actions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, domain TEXT NOT NULL, data TEXT NOT NULL)');db.exec(binding);db.exec(root);}finally{db.close();}
}

describe('legacy host index migration',()=>{
  it('retains an authenticated host row and normal lookup through migration and reopen',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-migration-host-')),path=join(dir,'store.sqlite'),seed=repositoryKnowledgeFixture('gitlab'),project=seed.project;seed.close();
    let store:Store|undefined=new Store(path),raw:Database.Database|undefined;
    try{
      const f=repositoryKnowledgeFixture('gitlab',{store,project});
      const ids=acceptRepositoryReadback(store,f.source.id,await f.reader.read(project,f.source,f.request,new AbortController().signal)),host=ids.find(id=>!!readHostObservation(store!,id,project))!;
      expect(host).toBeDefined();const original=readHostObservation(store,host,project);
      store.close();store=undefined;raw=new Database(path);registerLegacyFunction(raw);raw.exec(legacyBinding);raw.exec(legacyRoot);raw.close();raw=undefined;
      store=new Store(path);expect(readHostObservation(store,host,project)).toEqual(original);
      expect(store.hostObservationRootActions(project,original!.origin.originalEventId).some(value=>value.id===host)).toBe(true);
      store.close();store=undefined;raw=new Database(path);
      expect(raw.pragma('integrity_check',{simple:true})).toBe('ok');expect(raw.prepare("SELECT sql FROM sqlite_schema WHERE sql LIKE '%knowledge_host_root_key%'").all()).toEqual([]);
      raw.close();raw=undefined;store=new Store(path);expect(readHostObservation(store,host,project)).toEqual(original);
    }finally{raw?.close();store?.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('rolls back actual readback admission on a stale WAL upgrade and consumes its handoff',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-admission-upgrade-')),path=join(dir,'store.sqlite'),seed=repositoryKnowledgeFixture('gitlab'),project=seed.project;seed.close();
    const store=new Store(path,join(dir,'vault')),f=repositoryKnowledgeFixture('gitlab',{store,project}),raw=new Database(path);
    try{
      const overlayCard={id:'rollback-overlay-card',projectId:project.id,domain:project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,status:'active' as const,kind:'fact' as const,verification:'reported' as const,title:'before',body:'before',quote:'before',locator:f.source.locator,aliases:[],createdAt:''};
      store.save('cards',overlayCard);
      const readback=await f.reader.read(project,f.source,f.request,new AbortController().signal),before=store.list('actions'),tempBefore=[...(store as any).temporary],vaultBefore=[...(store as any).vaultJobs];
      const db=(store as any).db,prepare=db.prepare.bind(db);let sqliteCode:string|undefined;
      const spy=vi.spyOn(db,'prepare').mockImplementation((...args:unknown[])=>{const sql=args[0];if(typeof sql!=='string')throw Error('Expected SQL text');const statement=prepare(sql);return new Proxy(statement,{get(target,property){
        if(property==='run')return (...args:unknown[])=>{try{return target.run(...args);}catch(error){sqliteCode=(error as {code?:string}).code;throw error;}};
        const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
      }});});
      try{
        expect(()=>store.transaction(()=>{
          expect(store.get('projects',project.id)).toEqual(project);
          store.saveTemporaryNormalizedExperienceCard({...overlayCard,title:'uncommitted overlay'});
          const external={id:'external-change',projectId:project.id,domain:project.domain,kind:'unrelated',status:'completed',payload:{},updatedAt:''};
          raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)').run(external.id,external.projectId,external.domain,JSON.stringify(external));
          acceptRepositoryReadback(store,f.source.id,readback);
        })).toThrowError(expect.objectContaining({code:'knowledge_snapshot_unavailable',status:503}));
      }finally{spy.mockRestore();}
      expect(sqliteCode).toBe('SQLITE_BUSY_SNAPSHOT');expect(takeRepositoryReadback(readback)).toBeUndefined();
      expect(store.list('actions').filter(value=>value.id!=='external-change')).toEqual(before);
      expect([...(store as any).temporary]).toEqual(tempBefore);expect([...(store as any).vaultJobs]).toEqual(vaultBefore);
      const fresh=await f.reader.read(project,f.source,f.request,new AbortController().signal);
      expect(acceptRepositoryReadback(store,f.source.id,fresh).length).toBeGreaterThan(0);
    }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('rolls back both legacy index drops if the second drop fails',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-migration-rollback-')),path=join(root,'store.sqlite');let raw:Database.Database|undefined,store:Store|undefined;
    try{
      legacyDatabase(path);const original=Database.prototype.exec;
      const spy=vi.spyOn(Database.prototype,'exec').mockImplementation(function(this:Database.Database,sql:string){if(sql==='DROP INDEX actions_host_root_key')throw Error('injected second drop');return original.call(this,sql);});
      try{expect(()=>new Store(path)).toThrow('injected second drop');}finally{spy.mockRestore();}
      raw=new Database(path);registerLegacyFunction(raw);
      expect(raw.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('actions_host_binding_key','actions_host_root_key') ORDER BY name").all()).toEqual([{name:'actions_host_binding_key',sql:legacyBinding},{name:'actions_host_root_key',sql:legacyRoot}]);
      expect(raw.pragma('integrity_check',{simple:true})).toBe('ok');raw.close();raw=undefined;
      store=new Store(path);store.close();store=undefined;raw=new Database(path);
      raw.prepare('INSERT INTO actions VALUES(?,?,?,?)').run('a','p','personal','{}');
      expect(raw.pragma('integrity_check',{simple:true})).toBe('ok');
    }finally{raw?.close();store?.close();rmSync(root,{recursive:true,force:true});}
  });
  it.each((['binding','root'] as const).flatMap(index=>(['columns','predicate'] as const).map(kind=>({index,kind}))))('rejects a same-name $index $kind collision without dropping either definition',({index,kind})=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-migration-collision-')),path=join(root,'store.sqlite');let raw:Database.Database|undefined;
    const canonical=index==='binding'?legacyBinding:legacyRoot,collision=kind==='columns'?canonical.replace('project_id,domain,','domain,project_id,'):canonical+" AND project_id <> ''";
    const binding=index==='binding'?collision:legacyBinding,byRoot=index==='root'?collision:legacyRoot;
    try{
      legacyDatabase(path,binding,byRoot);expect(()=>new Store(path)).toThrow('Unexpected legacy index definition');
      raw=new Database(path);registerLegacyFunction(raw);
      expect(raw.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN ('actions_host_binding_key','actions_host_root_key') ORDER BY name").all()).toEqual([{name:'actions_host_binding_key',sql:binding},{name:'actions_host_root_key',sql:byRoot}]);
      raw.prepare('INSERT INTO actions VALUES(?,?,?,?)').run('a','p','personal','{}');expect(raw.pragma('integrity_check',{simple:true})).toBe('ok');
    }finally{raw?.close();rmSync(root,{recursive:true,force:true});}
  });
  it('backs up and restores a migrated copy for the genuine prior Store and raw full integrity',async()=>{
    const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
    const root=mkdtempSync(join(projectRoot,'.patrick-prior-store-')),path=join(root,'store.sqlite');let store:Store|undefined,raw:Database.Database|undefined;
    try{
      // Verbatim prior Store from knowledge-experience-g6-fix5-before/src/store.ts, SHA-256 654b779cefa77d20248aef546821a9dec1acee3359aff131a4a5e9017f6e0132.
      const original=readFileSync(new URL('../fixtures/legacy-store.ts.fixture',import.meta.url),'utf8');
      expect(createHash('sha256').update(original).digest('hex')).toBe('654b779cefa77d20248aef546821a9dec1acee3359aff131a4a5e9017f6e0132');
      let rewritten=0;const prior=original.replace(/from '(\.\/[^']+)\.js'/g,(_all,name:string)=>{rewritten++;return `from '${pathToFileURL(join(projectRoot,'src',name.slice(2)+'.ts')).href}'`;});expect(rewritten).toBe(7);
      const priorPath=join(root,'prior-store.ts'),childPath=join(root,'rollback-child.ts');writeFileSync(priorPath,prior);
      writeFileSync(childPath,`import {Store} from ${JSON.stringify(pathToFileURL(priorPath).href)};\nconst store=new Store(process.argv[2]!);const row={id:'rollback-action',projectId:'p',domain:'personal',kind:'unrelated',status:'completed',payload:{},updatedAt:''} as const;store.save('actions',row);store.save('actions',{...row,payload:{changed:true}});store.delete('actions',row.id);store.close();\n`);
      legacyDatabase(path);store=new Store(path);
      const snapshot=join(root,'snapshot'),destination=join(root,'restored');await createBackup(store,snapshot,{mode:'test'});store.close();store=undefined;
      expect(verifyBackup(snapshot).files.some(file=>file.path==='patrick.db')).toBe(true);
      restoreBackup({snapshot,destination,writerRevoked:true,reconciled:true});const restoredPath=join(destination,'patrick.db');
      raw=new Database(restoredPath);expect(raw.pragma('integrity_check',{simple:true})).toBe('ok');raw.close();raw=undefined;
      const tsx=pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const child=spawnSync(process.execPath,['--import',tsx,childPath,restoredPath],{encoding:'utf8',cwd:root});
      expect({status:child.status,signal:child.signal,stderr:child.stderr}).toEqual({status:0,signal:null,stderr:''});
      raw=new Database(restoredPath);expect(raw.pragma('integrity_check',{simple:true})).toBe('ok');
      raw.prepare('INSERT INTO actions VALUES(?,?,?,?)').run('raw','p','personal','{}');raw.prepare('DELETE FROM actions WHERE id=?').run('raw');
      expect(raw.prepare("SELECT sql FROM sqlite_schema WHERE sql LIKE '%knowledge_host_root_key%'").all()).toEqual([]);
      console.info('g6-prior-store-rollback',JSON.stringify({status:child.status,signal:child.signal,stdout:child.stdout,stderr:child.stderr,rewritten}));
    }finally{raw?.close();store?.close();rmSync(root,{recursive:true,force:true});}
  });
  it('removes the exact registered-function indexes so an unregistered connection can write and run full integrity',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-migrate-')),path=join(root,'store.sqlite');
    const binding="CREATE INDEX actions_host_binding_key ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.sourceHash'),json_extract(data,'$.payload.requestHash'),json_extract(data,'$.payload.observation.claim.kind'),knowledge_host_root_key(data)) WHERE json_extract(data,'$.kind') = 'knowledge.host-observation'";
    const byRoot="CREATE INDEX actions_host_root_key ON actions(json_extract(data,'$.kind'),project_id,domain,knowledge_host_root_key(data)) WHERE json_extract(data,'$.kind') = 'knowledge.host-observation'";
    let legacy:Database.Database|undefined,raw:Database.Database|undefined,store:Store|undefined;
    try{
      legacy=new Database(path);
      legacy.function('knowledge_host_root_key',{deterministic:true},(data:string)=>{const root=JSON.parse(data)?.payload?.observation?.origin?.originalEventId;return typeof root==='string'&&root.length>0&&root.length<=10000?Buffer.from(root,'utf16le'):null;});
      legacy.exec('CREATE TABLE actions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, domain TEXT NOT NULL, data TEXT NOT NULL)');
      legacy.exec(binding);legacy.exec(byRoot);
      expect(legacy.prepare("SELECT sql FROM sqlite_schema WHERE name = 'actions_host_binding_key'").get()).toEqual({sql:binding});
      expect(legacy.prepare("SELECT sql FROM sqlite_schema WHERE name = 'actions_host_root_key'").get()).toEqual({sql:byRoot});
      legacy.close();legacy=undefined;
      raw=new Database(path);
      expect(()=>raw!.prepare('INSERT INTO actions VALUES(?,?,?,?)').run('a','p','personal','{}')).toThrow(/unknown function/);
      expect(()=>raw!.pragma('integrity_check')).toThrow(/unknown function/);
      raw.close();raw=undefined;
      store=new Store(path);store.close();store=undefined;
      raw=new Database(path);
      raw.prepare('INSERT INTO actions VALUES(?,?,?,?)').run('a','p','personal','{}');
      raw.prepare('UPDATE actions SET data=? WHERE id=?').run('{"updated":true}','a');
      raw.prepare('DELETE FROM actions WHERE id=?').run('a');
      expect(raw.pragma('integrity_check',{simple:true})).toBe('ok');
      expect(raw.prepare("SELECT sql FROM sqlite_schema WHERE sql LIKE '%knowledge_host_root_key%'").all()).toEqual([]);
    }finally{legacy?.close();raw?.close();store?.close();rmSync(root,{recursive:true,force:true});}
  });
  it('rolls back a real deferred WAL snapshot upgrade and reports retryable knowledge unavailability',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-upgrade-')),path=join(root,'store.sqlite');
    const project:Project={id:'p',projectId:'p',domain:'personal',name:'P',description:'',repository:'owner/repo',repositoryProvider:'github',prdPath:'docs/PRD.md',allowedPaths:['docs/'],trustedChecks:[],trustedAppIds:[],ownerId:'owner',autoMerge:false,budgetUsd:0,createdAt:''};
    let store:Store|undefined,raw:Database.Database|undefined;
    try{
      store=new Store(path);store.save('projects',project);raw=new Database(path);
      expect(()=>store!.transaction(()=>{
        expect(store!.get('projects','p')?.name).toBe('P');
        const external={...project,id:'external',projectId:'external'};
        raw!.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(external.id,external.projectId,external.domain,JSON.stringify(external));
        store!.save('projects',{...project,name:'uncommitted'});
      })).toThrowError(expect.objectContaining({code:'knowledge_snapshot_unavailable',status:503}));
      expect(store.get('projects','p')?.name).toBe('P');
      expect(store.get('projects','external')).toBeDefined();
      store.transaction(()=>store!.save('projects',{...project,name:'recovered'}));
      expect(store.get('projects','p')?.name).toBe('recovered');
    }finally{raw?.close();store?.close();rmSync(root,{recursive:true,force:true});}
  });
  it('pins host discovery for one read snapshot and drops groups before the next operation',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-read-snapshot-')),path=join(root,'store.sqlite');
    let store:Store|undefined,raw:Database.Database|undefined;
    try{
      store=new Store(path);raw=new Database(path);
      raw.function('knowledge_host_root_key',{deterministic:true},(data:string)=>{const root=JSON.parse(data)?.payload?.observation?.origin?.originalEventId;return typeof root==='string'&&root.length>0&&root.length<=10000?Buffer.from(root,'utf16le'):null;});
      const row={id:'host',projectId:'p',domain:'personal',kind:'knowledge.host-observation',status:'completed',payload:{observation:{origin:{originalEventId:'root'}}},updatedAt:''};
      raw.prepare('INSERT INTO actions VALUES(?,?,?,?)').run(row.id,row.projectId,row.domain,JSON.stringify(row));
      store.readSnapshot(()=>{
        expect(store!.hostObservationRootActions({projectId:'p',domain:'personal'},'root').map(value=>value.id)).toEqual(['host']);
        raw!.prepare('DELETE FROM actions WHERE id=?').run('host');
        expect(store!.hostObservationRootActions({projectId:'p',domain:'personal'},'root').map(value=>value.id)).toEqual(['host']);
      });
      expect(store.hostObservationRootActions({projectId:'p',domain:'personal'},'root')).toEqual([]);
    }finally{raw?.close();store?.close();rmSync(root,{recursive:true,force:true});}
  });
  it('does not use equal data_version returns as a cross-operation cache identity',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-version-reuse-')),path=join(root,'store.sqlite'),store=new Store(path),raw=new Database(path);
    try{
      const scope={projectId:'p',domain:'personal'},row={id:'new-host',...scope,kind:'knowledge.host-observation',status:'completed',payload:{observation:{origin:{originalEventId:'root'}}},updatedAt:''};
      const db=(store as any).db,pragma=db.pragma.bind(db),spy=vi.spyOn(db,'pragma').mockImplementation((...args:unknown[])=>{const result=pragma(...args);return args[0]==='main.data_version'?[{data_version:7}]:result;});
      try{
        expect(store.hostObservationRootActions(scope,'root')).toEqual([]);
        raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)').run(row.id,row.projectId,row.domain,JSON.stringify(row));
        expect(store.hostObservationRootActions(scope,'root').map(value=>value.id)).toContain(row.id);
      }finally{spy.mockRestore();}
    }finally{raw.close();store.close();rmSync(root,{recursive:true,force:true});}
  });
  it('rejects snapshot mutation, thenables and untracked transactions without copying or flushing write state',()=>{
    const store=new Store(':memory:');try{
      const temporary=(store as any).temporary as Map<string,unknown>,iterate=vi.spyOn(temporary,Symbol.iterator),flush=vi.spyOn(store as any,'flushVault');
      expect(store.readSnapshot(()=>store.get('projects','missing'))).toBeUndefined();expect(iterate).not.toHaveBeenCalled();expect(flush).not.toHaveBeenCalled();
      expect(()=>store.readSnapshot(()=>store.delete('actions','x'))).toThrow('cannot mutate');
      expect(()=>store.readSnapshot(()=>Promise.resolve('no'))).toThrow('must be synchronous');
      const db=(store as any).db;db.exec('BEGIN');try{expect(()=>store.readSnapshot(()=>1)).toThrow('Untracked Store transaction');}finally{db.exec('ROLLBACK');}
      expect((store as any).operation).toBeUndefined();iterate.mockRestore();flush.mockRestore();
    }finally{store.close();}
  });
});

async function seedCi(f:ReturnType<typeof repositoryKnowledgeFixture>,run:number,job:number,check:number,result:'success'|'failure',eventAt:string|null,readAt:string){
  vi.setSystemTime(new Date(readAt));
  const input=JSON.parse(envelope(f.project.id,f.project.repository));input.runId=String(run);input.jobId=String(job);
  const source={...f.source,id:`ci-${run}`,externalId:`ci-${run}`,content:JSON.stringify(input)};f.store.save('sources',source);
  const runRoute=f.routes['/actions/runs/52'],jobRoute=f.routes['/actions/runs/52/jobs'],checkRoute=f.routes['/check-runs/99'];
  f.routes[`/actions/runs/${run}`]={...runRoute,id:run,conclusion:result,html_url:`https://github.com/owner/repo/actions/runs/${run}`};
  f.routes[`/actions/runs/${run}/jobs`]={...jobRoute,jobs:[{...jobRoute.jobs[0],id:job,run_id:run,conclusion:result,completed_at:eventAt,check_run_url:`https://api.github.com/repos/owner/repo/check-runs/${check}`}]};
  f.routes[`/check-runs/${check}`]={...checkRoute,id:check,conclusion:result,completed_at:eventAt,html_url:`https://github.com/owner/repo/runs/${check}`};
  expect(await ingestStructuredExperience(f.store,f.reader,source.id,new AbortController().signal)).toBe(true);
  const row=f.store.list('actions').find(value=>value.kind==='experience.test-observation'&&(value.payload.observation as TestObservation|undefined)?.sourceId===source.id)!;
  const card=f.store.list('cards').find(value=>value.kind==='experience'&&value.sourceId===source.id)!;
  return {row,card};
}

describe('historical experience projection',()=>{
  it('allows WAL readers and an uncommitted writer to coexist in both directions',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-wal-')),path=join(dir,'store.sqlite'),seed=repositoryKnowledgeFixture('gitlab'),project=seed.project;seed.close();
    const store=new Store(path),f=repositoryKnowledgeFixture('gitlab',{store,project});let raw:Database.Database|undefined,engine:Workbench|undefined;
    try{
      f.source.content=envelope(project.id,project.repository);store.save('sources',f.source);expect(await ingestStructuredExperience(store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];config.ownerId=project.ownerId;
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});const app=createApp({store,config,engine});
      raw=new Database(path);raw.exec('BEGIN IMMEDIATE');raw.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...project,name:'uncommitted'}),project.id);
      expect(store.searchCards('cache misses',project)).toHaveLength(1);
      const response=await app.request(`/api/lookup?project=${project.id}&domain=${project.domain}&q=cache`);expect(response.status).toBe(200);expect((await response.json()).cards).toHaveLength(1);
      raw.exec('ROLLBACK');
      store.readSnapshot(()=>{
        expect(store.get('projects',project.id)?.name).toBe(project.name);
        raw!.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...project,name:'committed'}),project.id);
        expect(store.get('projects',project.id)?.name).toBe(project.name);
      });
      expect(store.get('projects',project.id)?.name).toBe('committed');
    }finally{await engine?.shutdown();raw?.close();store.close();rmSync(dir,{recursive:true,force:true});}
  });
  it.each(['SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_SCHEMA'])('returns a complete 503 for %s after an intermediate candidate and recovers',async code=>{
    const f=repositoryKnowledgeFixture();let engine:Workbench|undefined;
    try{
      f.source.content=envelope(f.project.id,f.project.repository);f.store.save('sources',f.source);expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const existing=f.store.list('cards').find(card=>card.kind==='experience')!;
      publishKnowledge(f.store,f.source,{cards:[1,2,3].map(i=>({title:`cache misses ${i}`,body:'cache misses',quote:'Resolution report',aliases:['cache misses'],kind:'experience',verification:'reported',experience:existing.experience}))});
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.ownerId=f.project.ownerId;
      engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch});const app=createApp({store:f.store,config,engine});
      const before=f.store.list('actions'),get=f.store.get.bind(f.store),seen=new Set<string>();let injected=false;
      const spy=vi.spyOn(f.store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
        if(args[0]==='cards'&&new Error().stack?.includes('searchCardsInSnapshot')){seen.add(args[1]);if(seen.size===2&&!injected){injected=true;throw Object.assign(new Error('SQLite snapshot failure'),{code});}}
        return get(...args);
      }) as typeof f.store.get);
      const url=`/api/lookup?project=${f.project.id}&domain=${f.project.domain}&q=cache`;
      try{const response=await app.request(url);expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'Knowledge temporarily unavailable; retry.',code:'knowledge_snapshot_unavailable'});expect(injected).toBe(true);}finally{spy.mockRestore();}
      expect(f.store.list('actions')).toEqual(before);
      const recovered=await app.request(url);expect(recovered.status).toBe(200);expect((await recovered.json()).cards.length).toBeGreaterThan(1);
    }finally{await engine?.shutdown();f.close();}
  });
  it('keeps all retained hosts in one snapshot across external deletion, then observes it next time',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-multihost-')),path=join(dir,'store.sqlite'),seed=repositoryKnowledgeFixture('gitlab'),project=seed.project;seed.close();
    const store=new Store(path),f=repositoryKnowledgeFixture('gitlab',{store,project});let raw:Database.Database|undefined;
    try{
      const input=JSON.parse(envelope(project.id,project.repository));input.testReportPath=reportPath;f.source.content=JSON.stringify(input);store.save('sources',f.source);
      expect(await ingestStructuredExperience(store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const observation=store.list('actions').find(action=>action.kind==='experience.test-observation')!,hostIds=observation.payload.hostObservationIds as string[];
      expect(hostIds.length).toBeGreaterThanOrEqual(2);
      const removed=store.get('actions',hostIds[1]!)!,card=store.list('cards').find(value=>value.sourceId===f.source.id&&value.kind==='experience')!;
      raw=new Database(path);const insert=raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)');
      const scenarios=[
        ()=>expect(readTestObservationWithTimes(store,observation.id,project)).toBeDefined(),
        ()=>expect(experienceReference(store,card,project)).toMatchObject({eligible:true}),
        ()=>expect(store.searchCards('cache misses',project).some(value=>value.id===card.id)).toBe(true),
      ];
      for(const run of scenarios){
        const get=store.get.bind(store);let deleted=false;
        const spy=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
          const value=get(...args);
          if(!deleted&&args[0]==='actions'&&args[1]===hostIds[0]&&new Error().stack?.includes('readHostObservationBody')){deleted=true;raw!.prepare('DELETE FROM actions WHERE id=?').run(removed.id);}
          return value;
        }) as typeof store.get);
        try{run();expect(deleted).toBe(true);}finally{spy.mockRestore();}
        expect(readTestObservationWithTimes(store,observation.id,project)).toBeUndefined();
        expect(store.searchCards('cache misses',project)).toEqual([]);
        insert.run(removed.id,removed.projectId,removed.domain,JSON.stringify(removed));
      }
    }finally{raw?.close();store.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('links a resolution with a named authenticated CI check without a local run or delivery',async()=>{
    const f=repositoryKnowledgeFixture();try{
      f.source.content=envelope(f.project.id,f.project.repository);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const row=f.store.list('actions').find(action=>action.kind==='experience.test-observation')!;
      expect(readTestObservation(f.store,row.id,f.project)).toBeDefined();
      expect(f.store.list('actions').some(action=>action.kind==='experience.evidence-link')).toBe(true);
      const card=f.store.searchCards('cache misses',f.project).find(value=>value.kind==='experience');
      expect(card).toMatchObject({experienceReference:{label:'historical-test-backed-reference',reportedSolution:{text:'Clear the cache',status:'reported'},observed:[{observationId:expect.any(String),observedAt:expect.any(String),evidenceLocator:'https://github.com/owner/repo/runs/99',checks:[{id:'github-check-run:99',result:'success'}],snapshot:{revision:H},environment:{unknown:expect.any(Array)}}],currentApplicability:{status:'unknown'}}});
      expect(f.store.list('attempts')).toEqual([]);expect(f.store.list('receipts')).toEqual([]);
      expect(await ingestStructuredExperience(f.store,undefined,f.source.id,new AbortController().signal)).toBe(true);
      expect(f.store.searchCards('cache misses',f.project)[0]?.experienceReference?.observationIds).toEqual([row.id]);
    }finally{f.close();}
  });
  it('reports a later independently authorized CI rerun failure, but not an unrelated failure',async()=>{
    const f=repositoryKnowledgeFixture();vi.useFakeTimers({toFake:['Date']});
    try{
      vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
      f.source.content=envelope(f.project.id,f.project.repository);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const original=f.store.searchCards('cache misses',f.project)[0]!;
      const rerun=async(run:number,job:number,check:number,problem:string)=>{
        const input=JSON.parse(envelope(f.project.id,f.project.repository));input.runId=String(run);input.jobId=String(job);input.details.problem=problem;
        const source={...f.source,id:`later-${run}`,externalId:`later-${run}`,content:JSON.stringify(input)};f.store.save('sources',source);
        const runRoute=f.routes['/actions/runs/52'],jobRoute=f.routes['/actions/runs/52/jobs'],checkRoute=f.routes['/check-runs/99'];
        f.routes[`/actions/runs/${run}`]={...runRoute,id:run,conclusion:'failure',html_url:`https://github.com/owner/repo/actions/runs/${run}`};
        f.routes[`/actions/runs/${run}/jobs`]={...jobRoute,jobs:[{...jobRoute.jobs[0],id:job,run_id:run,conclusion:'failure',check_run_url:`https://api.github.com/repos/owner/repo/check-runs/${check}`}]};
        f.routes[`/check-runs/${check}`]={...checkRoute,id:check,conclusion:'failure',completed_at:new Date().toISOString(),html_url:`https://github.com/owner/repo/runs/${check}`};
        expect(await ingestStructuredExperience(f.store,f.reader,source.id,new AbortController().signal)).toBe(true);
        return f.store.list('actions').find(row=>row.kind==='experience.test-observation'&&row.payload.observation&&typeof row.payload.observation==='object'&&(row.payload.observation as TestObservation).sourceId===source.id)!;
      };
      vi.setSystemTime(new Date('2026-11-04T13:00:00Z'));await rerun(53,72,100,'unrelated lint');
      expect(f.store.searchCards('cache misses',f.project).find(card=>card.id===original.id)?.experienceReference?.currentApplicability.status).toBe('unknown');
      vi.setSystemTime(new Date('2026-11-04T14:00:00Z'));const later=await rerun(54,73,101,'cache misses');
      expect(f.store.searchCards('cache misses',f.project).find(card=>card.id===original.id)?.experienceReference).toMatchObject({observationIds:original.experienceReference!.observationIds,currentApplicability:{status:'needs-revalidation',evidenceIds:[later.id],reasons:expect.arrayContaining([expect.stringContaining('2026-11-04T14:00:00')])}});
    }finally{vi.useRealTimers();f.close();}
  });

  it('orders CI failures by completion rather than by host read time',async()=>{
    const f=repositoryKnowledgeFixture();vi.useFakeTimers({toFake:['Date']});
    try{
      const success=await seedCi(f,53,72,100,'success','2026-11-04T12:00:00Z','2026-11-04T14:00:00Z');
      await seedCi(f,54,73,101,'failure','2026-11-04T11:00:00Z','2026-11-04T15:00:00Z');
      expect(experienceReference(f.store,success.card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[]},observed:[{observedAt:'2026-11-04T14:00:00.000Z',eventAt:'2026-11-04T12:00:00Z',timeBasis:'provider-completion'}]}});
      const later=await seedCi(f,55,74,102,'failure','2026-11-04T13:00:00Z','2026-11-04T10:00:00Z');
      expect(experienceReference(f.store,success.card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:[later.row.id],reasons:expect.arrayContaining([expect.stringContaining('2026-11-04T13:00:00Z')])}}});
    }finally{vi.useRealTimers();f.close();}
  });

  it('keeps CI ordering unknown when a related completion time is absent',async()=>{
    const f=repositoryKnowledgeFixture();vi.useFakeTimers({toFake:['Date']});
    try{
      const success=await seedCi(f,53,72,100,'success','2026-11-04T12:00:00Z','2026-11-04T14:00:00Z');
      const failure=await seedCi(f,54,73,101,'failure',null,'2026-11-04T15:00:00Z');
      expect(experienceReference(f.store,success.card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',reasons:expect.arrayContaining([expect.stringContaining('execution order is unknown')]),evidenceIds:[failure.row.id]}}});
    }finally{vi.useRealTimers();f.close();}
  });

  it('requires a fresh CI completion for current applicability and retains the read time separately',async()=>{
    const f=repositoryKnowledgeFixture();vi.useFakeTimers({toFake:['Date']});
    try{
      const success=await seedCi(f,53,72,100,'success','2026-11-04T07:00:00-05:00','2026-11-04T14:00:00Z');
      const context={projectId:f.project.id,domain:f.project.domain,repository:f.project.repository,revision:H,environment:{},observedAt:'2026-11-04T13:00:00Z'};
      expect(experienceReference(f.store,success.card,f.project,context)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown'},observed:[{observedAt:'2026-11-04T14:00:00.000Z',eventAt:'2026-11-04T07:00:00-05:00',timeBasis:'provider-completion'}]}});
      expect(experienceReference(f.store,success.card,f.project,{...context,observedAt:'2026-11-04T11:59:00Z'})).toMatchObject({eligible:true,reference:{currentApplicability:{status:'checked',evidenceIds:[success.row.id]}}});
      const unknown=await seedCi(f,54,73,101,'success',null,'2026-11-04T15:00:00Z');
      expect(experienceReference(f.store,unknown.card,f.project,context)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown'},observed:[{observedAt:'2026-11-04T15:00:00.000Z',timeBasis:'unknown'}]}});
    }finally{vi.useRealTimers();f.close();}
  });
  it('recognizes source-reported structured solutions with JSON-escaped characters',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const input=JSON.parse(envelope(f.project.id,f.project.repository));input.details.solution='Clear "cache"\nthen retry';
      f.source.content=JSON.stringify(input);f.store.save('sources',f.source);
      expect(f.source.content).not.toContain(input.details.solution);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      expect(f.store.searchCards('cache misses',f.project)[0]?.experienceReference?.reportedSolution).toEqual({text:input.details.solution,status:'reported'});
    }finally{f.close();}
  });
  it('keeps a candidate visible for browse but out of reference while evidence is missing',async()=>{
    const f=repositoryKnowledgeFixture();try{
      f.source.content=envelope(f.project.id,f.project.repository);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,undefined,f.source.id,new AbortController().signal)).toBe(false);
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
      expect(f.store.searchCards('cache misses',f.project,20,{usage:'browse'})).toMatchObject([{experienceState:{state:'pending'}}]);
    }finally{f.close();}
  });
  it('shows pending descriptions in state and both knowledge pages but never honors lookup browse overrides',async()=>{
    const f=repositoryKnowledgeFixture();const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.ownerId=f.project.ownerId;
    const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch});
    try{
      f.source.content=envelope(f.project.id,f.project.repository);f.store.save('sources',f.source);
      await ingestStructuredExperience(f.store,undefined,f.source.id,new AbortController().signal);
      const app=createApp({store:f.store,config,engine});
      const state=await (await app.request(`/api/state?project=${f.project.id}`)).json();
      expect(state.cards.find((card:{kind:string})=>card.kind==='experience')).toMatchObject({experienceState:{state:'pending'}});
      const lookup=await (await app.request(`/api/lookup?project=${f.project.id}&domain=${f.project.domain}&q=cache%20misses&usage=browse`)).json();
      expect(lookup.cards).toEqual([]);
      for(const path of [`/knowledge?project=${f.project.id}`,`/knowledge?project=${f.project.id}&q=cache%20misses`]){
        const html=await (await app.request(path)).text();expect(html).toContain('待补充相关依据');expect(html).toContain('缺少明确关联此问题、文件和检查的来源');
      }
    }finally{await engine.shutdown();f.close();}
  });

  it('passes historical labels to lookup, knowledge pages and worker context',async()=>{
    const f=repositoryKnowledgeFixture();f.project.budgetUsd=10;f.store.save('projects',f.project);const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.ownerId=f.project.ownerId;
    const worker=new DemoWorker('grok');let cards:unknown;
    const engine=new Workbench({store:f.store,config,workers:[{name:'grok',async run(input){cards=input.cards;return worker.run(input);}}],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
    try{
      f.source.content=envelope(f.project.id,f.project.repository);f.store.save('sources',f.source);
      await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal);
      const app=createApp({store:f.store,config,engine});
      const lookup=await (await app.request(`/api/lookup?project=${f.project.id}&domain=${f.project.domain}&q=cache%20misses`)).json();
      expect(lookup.cards).toMatchObject([{experienceReference:{label:'historical-test-backed-reference',reportedSolution:{status:'reported'}}}]);
      for(const path of [`/knowledge?project=${f.project.id}`,`/knowledge?project=${f.project.id}&q=cache%20misses`]){
        const html=await (await app.request(path)).text();expect(html).toContain('历史测试依据');expect(html).toContain('github-check-run:99');expect(html).toContain('当前适用性');expect(html).toContain('读取或观察时间');expect(html).toContain('检查执行时间');expect(html).toContain('提供方完成时间');
      }
      const stored=f.store.list('cards').find(card=>card.kind==='experience')!;f.store.save('cards',{...stored,verification:'inference'});
      const inferred=await (await app.request(`/api/lookup?project=${f.project.id}&domain=${f.project.domain}&q=cache%20misses`)).json();
      expect(inferred.cards).toMatchObject([{experienceReference:{reportedSolution:{status:'inference'}}}]);
      const inferredPage=await (await app.request(`/knowledge?project=${f.project.id}&q=cache%20misses`)).text();expect(inferredPage).toContain('解决方式为推论');
      const task=engine.ingest({projectId:f.project.id,externalId:'followup',title:'cache misses',content:'cache misses',purpose:'task'})!;await engine.tick();
      expect(f.store.get('tasks',task.id)?.error).toBeUndefined();
      expect(cards).toEqual(expect.arrayContaining([expect.objectContaining({experienceReference:expect.objectContaining({label:'historical-test-backed-reference',reportedSolution:expect.objectContaining({status:'inference'})})})]));
    }finally{await engine.shutdown();f.close();}
  });

  it('propagates inferred provenance for a rejected source solution through lookup, page and worker context',async()=>{
    const f=repositoryKnowledgeFixture();f.project.budgetUsd=10;const command='npm test -- docs/test.ts';f.project.trustedChecks=[command];f.store.save('projects',f.project);
    const quote=relations({problem:'cache misses',files:[measured.path],checks:[command]});f.source.content=`${quote}\nDo not Clear the cache; it deletes data.`;f.store.save('sources',f.source);
    const task:Task={id:'local-task',projectId:'p',domain:'personal',sourceId:f.source.id,sourceRevision:f.source.revision,title:'task',description:quote,status:'delivered',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:1,repairCount:0,budgetUsd:0,spentUsd:0,stage:'feedback'};f.store.save('tasks',task);
    const attempt:Attempt={id:'local-attempt',projectId:'p',domain:'personal',taskId:task.id,taskVersion:1,role:'execute',runner:'codex',provider:'fixture',model:'fixture',inputHash:'a'.repeat(64),status:'succeeded',costUsd:0,startedAt:''};f.store.save('attempts',attempt);
    const origin:Extract<TestObservation['origin'],{kind:'local'}>={kind:'local',taskId:task.id,taskVersion:1,attemptId:attempt.id,inputHash:attempt.inputHash,planHash:'b'.repeat(64),artifactHash:'c'.repeat(64),role:'execute',runId:'local-run'};
    const observation:TestObservation={schemaVersion:1,id:'',projectId:'p',domain:'personal',sourceId:f.source.id,sourceRevision:f.source.revision,repository:f.project.repository,observedAt:'2026-11-04T12:00:00Z',snapshot:{revision:H,files:[measured]},checks:[{id:stableId('local-check',command),command,testFile:measured.path,result:'success',outputDigest:'d'.repeat(64)}],environment:{observed:{},unknown:['browser']},origin};
    observation.id=stableId('local-test-observation',origin.runId,digest(origin),digest(observation));
    const accepted={attemptId:attempt.id,taskId:task.id,taskVersion:1,role:'execute' as const,runner:attempt.runner,provider:attempt.provider,model:attempt.model,inputHash:attempt.inputHash,outputHash:'e'.repeat(64),planHash:origin.planHash,artifactHash:origin.artifactHash,runId:origin.runId,sourceHash:digest(f.source),policyHash:knowledgePolicyHash(f.project)};
    f.store.save('actions',{id:observation.id,projectId:'p',domain:'personal',taskId:task.id,kind:'experience.test-observation',status:'completed',payload:{schemaVersion:1,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted),sourceRefs:[{id:f.source.id,revision:f.source.revision}]},updatedAt:observation.observedAt});
    const [card]=publishKnowledge(f.store,f.source,{cards:[{title:'cache misses',body:'cache misses',quote,aliases:['cache'],kind:'experience',verification:'reported',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[measured.path],productId:f.project.id,codeVersion:H,environment:'unknown',invalidationConditions:['changes']}}]});
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.ownerId=f.project.ownerId;
    const worker=new DemoWorker('grok');let cards:unknown;
    const engine=new Workbench({store:f.store,config,workers:[{name:'grok',async run(input){cards=input.cards;return worker.run(input);}}],writer:demoWriter,research:demoResearch});
    try{
      const app=createApp({store:f.store,config,engine});
      const lookup=await (await app.request(`/api/lookup?project=${f.project.id}&domain=${f.project.domain}&q=cache%20misses`)).json();
      expect(lookup.cards).toMatchObject([{id:card!.id,experienceReference:{reportedSolution:{text:'Clear the cache',status:'inference'}}}]);
      const page=await (await app.request(`/knowledge?project=${f.project.id}&q=cache%20misses`)).text();expect(page).toContain('解决方式为推论');
      engine.ingest({projectId:f.project.id,externalId:'provenance-followup',title:'cache misses',content:'cache misses',purpose:'task'});await engine.tick();
      expect(cards).toEqual(expect.arrayContaining([expect.objectContaining({id:card!.id,experienceReference:expect.objectContaining({reportedSolution:{text:'Clear the cache',status:'inference'}})})]));
    }finally{await engine.shutdown();f.close();}
  });

  it('preserves structured identity, expiry and source text when binding an unknown version',async()=>{
    const f=repositoryKnowledgeFixture();try{
      f.source.content=envelope(f.project.id,f.project.repository,'unknown');f.store.save('sources',f.source);const sourceText=f.source.content;
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const card=f.store.list('cards').find(value=>value.kind==='experience')!;
      expect(card.id).toMatch(/^knowledge-structured-card:/);expect(card.experience?.codeVersion).toBe(H);expect(f.store.get('sources',f.source.id)?.content).toBe(sourceText);
      expect(f.store.searchCards('cache misses',f.project)[0]?.experienceReference).toMatchObject({versionBinding:{reported:'unknown',observedRevision:H}});
      expect(f.store.searchCards('cache misses',f.project)[0]?.experienceReference?.currentApplicability.reasons.join(' ')).toContain('reported an unknown version');
      const deadline=new Date(Date.now()+60_000).toISOString();f.store.save('cards',{...card,expiresAt:deadline});
      const job=f.store.list('actions').find(value=>value.kind==='knowledge.structured-ingest')!;f.store.delete('actions',job.id);
      expect(f.store.get('cards',card.id)).toMatchObject({status:'withdrawn',expiresAt:deadline});
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      expect(f.store.get('cards',card.id)).toMatchObject({status:'active',expiresAt:deadline,experience:{codeVersion:H}});
      expect(f.store.get('sources',f.source.id)?.content).toBe(sourceText);
      expect(f.store.searchCards('cache misses',f.project)[0]?.experienceReference?.versionBinding).toEqual({reported:'unknown',observedRevision:H});
    }finally{f.close();}
  });

  it('excludes a pending same-source experience from worker input',async()=>{
    const f=repositoryKnowledgeFixture();f.project.budgetUsd=10;f.store.save('projects',f.project);const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.ownerId=f.project.ownerId;
    const worker=new DemoWorker('grok');let cards:unknown;
    const engine=new Workbench({store:f.store,config,workers:[{name:'grok',async run(input){cards=input.cards;return worker.run(input);}}],writer:demoWriter,research:demoResearch});
    try{
      const task=engine.ingest({projectId:f.project.id,externalId:'same-source',title:'cache misses',content:'cache misses',purpose:'task'})!;
      const source=f.store.get('sources',task.sourceId)!;
      const [card]=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:'cache misses',aliases:['cache'],kind:'experience',verification:'reported',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:['docs/test.ts'],productId:f.project.id,codeVersion:H,environment:'unknown',invalidationConditions:['changes']}}]});
      await engine.tick();expect(cards).toBeDefined();expect(JSON.stringify(cards)).not.toContain(card!.id);
    }finally{await engine.shutdown();f.close();}
  });

  it.each(['superseded','withdrawn'] as const)('redacts a %s relevance-record link without erasing an independent retained alternative',status=>{
    // Both local records below are seeded retained G3 fixtures, not new executions.
    const f=repositoryKnowledgeFixture();try{
      const command='npm test -- docs/test.ts',quote=relations({problem:'cache misses',files:[measured.path],checks:[command]});
      f.project.trustedChecks=[command];f.store.save('projects',f.project);f.source.content=quote;f.store.save('sources',f.source);
      const ids:string[]=[];const records=[];
      for(const name of ['first','second']){
        const source={...f.source,id:`record-${name}`,externalId:`record-${name}`,locator:`manual:${name}`};f.store.save('sources',source);records.push(source);
        const task:Task={id:`task-${name}`,projectId:'p',domain:'personal',sourceId:source.id,sourceRevision:source.revision,title:name,description:quote,status:'delivered',version:2,createdAt:'',updatedAt:'',runAfter:'',attempts:1,repairCount:0,budgetUsd:0,spentUsd:0,stage:'feedback'};f.store.save('tasks',task);
        const attempt:Attempt={id:`attempt-${name}`,projectId:'p',domain:'personal',taskId:task.id,taskVersion:1,role:'execute',runner:'codex',provider:'fixture',model:'fixture',inputHash:'a'.repeat(64),status:'succeeded',costUsd:0,startedAt:''};f.store.save('attempts',attempt);
        const origin:Extract<TestObservation['origin'],{kind:'local'}>={kind:'local',taskId:task.id,taskVersion:1,attemptId:attempt.id,inputHash:attempt.inputHash,planHash:'b'.repeat(64),artifactHash:'c'.repeat(64),role:'execute',runId:`run-${name}`};
        const observation:TestObservation={schemaVersion:1,id:'',projectId:'p',domain:'personal',sourceId:source.id,sourceRevision:source.revision,repository:f.project.repository,observedAt:name==='first'?'2026-11-04T12:00:00Z':'2026-11-04T13:00:00Z',snapshot:{revision:H,files:[measured]},checks:[{id:stableId('local-check',command),command,testFile:measured.path,result:'success',outputDigest:'d'.repeat(64)}],environment:{observed:{},unknown:['browser']},origin};
        observation.id=stableId('local-test-observation',origin.runId,digest(origin),digest(observation));ids.push(observation.id);
        const accepted={attemptId:attempt.id,taskId:task.id,taskVersion:1,role:'execute' as const,runner:attempt.runner,provider:attempt.provider,model:attempt.model,inputHash:attempt.inputHash,outputHash:'e'.repeat(64),planHash:origin.planHash,artifactHash:origin.artifactHash,runId:origin.runId,sourceHash:digest(source),policyHash:knowledgePolicyHash(f.project)};
        f.store.save('actions',{id:observation.id,projectId:'p',domain:'personal',taskId:task.id,kind:'experience.test-observation',status:'completed',payload:{schemaVersion:1,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted),sourceRefs:[{id:source.id,revision:source.revision}]},updatedAt:observation.observedAt});
      }
      const [card]=publishKnowledge(f.store,f.source,{cards:[{title:'cache misses',body:'cache misses',quote,aliases:['cache'],kind:'experience',verification:'reported',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[measured.path],productId:f.project.id,codeVersion:H,environment:'unknown',invalidationConditions:['changes']}}]});
      expect(f.store.searchCards('cache misses',f.project)[0]?.experienceReference?.observationIds).toEqual(ids);
      const first=f.store.list('actions').find(row=>row.kind==='experience.evidence-link'&&JSON.stringify(row.payload).includes(ids[0]!))!;
      invalidateSource(f.store,records[0]!.id,status);
      expect(JSON.stringify(f.store.get('actions',first.id)?.payload)).not.toContain(quote);
      expect(f.store.searchCards('cache misses',f.project)).toMatchObject([{id:card!.id,experienceReference:{observationIds:[ids[1]]}}]);
    }finally{f.close();}
  });

  it('accepts explicit envelope selectors with a retained issue while retaining its full dependency closure',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const issue={...f.source,id:'issue',externalId:'issue',content:'A related issue with no embedded selectors.',locator:'issue:1'};f.store.save('sources',issue);
      const payload=JSON.parse(envelope(f.project.id,f.project.repository));payload.issueId=issue.id;f.source.content=JSON.stringify(payload);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      expect(f.store.searchCards('cache misses',f.project)).toMatchObject([{experienceReference:{label:'historical-test-backed-reference',observed:[{relevance:{recordSourceId:f.source.id,quote:'Resolution report'}}]}}]);
      const link=f.store.list('actions').find(action=>action.kind==='experience.evidence-link')!;
      expect(link.payload.sourceRefs).toEqual(expect.arrayContaining([{id:f.source.id,revision:f.source.revision},{id:issue.id,revision:issue.revision}]));
      invalidateSource(f.store,issue.id,'withdrawn');expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
      expect(JSON.stringify(f.store.get('actions',link.id)?.payload)).not.toContain('Resolution report');
    }finally{f.close();}
  });
  it('uses the structured envelope when unrelated issue clauses happen to contain every slot',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const issue={...f.source,id:'issue-cooccurrence',externalId:'issue-cooccurrence',content:'cache misses remain unresolved. A separate file is docs/test.ts. Another unrelated job is validate.',locator:'issue:cooccurrence'};f.store.save('sources',issue);
      const input=JSON.parse(envelope(f.project.id,f.project.repository));input.issueId=issue.id;f.source.content=JSON.stringify(input);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      expect(f.store.searchCards('cache misses',f.project)).toMatchObject([{experienceReference:{observed:[{relevance:{recordSourceId:f.source.id,quote:'Resolution report'}}]}}]);
      const link=f.store.list('actions').find(action=>action.kind==='experience.evidence-link')!;
      expect(link.payload.sourceRefs).toEqual(expect.arrayContaining([{id:issue.id,revision:issue.revision}]));
      const association=link.payload.association as any,card=f.store.get('cards',association.cardId)!;
      const legacy={...association,relevance:{...association.relevance,recordSourceId:issue.id,recordRevision:issue.revision,quote:issue.content,locator:issue.locator}};
      f.store.delete('actions',link.id);f.store.save('actions',{...link,id:stableId('experience-evidence-link',legacy),payload:{...link.payload,association:legacy,digest:digest(legacy)}});
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:false,state:'invalidated'});
      linkExperienceForCards(f.store,[card]);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{observed:[{relevance:{recordSourceId:f.source.id,quote:'Resolution report'}}]}});
    }finally{f.close();}
  });

});

describe('attested GitLab retained-reader work and invalidation',()=>{
  it('admits GitLab roots without scanning unrelated action rows',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      for(let i=0;i<1200;i++)f.store.save('actions',{id:`root-noise-${i}`,projectId:f.project.id,domain:f.project.domain,kind:'unrelated.fixture',status:'completed',payload:{index:i},updatedAt:''});
      const readback=await f.reader.read(f.project,f.source,f.request,new AbortController().signal);
      const list=vi.spyOn(f.store,'list');
      const ids=acceptRepositoryReadback(f.store,f.source.id,readback);
      const scans=list.mock.calls.filter(call=>call[0]==='actions').length;
      console.info('gitlab-root-work',JSON.stringify({unrelatedActions:1200,wholeActionScans:scans}));
      expect(ids.length).toBeGreaterThan(0);expect(scans).toBe(0);
      list.mockRestore();
    }finally{f.close();}
  });

  it('rejects a contradictory same-root GitLab result across source and request bindings',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      acceptRepositoryReadback(f.store,f.source.id,await f.reader.read(f.project,f.source,f.request,new AbortController().signal));
      const input=JSON.parse(f.source.content);input.changeNumber=18;
      const source={...f.source,id:'other-root-source',externalId:'other-root-source',content:JSON.stringify(input)};f.store.save('sources',source);
      const request={...f.request,changeNumber:18};f.routes['/merge_requests/18']={...f.routes['/merge_requests/17'],iid:18};
      f.routes['/jobs/71'].status='failed';f.routes['/jobs/71'].finished_at='2026-11-04T13:00:00Z';
      const readback=await f.reader.read(f.project,source,request,new AbortController().signal);
      expect(()=>acceptRepositoryReadback(f.store,source.id,readback)).toThrow();
    }finally{f.close();}
  });

  it('allows pending-to-terminal but rejects stale pending across different source and request bindings',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      f.routes['/jobs/71'].status='pending';f.routes['/jobs/71'].finished_at=null;
      const pending=await f.reader.read(f.project,f.source,f.request,new AbortController().signal);
      const stale=await f.reader.read(f.project,f.source,f.request,new AbortController().signal);
      acceptRepositoryReadback(f.store,f.source.id,pending);
      const input=JSON.parse(f.source.content);input.changeNumber=18;
      const source={...f.source,id:'terminal-source',externalId:'terminal-source',content:JSON.stringify(input)};f.store.save('sources',source);
      const request={...f.request,changeNumber:18};f.routes['/merge_requests/18']={...f.routes['/merge_requests/17'],iid:18};
      f.routes['/jobs/71'].status='success';f.routes['/jobs/71'].finished_at='2026-11-04T13:00:00Z';
      const terminal=await f.reader.read(f.project,source,request,new AbortController().signal);
      expect(()=>acceptRepositoryReadback(f.store,source.id,terminal)).not.toThrow();
      expect(()=>acceptRepositoryReadback(f.store,f.source.id,stale)).toThrow();
    }finally{f.close();}
  });

  it('rejects a malformed same-root record from a different source binding',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      const ids=acceptRepositoryReadback(f.store,f.source.id,await f.reader.read(f.project,f.source,f.request,new AbortController().signal));
      const ci=ids.map(id=>f.store.get('actions',id)!).find(row=>(row.payload.observation as any).claim.kind==='ci-result')!;
      f.store.save('actions',{...ci,payload:{...ci.payload,digest:'0'.repeat(64)}});
      const input=JSON.parse(f.source.content);input.changeNumber=18;
      const source={...f.source,id:'malformed-root-source',externalId:'malformed-root-source',content:JSON.stringify(input)};f.store.save('sources',source);
      const request={...f.request,changeNumber:18};f.routes['/merge_requests/18']={...f.routes['/merge_requests/17'],iid:18};
      const readback=await f.reader.read(f.project,source,request,new AbortController().signal);
      expect(()=>acceptRepositoryReadback(f.store,source.id,readback)).toThrow();
    }finally{f.close();}
  });

  it('projects an attested GitLab history with bounded work amid unrelated actions and shared targets',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      const input=JSON.parse(envelope(f.project.id,f.project.repository));input.testReportPath=reportPath;
      f.source.content=JSON.stringify(input);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const card=f.store.list('cards').find(value=>value.kind==='experience'&&value.sourceId===f.source.id)!;
      const original=f.store.list('actions').find(value=>value.kind==='experience.test-observation'&&(value.payload.observation as TestObservation|undefined)?.sourceId===f.source.id)!;
      expect(readTestObservation(f.store,original.id,f.project)?.comparable).toBeDefined();
      for(let i=0;i<4;i++){
        const source={...f.source,id:`shared-gitlab-${i}`,externalId:`shared-gitlab-${i}`};f.store.save('sources',source);
        expect(await ingestStructuredExperience(f.store,f.reader,source.id,new AbortController().signal)).toBe(true);
      }
      for(let i=0;i<1200;i++)f.store.save('actions',{id:`unrelated-${i}`,projectId:f.project.id,domain:f.project.domain,kind:'unrelated.fixture',status:'completed',payload:{index:i},updatedAt:''});
      const list=vi.spyOn(f.store,'list'),get=vi.spyOn(f.store,'get');
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{observed:[{observationId:original.id,checks:[{id:'gitlab-job:71',result:'success'}]}]}});
      expect(f.store.searchCards('cache misses',f.project,1)).toHaveLength(1);
      const wholeActionScans=list.mock.calls.filter(call=>call[0]==='actions').length,actionGets=get.mock.calls.filter(call=>call[0]==='actions').length;
      console.info('gitlab-projection-work',JSON.stringify({unrelatedActions:1200,sharedTargetSources:5,wholeActionScans,actionGets}));
      expect(wholeActionScans).toBe(0);expect(actionGets).toBeLessThan(700);
      list.mockRestore();get.mockRestore();
    }finally{f.close();}
  });

  it.each(['wrong-producer','wrong-result'] as const)('revalidates the attested GitLab host and test rows for %s',async fault=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      f.project.trustedAppIds=[731,732];f.store.save('projects',f.project);
      const input=JSON.parse(envelope(f.project.id,f.project.repository));input.testReportPath=reportPath;
      f.source.content=JSON.stringify(input);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const testRow=f.store.list('actions').find(value=>value.kind==='experience.test-observation')!;
      const hostId=(testRow.payload as any).hostObservationIds.find((id:string)=>readHostObservation(f.store,id,f.project)?.claim.kind==='test-result') as string;
      expect(hostId).toBeDefined();expect(readTestObservation(f.store,testRow.id,f.project)?.comparable).toBeDefined();
      const host=structuredClone(f.store.get('actions',hostId)!),payload=host.payload as any;
      if(fault==='wrong-producer'){payload.observation.origin.producerId='732';payload.observation.origin.independentOrigin='gitlab:42:producer:732';payload.attestation.producerId='732';}
      else payload.observation.claim.value.result='failure';
      payload.observation.id=hostObservationId(payload.observation);payload.digest=digest(payload.observation);host.id=payload.observation.id;
      f.store.delete('actions',hostId);f.store.save('actions',host);
      expect(readHostObservation(f.store,host.id,f.project)).toBeUndefined();
      const altered=structuredClone(testRow),testPayload=altered.payload as any;
      const bindings=testPayload.hostObservationIds.map((id:string,index:number)=>id===hostId?{id:host.id,hash:digest(hostObservationSchema.parse(payload.observation))}:{id,hash:testPayload.hostObservationHashes[index]}).sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id));
      testPayload.hostObservationIds=bindings.map((binding:{id:string})=>binding.id);testPayload.hostObservationHashes=bindings.map((binding:{hash:string})=>binding.hash);
      testPayload.observation.id=canonicalCiTestObservationId(testPayload.observation,testPayload.sourceHash,testPayload.policyHash,testPayload.requestHash,testPayload.hostObservationIds);
      testPayload.digest=digest(testPayload.observation);altered.id=testPayload.observation.id;f.store.save('actions',altered);
      expect(readTestObservation(f.store,altered.id,f.project)).toBeUndefined();
    }finally{f.close();}
  });

  it('removes attested GitLab authority after source retraction',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      const input=JSON.parse(envelope(f.project.id,f.project.repository));input.testReportPath=reportPath;
      f.source.content=JSON.stringify(input);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const testRow=f.store.list('actions').find(value=>value.kind==='experience.test-observation')!;
      const hostId=(testRow.payload as any).hostObservationIds.find((id:string)=>readHostObservation(f.store,id,f.project)?.claim.kind==='test-result') as string;
      expect(readHostObservation(f.store,hostId,f.project)).toBeDefined();
      invalidateSource(f.store,f.source.id,'withdrawn');
      expect(readHostObservation(f.store,hostId,f.project)).toBeUndefined();expect(readTestObservation(f.store,testRow.id,f.project)).toBeUndefined();
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
    }finally{f.close();}
  });

  it('finds attested GitLab rows in a temporary overlay and drops them on retraction',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      const input=JSON.parse(envelope(f.project.id,f.project.repository));input.testReportPath=reportPath;
      f.source.retention='ephemeral';f.source.content=JSON.stringify(input);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const testRow=f.store.list('actions').find(value=>value.kind==='experience.test-observation')!;
      expect(readTestObservation(f.store,testRow.id,f.project)?.comparable).toBeDefined();
      invalidateSource(f.store,f.source.id,'withdrawn');expect(readTestObservation(f.store,testRow.id,f.project)).toBeUndefined();
    }finally{f.close();}
  });

  it('refreshes temporary host discovery on rollback, deletion, restoration and policy changes',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      const input=JSON.parse(envelope(f.project.id,f.project.repository));input.testReportPath=reportPath;
      f.source.retention='ephemeral';f.source.content=JSON.stringify(input);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const row=f.store.list('actions').find(value=>value.kind==='experience.test-observation')!;
      const ciId=(row.payload as any).hostObservationIds.find((id:string)=>readHostObservation(f.store,id,f.project)?.claim.kind==='ci-result') as string;
      const ci=f.store.get('actions',ciId)!;expect(readTestObservation(f.store,row.id,f.project)?.comparable).toBeDefined();
      expect(()=>f.store.transaction(()=>{f.store.delete('actions',ciId);expect(readTestObservation(f.store,row.id,f.project)).toBeUndefined();throw new Error('rollback');})).toThrow('rollback');
      expect(readTestObservation(f.store,row.id,f.project)?.comparable).toBeDefined();
      f.store.delete('actions',ciId);expect(readTestObservation(f.store,row.id,f.project)).toBeUndefined();
      f.store.save('actions',ci);expect(readTestObservation(f.store,row.id,f.project)?.comparable).toBeDefined();
      f.store.save('projects',{...f.project,trustedAppIds:[]});expect(readTestObservation(f.store,row.id,f.project)).toBeUndefined();
      f.store.save('projects',f.project);expect(readTestObservation(f.store,row.id,f.project)?.comparable).toBeDefined();
    }finally{f.close();}
  });
});

describe('fix4 malformed host roots',()=>{
  const malformed=[
    ['empty',(payload:any)=>{payload.observation.origin.originalEventId='';}],
    ['overlong-ascii',(payload:any)=>{payload.observation.origin.originalEventId='x'.repeat(10001);}],
    ['overlong-utf16',(payload:any)=>{payload.observation.origin.originalEventId='😀'.repeat(5001);}],
    ['number',(payload:any)=>{payload.observation.origin.originalEventId=42;}],
    ['boolean',(payload:any)=>{payload.observation.origin.originalEventId=true;}],
    ['object',(payload:any)=>{payload.observation.origin.originalEventId={id:'71'};}],
    ['array',(payload:any)=>{payload.observation.origin.originalEventId=['71'];}],
    ['null',(payload:any)=>{payload.observation.origin.originalEventId=null;}],
    ['missing',(payload:any)=>{delete payload.observation.origin.originalEventId;}],
    ['null origin',(payload:any)=>{payload.observation.origin=null;}],
    ['array origin',(payload:any)=>{payload.observation.origin=[];}],
    ['scalar observation',(payload:any)=>{payload.observation=7;}],
  ] as const;
  it.each(['permanent','ephemeral'] as const)('rejects malformed %s host roots before admission',async retention=>{
    for(const [name,alter] of malformed){
      const dir=mkdtempSync(join(tmpdir(),'patrick-g6-malformed-')),path=join(dir,'store.sqlite'),seed=repositoryKnowledgeFixture('gitlab'),project=seed.project;seed.close();
      const store=new Store(path),f=repositoryKnowledgeFixture('gitlab',{store,project}),raw=new Database(path);try{
        f.source.retention=retention;f.store.save('sources',f.source);
        const ids=acceptRepositoryReadback(f.store,f.source.id,await f.reader.read(f.project,f.source,f.request,new AbortController().signal));
        const ci=ids.map(id=>f.store.get('actions',id)!).find(row=>(row.payload.observation as any).claim.kind==='ci-result')!;
        const root=(ci.payload.observation as any).origin.originalEventId as string;
        f.store.delete('actions',ci.id);
        const legacy=structuredClone(ci);legacy.id='fix4-malformed-'+name;alter(legacy.payload);
        if(retention==='permanent'){
          // Emulate private legacy SQLite data, including shapes current saves classify as temporary.
          raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)').run(legacy.id,legacy.projectId,legacy.domain,JSON.stringify(legacy));
        }else f.store.save('actions',legacy);
        expect(f.store.hostObservationRootActions(f.project,root).map(row=>row.id),name).toContain(legacy.id);
        const next=await f.reader.read(f.project,f.source,f.request,new AbortController().signal);
        expect(()=>acceptRepositoryReadback(f.store,f.source.id,next),name).toThrow();
      }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
    }
  });

  it.each(['permanent','ephemeral'] as const)('keeps a valid long %s UTF-16 root scoped to its own identity',async retention=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-long-root-')),path=join(dir,'store.sqlite'),seed=repositoryKnowledgeFixture('gitlab'),project=seed.project;seed.close();
    const store=new Store(path),f=repositoryKnowledgeFixture('gitlab',{store,project}),raw=new Database(path);try{
      f.source.retention=retention;f.store.save('sources',f.source);
      const ids=acceptRepositoryReadback(f.store,f.source.id,await f.reader.read(f.project,f.source,f.request,new AbortController().signal));
      const row=structuredClone(ids.map(id=>f.store.get('actions',id)!).find(value=>(value.payload.observation as any).claim.kind==='ci-result')!);
      row.id='fix4-long-valid-root';const root='汉'.repeat(5001);(row.payload.observation as any).origin.originalEventId=root;
      if(retention==='permanent'){
        raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)').run(row.id,row.projectId,row.domain,JSON.stringify(row));
      }else f.store.save('actions',row);
      expect(f.store.hostObservationRootActions(f.project,'some-other-root').map(value=>value.id)).not.toContain(row.id);
      expect(f.store.hostObservationRootActions(f.project,root).map(value=>value.id)).toContain(row.id);
    }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
  });

  it('ignores a valid retracted host marker while admitting a fresh binding',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      const old={...f.source,id:'fix4-retracted-source',externalId:'fix4-retracted-source',status:'withdrawn' as const};f.store.save('sources',old);
      f.store.save('actions',{id:'fix4-retracted-host',projectId:f.project.id,domain:f.project.domain,kind:'knowledge.host-observation',status:'completed',payload:{retracted:true,sourceIds:[old.id]},updatedAt:''});
      const readback=await f.reader.read(f.project,f.source,f.request,new AbortController().signal);
      expect(acceptRepositoryReadback(f.store,f.source.id,readback).length).toBeGreaterThan(0);
    }finally{f.close();}
  });
});

describe('fix5 durable root discovery',()=>{
  it('indexes committed host rows and follows Store rollback plus external replacement and deletion',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-fix5-root-')),path=join(dir,'store.sqlite'),scope={projectId:'p',domain:'personal' as const};
    const seed=repositoryKnowledgeFixture('gitlab'),project=seed.project;seed.close();
    let store=new Store(path),raw:Database.Database|undefined;const f=repositoryKnowledgeFixture('gitlab',{store,project});
    try{
      const ids=acceptRepositoryReadback(store,f.source.id,await f.reader.read(f.project,f.source,f.request,new AbortController().signal));
      const row=ids.map(id=>store.get('actions',id)!).find(value=>(value.payload.observation as any).claim.kind==='ci-result')!;
      const originalRoot=(row.payload.observation as any).origin.originalEventId as string;
      const find=(root:string)=>store.hostObservationRootActions(scope,root).some(value=>value.id===row.id);
      expect(find(originalRoot)).toBe(true);
      expect(()=>store.transaction(()=>{
        store.delete('actions',row.id);expect(find(originalRoot)).toBe(false);
        store.save('actions',row);expect(find(originalRoot)).toBe(true);
        throw new Error('rollback indexed root');
      })).toThrow('rollback indexed root');
      expect(find(originalRoot)).toBe(true);
      const replaced=structuredClone(row);(replaced.payload.observation as any).origin.originalEventId='replacement';
      raw=new Database(path);raw.prepare('UPDATE actions SET data = ? WHERE id = ?').run(JSON.stringify(replaced),row.id);
      expect(find('replacement')).toBe(true);expect(find(originalRoot)).toBe(false);
      raw.prepare('DELETE FROM actions WHERE id = ?').run(row.id);expect(find('replacement')).toBe(false);raw.close();raw=undefined;
      store.close();store=new Store(path);expect(find('replacement')).toBe(false);
    }finally{raw?.close();store.close();rmSync(dir,{recursive:true,force:true});}
  });

  it('streams one scoped host population per batch and fetches only selected roots',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-batch-roots-')),path=join(dir,'store.sqlite');
    const seed=repositoryKnowledgeFixture('gitlab'),project=seed.project;seed.close();
    const store=new Store(path),f=repositoryKnowledgeFixture('gitlab',{store,project});let raw:Database.Database|undefined;
    try{
      const ids=acceptRepositoryReadback(store,f.source.id,await f.reader.read(f.project,f.source,f.request,new AbortController().signal));
      const base=ids.map(id=>store.get('actions',id)!).find(row=>(row.payload.observation as any).claim.kind==='ci-result')!;
      const template=base.payload.observation as any,root=(i:number)=>template.origin.originalEventId.replace(/^gitlab:[1-9][0-9]*:/,`gitlab:${i+10000}:`);
      const seeded:string[]=[];raw=new Database(path);
      const insert=raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)');
      raw.transaction(()=>{
        for(let i=0;i<1600;i++){
          const observation=structuredClone(template);observation.origin.originalEventId=root(i);
          observation.origin.independentOrigin=`gitlab:${i+10000}:producer:${observation.origin.producerId}`;observation.id=hostObservationId(observation);
          const row={...base,id:observation.id,payload:{...base.payload,observation,digest:digest(observation),privateSentinel:'PRIVATE_BATCH_BODY_SENTINEL'}};
          insert.run(row.id,row.projectId,row.domain,JSON.stringify(row));seeded.push(row.id);
        }
        for(let i=0;i<80;i++){const row={...base,id:`foreign-${i}`,projectId:'foreign',domain:'company'};insert.run(row.id,row.projectId,row.domain,JSON.stringify(row));}
      })();
      const expectedRows=(raw.prepare("SELECT count(*) AS n FROM actions WHERE project_id=? AND domain=? AND json_extract(data,'$.kind')='knowledge.host-observation'").get(project.id,project.domain) as {n:number}).n;
      const db=(store as any).db,original=db.prepare.bind(db);let scans=0,rows=0,primaryReads=0;
      const spy=vi.spyOn(db,'prepare').mockImplementation((...args:unknown[])=>{
        const sql=args[0];if(typeof sql!=='string')throw Error('Expected SQL text');
        const statement=original(sql);
        if(sql.startsWith('SELECT id, project_id, domain, data FROM actions'))return new Proxy(statement,{get(target,property){
          if(property==='iterate')return (...args:unknown[])=>{const iterator=target.iterate(...args);scans++;return (function*(){for(const row of iterator){rows++;yield row;}})();};
          const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
        }});
        if(sql.startsWith('SELECT rowid,project_id,domain,data FROM actions WHERE id = ?'))return new Proxy(statement,{get(target,property){
          if(property==='get')return (...args:unknown[])=>{primaryReads++;return target.get(...args);};
          const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
        }});
        return statement;
      });
      try{
        const query=()=>{
          for(const [event,expected] of [[root(17),[seeded[17]]],[root(900),[seeded[900]]],[root(1599),[seeded[1599]]],['event-absent',[]]] as const){
            expect(store.hostObservationRootActions(project,event).map(row=>row.id)).toEqual(expected);
            expect(store.hostObservationActions(project,base.payload.sourceHash as string,base.payload.requestHash as string,'ci-result',event).map(row=>row.id)).toEqual(expected);
          }
        };
        store.readSnapshot(()=>{
          query();
          const groups=(store as any).operation.hosts;
          const encoded=JSON.stringify(groups,(_key,value)=>value instanceof Map?[...value.entries()]:value instanceof Set?[...value]:value);
          expect(encoded).not.toContain('PRIVATE_BATCH_BODY_SENTINEL');
        });
        expect({scans,rows,primaryReads}).toEqual({scans:1,rows:expectedRows,primaryReads:6});
        store.readSnapshot(query);expect(scans).toBe(2);expect(rows).toBe(expectedRows*2);expect(primaryReads).toBe(12);
        store.transaction(()=>{
          expect(store.hostObservationRootActions(project,root(17)).map(row=>row.id)).toContain(seeded[17]);
          const count=scans,row=store.get('actions',seeded[17]!)!;
          store.save('actions',{id:'unrelated-own',projectId:project.id,domain:project.domain,kind:'unrelated',status:'completed',payload:{},updatedAt:''});
          store.delete('actions',row.id);expect(store.hostObservationRootActions(project,root(17))).toEqual([]);
          store.save('actions',row);expect(store.hostObservationRootActions(project,root(17)).map(value=>value.id)).toContain(row.id);
          expect(scans).toBe(count);
        });
        const contradiction=structuredClone(base);contradiction.id='external-contradiction';(contradiction.payload.observation as any).origin.originalEventId=root(17);
        raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)').run(contradiction.id,contradiction.projectId,contradiction.domain,JSON.stringify(contradiction));
        expect(store.hostObservationRootActions(project,root(17)).map(row=>row.id)).toContain('external-contradiction');
        const afterMiss=structuredClone(base);afterMiss.id='external-after-miss';(afterMiss.payload.observation as any).origin.originalEventId='event-absent';
        raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)').run(afterMiss.id,afterMiss.projectId,afterMiss.domain,JSON.stringify(afterMiss));
        expect(store.hostObservationRootActions(project,'event-absent').map(row=>row.id)).toContain(afterMiss.id);
        expect((store as any).operation).toBeUndefined();
      }finally{spy.mockRestore();}
      console.info('batch-host-discovery',JSON.stringify({sameScopeHostRows:expectedRows,unrelatedScopeRows:80,scans,rows,primaryReads}));
    }finally{raw?.close();store.close();rmSync(dir,{recursive:true,force:true});}
  });

  it.each(['permanent','ephemeral'] as const)('preserves exact %s UTF-16 root identities',async retention=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-utf16-root-')),path=join(dir,'store.sqlite'),seed=repositoryKnowledgeFixture('gitlab'),project=seed.project;seed.close();
    const store=new Store(path),f=repositoryKnowledgeFixture('gitlab',{store,project}),raw=new Database(path);try{
      f.source.retention=retention;f.store.save('sources',f.source);
      const ids=acceptRepositoryReadback(f.store,f.source.id,await f.reader.read(f.project,f.source,f.request,new AbortController().signal));
      const base=ids.map(id=>f.store.get('actions',id)!).find(row=>(row.payload.observation as any).claim.kind==='ci-result')!;
      const roots=['a','a\0b','\ud800','\ud801','😀'.repeat(5000),'汉'.repeat(10000)];
      for(const [i,root] of roots.entries()){
        const row=structuredClone(base);row.id=`fix5-exact-root-${i}`;(row.payload.observation as any).origin.originalEventId=root;
        if(retention==='permanent'){
          raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)').run(row.id,row.projectId,row.domain,JSON.stringify(row));
        }else f.store.save('actions',row);
      }
      for(const [i,root] of roots.entries()){
        const binding=f.store.hostObservationActions(f.project,base.payload.sourceHash as string,base.payload.requestHash as string,'ci-result',root)
          .filter(row=>row.id.startsWith('fix5-exact-root-')).map(row=>row.id);
        expect(binding).toEqual([`fix5-exact-root-${i}`]);
        const matches=f.store.hostObservationRootActions(f.project,root).filter(row=>row.id.startsWith('fix5-exact-root-')).map(row=>row.id);
        expect(matches).toEqual([`fix5-exact-root-${i}`]);
      }
      expect(f.store.hostObservationRootActions(f.project,'unrelated').some(row=>row.id.startsWith('fix5-exact-root-'))).toBe(false);
    }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
  });
});

describe('fix4 temporary host discovery work',()=>{
  it('fails closed if a selected temporary row no longer matches its grouped root',()=>{
    const store=new Store(':memory:');try{
      const row={id:'changed-overlay',projectId:'p',domain:'personal',kind:'knowledge.host-observation',status:'completed',payload:{observation:{origin:{originalEventId:'old-root'}}},updatedAt:''};
      const temporary=(store as any).temporary as Map<string,{entity:typeof row}>;temporary.set(`actions:${row.id}`,{entity:structuredClone(row)});
      expect(()=>store.readSnapshot(()=>{
        expect(store.hostObservationRootActions(row,'old-root').map(value=>value.id)).toContain(row.id);
        temporary.get(`actions:${row.id}`)!.entity.payload.observation.origin.originalEventId='changed-without-hook';
        store.hostObservationRootActions(row,'old-root');
      })).toThrow('Temporary discovery mismatch');
      expect((store as any).operation).toBeUndefined();
    }finally{store.close();}
  });
  it('suppresses durable link rows by their SQLite ID when a different-kind temporary action shadows them',()=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-overlay-shadow-')),path=join(dir,'store.sqlite'),store=new Store(path),raw=new Database(path);
    try{
      const scope={projectId:'p',domain:'personal'},overlay={id:'shadow-id',...scope,kind:'knowledge.host-observation',status:'completed' as const,payload:{observation:{origin:{originalEventId:'temporary-root'}}},updatedAt:''};
      store.save('actions',overlay);
      const durable={id:'forged-json-id',...scope,kind:'experience.evidence-link',status:'completed',payload:{association:{cardId:'card',observationId:'observation'}},updatedAt:''};
      raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)').run('shadow-id',scope.projectId,scope.domain,JSON.stringify(durable));
      expect(store.experienceActions('experience.evidence-link',{scope,cardId:'card'})).toEqual([]);
    }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('rebuilds only an affected durable scope after nested rollback and restores the overlay',()=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-nested-groups-')),path=join(dir,'store.sqlite'),store=new Store(path),raw=new Database(path);
    try{
      const scopeA={projectId:'a',domain:'personal'},scopeB={projectId:'b',domain:'company'};
      const row=(id:string,scope:typeof scopeA,root:string)=>({id,...scope,kind:'knowledge.host-observation',status:'completed' as const,payload:{observation:{origin:{originalEventId:root}}},updatedAt:''});
      const insert=raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)');
      for(const value of [row('a-host',scopeA,'a-root'),row('b-host',scopeB,'b-root')])insert.run(value.id,value.projectId,value.domain,JSON.stringify(value));
      const overlay=row('overlay',scopeA,'overlay-old');store.save('actions',overlay);
      const original=(store as any).scopedActionGroups.bind(store),scans=new Map<string,number>();
      const spy=vi.spyOn(store as any,'scopedActionGroups').mockImplementation((...args:unknown[])=>{
        const [kind,scope]=args as [string,typeof scopeA];
        const key=JSON.stringify([scope.projectId,scope.domain]),op=(store as any).operation,first=!(kind==='knowledge.host-observation'?op.hosts:op.observations).has(key);
        const result=original(kind,scope);if(first)scans.set(key,(scans.get(key)??0)+1);return result;
      });
      try{store.transaction(()=>{
        expect(store.hostObservationRootActions(scopeA,'a-root').map(value=>value.id)).toContain('a-host');
        expect(store.hostObservationRootActions(scopeB,'b-root').map(value=>value.id)).toContain('b-host');
        expect(store.hostObservationRootActions(scopeA,'overlay-old').map(value=>value.id)).toContain('overlay');
        expect(()=>store.transaction(()=>{
          store.delete('actions','a-host');store.save('actions',row('overlay',scopeA,'overlay-new'));
          expect(store.hostObservationRootActions(scopeA,'a-root').map(value=>value.id)).not.toContain('a-host');
          expect(store.hostObservationRootActions(scopeA,'overlay-new').map(value=>value.id)).toContain('overlay');throw Error('nested rollback');
        })).toThrow('nested rollback');
        expect(store.hostObservationRootActions(scopeA,'a-root').map(value=>value.id)).toContain('a-host');
        expect(store.hostObservationRootActions(scopeA,'overlay-old').map(value=>value.id)).toContain('overlay');
        expect(store.hostObservationRootActions(scopeA,'overlay-new').map(value=>value.id)).not.toContain('overlay');
        expect(store.hostObservationRootActions(scopeB,'b-root').map(value=>value.id)).toContain('b-host');
        expect(scans.get(JSON.stringify(['a','personal']))).toBe(2);expect(scans.get(JSON.stringify(['b','company']))).toBe(1);
      });}finally{spy.mockRestore();}
      expect((store as any).operation).toBeUndefined();
    }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('bounds discovery in actual publication, admission, sweep, search, HTTP views and worker input batches',async()=>{
    const seed=repositoryKnowledgeFixture('gitlab'),projectA=seed.project;seed.close();
    const dir=mkdtempSync(join(tmpdir(),'patrick-g6-outer-batch-')),path=join(dir,'store.sqlite');
    const store=new Store(path),projectB={...projectA,id:'second-project',projectId:'second-project',domain:'company'};let raw:Database.Database|undefined;
    const a=repositoryKnowledgeFixture('gitlab',{store,project:projectA}),b=repositoryKnowledgeFixture('gitlab',{store,project:projectB});
    let engine:Workbench|undefined;
    try{
      a.source.id='batch-source-a';b.source.id='batch-source-b';
      a.source.content=envelope(projectA.id,projectA.repository);b.source.content=envelope(projectB.id,projectB.repository);
      store.save('sources',a.source);store.save('sources',b.source);store.delete('sources','s');
      expect(await ingestStructuredExperience(store,a.reader,a.source.id,new AbortController().signal)).toBe(true);
      expect(await ingestStructuredExperience(store,b.reader,b.source.id,new AbortController().signal)).toBe(true);
      const cardA=store.list('cards').find(card=>card.sourceId===a.source.id&&card.kind==='experience')!;
      const observations=store.list('actions').filter(action=>action.kind==='experience.test-observation');raw=new Database(path);
      const insert=raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)');
      raw.transaction(()=>{for(const row of observations)for(let i=0;i<24;i++){const copy={...row,id:`noncanonical-${row.projectId}-${i}`};insert.run(copy.id,copy.projectId,copy.domain,JSON.stringify(copy));}})();
      for(const [project,source] of [[projectA,a.source],[projectB,b.source]] as const){
        const temporary={...source,id:`temporary-${project.id}`,externalId:`temporary-${project.id}`,retention:'ephemeral' as const};store.save('sources',temporary);
        for(let i=0;i<30;i++){
          const card={...cardA,id:`temporary-card-${project.id}-${i}`,projectId:project.id,domain:project.domain,sourceId:temporary.id,sourceRevision:temporary.revision,title:`temporary ${i}`,body:'PRIVATE_BATCH_CARD_SENTINEL',locator:temporary.locator,experience:{...cardA.experience!,productId:project.id}};
          store.save('cards',card);
          store.save('actions',{id:`temporary-link-${project.id}-${i}`,projectId:project.id,domain:project.domain,kind:'experience.evidence-link',status:'completed',payload:{association:{cardId:card.id,observationId:'missing'},private:'PRIVATE_BATCH_LINK_SENTINEL'},updatedAt:''});
        }
      }
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[projectA,projectB];config.ownerId=projectA.ownerId;
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});const app=createApp({store,config,engine});
      const task=engine.ingest({projectId:projectA.id,externalId:'batch-input',title:'cache misses',content:'cache misses',purpose:'task'})!;
      const temporary=(store as any).temporary as Map<string,unknown>,stats:Record<string,unknown>[]=[];
      const measure=async(name:string,fn:()=>unknown|Promise<unknown>)=>{
        let discovering=false,temporaryVisits=0,selected=0,selectedBytes=0,candidatePostings=0,primaryReads=0;const scans=new Map<string,number>(),populations:Record<string,number>={},instrumented=new WeakSet<object>(),mapSpies:Array<{mockRestore:()=>void}>=[];
        const iterator=temporary[Symbol.iterator].bind(temporary),iterSpy=vi.spyOn(temporary,Symbol.iterator).mockImplementation(()=>{const iter=iterator(),next=iter.next.bind(iter);iter.next=()=>{const result=next();if(discovering&&!result.done)temporaryVisits++;return result;};return iter;});
        const temp=(store as any).temporaryGroups.bind(store),tempSpy=vi.spyOn(store as any,'temporaryGroups').mockImplementation(()=>{discovering=true;try{const groups=temp();const encoded=JSON.stringify(groups,(_key,value)=>value instanceof Map?[...value.entries()]:value instanceof Set?[...value]:value);expect(encoded).not.toContain('PRIVATE_BATCH_CARD_SENTINEL');expect(encoded).not.toContain('PRIVATE_BATCH_LINK_SENTINEL');
          if(!instrumented.has(groups.keys)){instrumented.add(groups.keys);const get=groups.keys.get.bind(groups.keys);mapSpies.push(vi.spyOn(groups.keys,'get').mockImplementation((...args:unknown[])=>{const key=args[0];if(typeof key!=='string')throw Error('Expected grouping key');const posting=get(key) as Set<string>|undefined;if(!posting||JSON.parse(key)[0]!=='candidate')return posting;return new Proxy(posting,{get(target,property){if(property===Symbol.iterator)return function*(){for(const id of target){candidatePostings++;yield id;}};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});}));}
          return groups;}finally{discovering=false;}});
        const scoped=(store as any).scopedActionGroups.bind(store),scopedSpy=vi.spyOn(store as any,'scopedActionGroups').mockImplementation((...args:unknown[])=>{const [kind,scope]=args as [string,{projectId:string;domain:string}],key=JSON.stringify([scope.projectId,scope.domain]),operation=(store as any).operation,map=kind==='knowledge.host-observation'?operation.hosts:operation.observations,first=!map.has(key),groups=scoped(kind,scope);if(first){const name=`${kind}:${key}`;scans.set(name,(scans.get(name)??0)+1);populations[name]=groups.byId.size;if(kind==='experience.test-observation')populations[`F:${key}`]=[...groups.keys.entries()].filter(([k]:[string,unknown])=>JSON.parse(k)[0]==='observation-file').reduce((sum:number,[,ids]:[string,Set<string>])=>sum+ids.size,0);}return groups;});
        const select=(store as any).selectedActions.bind(store),selectSpy=vi.spyOn(store as any,'selectedActions').mockImplementation((...args:unknown[])=>{const values=select(...args);selected+=values.length;selectedBytes+=Buffer.byteLength(JSON.stringify(values));return values;});
        const db=(store as any).db,prepare=db.prepare.bind(db),prepareSpy=vi.spyOn(db,'prepare').mockImplementation((...args:unknown[])=>{const sql=args[0];if(typeof sql!=='string')throw Error('Expected SQL text');const statement=prepare(sql);if(!sql.startsWith('SELECT rowid,project_id,domain,data FROM actions WHERE id = ?'))return statement;return new Proxy(statement,{get(target,property){if(property==='get')return (...args:unknown[])=>{primaryReads++;return target.get(...args);};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});});
        const startingTemporary=temporary.size;
        try{await fn();}
        finally{iterSpy.mockRestore();tempSpy.mockRestore();scopedSpy.mockRestore();selectSpy.mockRestore();prepareSpy.mockRestore();for(const spy of mapSpies)spy.mockRestore();}
        expect((store as any).operation).toBeUndefined();expect([...scans.values()].every(value=>value===1)).toBe(true);expect(temporaryVisits).toBeLessThanOrEqual(startingTemporary);
        stats.push({name,H_and_O:populations,T:startingTemporary,temporaryVisits,selectedK:selected,selectedBytes,primaryReads,candidatePostings});
      };
      const proposals=Array.from({length:12},(_,i)=>({title:`batch publication ${i}`,body:'cache misses',quote:'Resolution report',aliases:['cache misses'],kind:'experience' as const,verification:'reported' as const,experience:cardA.experience!}));
      let published:typeof cardA[]=[];
      await measure('publication',()=>{published=publishKnowledge(store,a.source,{cards:proposals});});
      const readback=await a.reader.read(projectA,a.source,{...a.request,changeNumber:undefined,testReportPath:undefined},new AbortController().signal);
      await measure('admission',()=>store.transaction(()=>{acceptRepositoryReadback(store,a.source.id,readback);linkExperienceForCards(store,published);}));
      await measure('sweep',()=>linkRetainedExperienceEvidence(store));
      await measure('search',()=>store.searchCards('cache misses',projectA));
      await measure('lookup',async()=>{expect((await app.request(`/api/lookup?project=${projectA.id}&domain=${projectA.domain}&q=cache`)).status).toBe(200);});
      await measure('state',async()=>{expect((await app.request('/api/state')).status).toBe(200);});
      await measure('page',async()=>{expect((await app.request(`/knowledge?project=${projectA.id}`)).status).toBe(200);});
      await measure('worker-input',()=>{(engine as any).input(task,projectA,'knowledge_extract');});
      expect(stats).toHaveLength(8);console.info('batch-outer-work',JSON.stringify(stats));
    }finally{await engine?.shutdown();raw?.close();store.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('bounds temporary-map iteration across admitted host rows and unrelated writes',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      f.source.retention='ephemeral';f.store.save('sources',f.source);
      const other={...f.source,id:'fix4-other-binding',externalId:'fix4-other-binding'};f.store.save('sources',other);
      const unrelatedSources=Array.from({length:8},(_,i)=>({...f.source,id:`fix4-noise-source-${i}`,externalId:`fix4-noise-source-${i}`}));
      for(const source of unrelatedSources)f.store.save('sources',source);
      for(let i=0;i<200;i++){
        f.store.save('cards',{id:`fix4-noise-card-${i}`,projectId:f.project.id,domain:f.project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,status:'active',kind:'fact',verification:'reported',title:'noise',body:'noise',quote:'noise',locator:f.source.locator,aliases:[],createdAt:''});
        f.store.save('actions',{id:`fix4-noise-action-${i}`,projectId:f.project.id,domain:f.project.domain,kind:'experience.evidence-link',status:'completed',payload:{noise:i},updatedAt:''});
      }
      const first=await f.reader.read(f.project,f.source,f.request,new AbortController().signal);
      const second=await f.reader.read(f.project,other,f.request,new AbortController().signal);
      const temporary=(f.store as any).temporary as Map<string,unknown>,original=temporary[Symbol.iterator].bind(temporary);let visits=0,discovering=false;
      const discover=(f.store as any).temporaryGroups.bind(f.store);
      const discovery=vi.spyOn(f.store as any,'temporaryGroups').mockImplementation(()=>{discovering=true;try{return discover();}finally{discovering=false;}});
      const iterator=vi.spyOn(temporary,Symbol.iterator).mockImplementation(()=>{const values=original(),next=values.next.bind(values);values.next=()=>{const value=next();if(discovering&&!value.done)visits++;return value;};return values;});
      let admitted=0;
      f.store.transaction(()=>{
        const a=acceptRepositoryReadback(f.store,f.source.id,first);
        f.store.save('actions',{id:'fix4-unrelated-late',projectId:f.project.id,domain:f.project.domain,kind:'experience.evidence-link',status:'completed',payload:{noise:'late'},updatedAt:''});
        f.store.delete('actions','fix4-noise-action-0');
        f.store.save('cards',{...f.store.get('cards','fix4-noise-card-0')!,title:'updated noise'});
        f.store.save('sources',unrelatedSources[0]!);
        const b=acceptRepositoryReadback(f.store,other.id,second);admitted=a.length+b.length;
        expect(a.length).toBeGreaterThan(1);expect(b.length).toBeGreaterThan(1);
        for(let i=0;i<4;i++)f.store.hostObservationRootActions(f.project,'unrelated-root');
      });
      iterator.mockRestore();discovery.mockRestore();
      console.info('fix4-temporary-discovery',JSON.stringify({unrelatedTemporaryEntries:408,admittedRows:admitted,discoveryEntriesVisited:visits}));
      expect(visits).toBeGreaterThanOrEqual(408);expect(visits).toBeLessThan(500);
    }finally{f.close();}
  });

  it('tracks temporary host replacement, deletion, migration and rollback',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      f.source.retention='ephemeral';f.store.save('sources',f.source);
      const ids=acceptRepositoryReadback(f.store,f.source.id,await f.reader.read(f.project,f.source,f.request,new AbortController().signal));
      const row=ids.map(id=>f.store.get('actions',id)!).find(value=>(value.payload.observation as any).claim.kind==='ci-result')!;
      const root=(row.payload.observation as any).origin.originalEventId as string;
      const found=()=>f.store.hostObservationRootActions(f.project,root).some(value=>value.id===row.id);
      expect(found()).toBe(true);
      expect(()=>f.store.transaction(()=>{f.store.delete('actions',row.id);expect(found()).toBe(false);throw new Error('rollback');})).toThrow('rollback');
      expect(found()).toBe(true);
      const altered=structuredClone(row);(altered.payload.observation as any).origin.originalEventId='fix4-replaced-root';
      f.store.save('actions',altered);expect(found()).toBe(false);
      expect(f.store.hostObservationRootActions(f.project,'fix4-replaced-root').some(value=>value.id===row.id)).toBe(true);
      f.store.delete('actions',row.id);expect(f.store.hostObservationRootActions(f.project,'fix4-replaced-root').some(value=>value.id===row.id)).toBe(false);
      f.store.save('actions',row);expect(found()).toBe(true);
      f.source.retention='permanent';f.store.save('sources',f.source);f.store.save('actions',row);expect(found()).toBe(true);
      f.source.retention='ephemeral';f.store.save('sources',f.source);expect(found()).toBe(true);
      f.store.close();expect((f.store as any).temporary.size).toBe(0);expect((f.store as any).operation).toBeUndefined();
    }finally{f.close();}
  });
});
