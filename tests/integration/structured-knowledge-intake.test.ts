import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../../src/config.js';
import { configureDemo, demoResearch, demoWriter, DemoWorker } from '../../src/demo.js';
import { Workbench } from '../../src/orchestrator.js';
import { ingestStructuredKnowledge } from '../../src/knowledge.js';
import { acceptRepositoryReadback } from '../../src/knowledge-evidence.js';
import { ingestStructuredExperience } from '../../src/integrations/experience-ci.js';
import { structuredKnowledgeJobId } from '../../src/knowledge-jobs.js';
import { Store } from '../../src/store.js';
import { readHostObservation } from '../../src/knowledge-records.js';
import { repositoryKnowledgeFixture, H, H2 } from '../fixtures/repository-knowledge.js';
import { createBackup } from '../../src/backup.js';
import { ingestSource } from '../../src/intake.js';
import { restoreBackup } from '../../scripts/restore.js';

describe('shared structured host intake', () => {
  it.each([
    ['conflict', 'reading', 'ephemeral'], ['local-fault', 'conversation', 'ephemeral'],
    ['conflict', 'conversation', 'ephemeral'], ['local-fault', 'reading', 'ephemeral'],
    ['conflict', 'reading', 'permanent'], ['tampered', 'reading', 'ephemeral'],
  ] as const)('does not reissue an authenticated read after %s (%s, %s)', async (failure, kind, retention) => {
    const root=mkdtempSync(join(tmpdir(),'patrick-consumed-read-local-'));
    const seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    const db=join(root,'db.sqlite'),vault=join(root,'vault'),raw='CONSUMED_READ_RAW_SENTINEL',derived='CONSUMED_READ_DERIVED_SENTINEL';
    const content=JSON.stringify({schemaVersion:1,kind:'repository-facts',quote:`${raw} ${derived}`,repository:project.repository,headSha:H,checks:[{runId:'52',jobId:'71',checkName:'validate'}]});
    const input={projectId:project.id,kind,externalId:`local-${failure}-${kind}-${retention}`,revision:'r1',title:'Read',content,retention,...(kind==='reading'?{purpose:'reference' as const}:{})};
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
    let store=new Store(db,vault),fixture=repositoryKnowledgeFixture('github',{store,project});store.save('sources',{...fixture.source,status:'withdrawn'});
    let consumedRead:Awaited<ReturnType<typeof fixture.reader.read>>|undefined,tamperNext=false;
    const observedReader={async read(...args:Parameters<typeof fixture.reader.read>){const value=await fixture.reader.read(...args);if(tamperNext)value.observations[0]!.id='tampered';consumedRead=value;return value;}};
    let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:observedReader});
    vi.useFakeTimers({toFake:['Date']});
    try{
      engine.ingest({...input,kind:'reading',externalId:'seed',retention:'permanent',purpose:'reference',content:JSON.stringify({schemaVersion:1,kind:'repository-facts',quote:'Seed check',repository:project.repository,headSha:H,checks:[{runId:'52',jobId:'71',checkName:'validate'}]})});await engine.tick();
      expect(store.list('actions').filter(a=>a.kind==='knowledge.host-observation')).toHaveLength(2);
      if(failure==='conflict'){
        fixture.routes['/actions/runs/52'].conclusion='failure';
        fixture.routes['/actions/runs/52/jobs'].jobs[0].conclusion='failure';
        fixture.routes['/check-runs/99'].conclusion='failure';
      }
      tamperNext=failure==='tampered';
      const task=engine.ingest(input),source=store.list('sources').find(s=>s.externalId===input.externalId)!,id=structuredKnowledgeJobId(source),before=fixture.requests.length;
      const fault=failure==='local-fault'?vi.spyOn(store,'hostObservationRootActions').mockImplementationOnce(()=>{throw new Error('local canonical lookup failure');}):undefined;
      await engine.tick();fault?.mockRestore();
      expect(fixture.requests.length-before).toBe(5);
      expect(store.get('actions',id)).toMatchObject({status:'pending',payload:{errorCode:'knowledge_read_inflight'}});
      expect(consumedRead).toBeDefined();let signalled=false;
      expect(()=>acceptRepositoryReadback(store,source.id,structuredClone(consumedRead!),()=>{signalled=true;})).toThrow();expect(signalled).toBe(false);
      expect(()=>acceptRepositoryReadback(store,source.id,consumedRead!,()=>{signalled=true;})).toThrow();expect(signalled).toBe(false);
      for(let i=0;i<40;i++){vi.setSystemTime(Date.now()+1000);await engine.tick();}
      expect(fixture.requests.length-before).toBe(5);
      if(retention==='ephemeral'){
        const backup=join(root,'backup');await createBackup(store,backup,{mode:'test',vaultDir:vault});
        const inspect=(path:string)=>{try{const bytes=readFileSync(path);for(const secret of [raw,derived])expect(bytes.includes(Buffer.from(secret))).toBe(false);}catch(error){if((error as NodeJS.ErrnoException).code!=='EISDIR')throw error;}};
        for(const path of [db,`${db}-wal`])if(existsSync(path))inspect(path);
        for(const dir of [vault,backup])for(const name of readdirSync(dir,{recursive:true}).map(String))inspect(join(dir,name));
        const destination=join(root,'restored');restoreBackup({snapshot:backup,destination,writerRevoked:true,reconciled:true});
        const restoredStore=new Store(join(destination,'patrick.db'),join(destination,'vault')),restoredFixture=repositoryKnowledgeFixture('github',{store:restoredStore,project});
        restoredStore.save('sources',{...restoredFixture.source,status:'withdrawn'});
        const restoredEngine=new Workbench({store:restoredStore,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:restoredFixture.reader});
        try{
          const replay=restoredEngine.ingest(input);if(task)expect(replay).toMatchObject({id:task.id,version:task.version,status:'blocked'});
          await restoredEngine.tick();expect(restoredFixture.requests).toHaveLength(0);
          for(const path of [join(destination,'patrick.db'),join(destination,'patrick.db-wal')])if(existsSync(path))inspect(path);
          for(const name of readdirSync(join(destination,'vault'),{recursive:true}).map(String))inspect(join(destination,'vault',name));
        }finally{await restoredEngine.shutdown();restoredStore.close();}
      }
      await engine.shutdown();store.close();store=new Store(db,vault);fixture=repositoryKnowledgeFixture('github',{store,project});store.save('sources',{...fixture.source,status:'withdrawn'});
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:fixture.reader});
      expect(store.get('actions',id)).toMatchObject({status:'pending',payload:{errorCode:'knowledge_read_inflight'}});
      const replay=engine.ingest(input);if(task)expect(replay).toMatchObject({id:task.id,version:task.version,status:'blocked'});
      for(let i=0;i<40;i++){vi.setSystemTime(Date.now()+1000);await engine.tick();}
      expect(fixture.requests).toHaveLength(0);
      expect(store.list('actions').filter(a=>a.kind==='knowledge.host-observation')).toHaveLength(2);
      if(retention==='ephemeral')for(const path of [db,`${db}-wal`])if(existsSync(path))for(const secret of [raw,derived])expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
      if(task)engine.retry(task.id);else engine.ingest({...input,revision:'r2'});
      await engine.tick();expect(fixture.requests).toHaveLength(5);
    }finally{vi.useRealTimers();await engine.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
  });
  it('does not treat a cloned reader response as a consumed authenticated handoff',async()=>{
    const f=repositoryKnowledgeFixture();
    try{
      const reader={async read(...args:Parameters<typeof f.reader.read>){return structuredClone(await f.reader.read(...args));}};
      expect(await ingestStructuredKnowledge(f.store,reader,f.source.id,new AbortController().signal)).toBe('pending');
      const action=f.store.get('actions',structuredKnowledgeJobId(f.source))!;
      expect(action).toMatchObject({status:'pending',payload:{phase:'pending-readback',errorCode:'repository_readback_failed',tries:1}});
      expect(action.payload.readHold).toBeUndefined();expect(f.store.list('actions').filter(a=>a.kind==='knowledge.host-observation')).toEqual([]);
    }finally{f.close();}
  });
  it.each(['reading','conversation','file'] as const)('keeps a consumed temporary %s read held across reopen and same-revision replay',async kind=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-temporary-read-hold-'));
    const seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    const db=join(root,'db.sqlite'),vault=join(root,'vault'),sentinel='TEMPORARY_READ_BODY_SENTINEL';
    const content=JSON.stringify({schemaVersion:1,kind:'repository-facts',quote:sentinel,repository:project.repository,headSha:H,checks:[]});
    const input={projectId:project.id,kind,externalId:`temporary-${kind}`,revision:'r1',title:sentinel,content,retention:'ephemeral' as const,...(kind==='reading'?{purpose:'reference' as const}:{})};
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
    let store=new Store(db,vault),fixture=repositoryKnowledgeFixture('github',{store,project});
    store.save('sources',{...fixture.source,status:'withdrawn'});
    let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:fixture.reader});
    vi.useFakeTimers({toFake:['Date']});
    try{
      const task=engine.ingest(input),source=store.list('sources').find(s=>s.externalId===input.externalId)!,id=structuredKnowledgeJobId(source);
      const get=store.get.bind(store);let injected=false;
      const fault=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
        if(!injected&&new Error().stack?.includes('takeRepositoryReadback')){injected=true;throw Object.assign(new Error('consumption fault'),{code:'SQLITE_BUSY'});}
        return get(...args);
      }) as typeof store.get);
      await engine.tick().catch(()=>undefined);fault.mockRestore();
      expect(injected).toBe(true);expect(fixture.requests).toHaveLength(2);
      expect(store.get('actions',id)).toMatchObject({status:'pending',payload:{errorCode:'knowledge_read_inflight'}});
      const raw=store as unknown as {db:import('better-sqlite3').Database};
      expect(raw.db.prepare('SELECT count(*) AS n FROM actions WHERE id = ?').get(id)).toEqual({n:1});
      for(let i=0;i<48;i++){vi.setSystemTime(Date.now()+1000);await engine.tick().catch(()=>undefined);}
      expect(fixture.requests).toHaveLength(2);
      const snapshot=join(root,'backup');await createBackup(store,snapshot,{mode:'test',vaultDir:vault});
      const checkTree=(dir:string)=>{for(const name of readdirSync(dir,{recursive:true}).map(String)){const path=join(dir,name);if(!readFileSyncSafe(path).includes(Buffer.from(sentinel)))continue;throw new Error(`temporary body persisted: ${name}`);}};
      const readFileSyncSafe=(path:string)=>{try{return readFileSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='EISDIR')return Buffer.alloc(0);throw error;}};
      for(const path of [db,`${db}-wal`,`${db}-shm`])if(existsSync(path))expect(readFileSync(path).includes(Buffer.from(sentinel))).toBe(false);
      checkTree(vault);checkTree(join(root,'backup'));
      const destination=join(root,'restored');restoreBackup({snapshot,destination,writerRevoked:true,reconciled:true});
      const restoredStore=new Store(join(destination,'patrick.db'),join(destination,'vault'));
      const restoredFixture=repositoryKnowledgeFixture('github',{store:restoredStore,project});restoredStore.save('sources',{...restoredFixture.source,status:'withdrawn'});
      const restoredEngine=new Workbench({store:restoredStore,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:restoredFixture.reader});
      try{
        expect(restoredStore.get('actions',id)).toMatchObject({status:'pending',payload:{errorCode:'knowledge_read_inflight'}});
        const replay=restoredEngine.ingest(input);if(task)expect(replay).toMatchObject({id:task.id,version:task.version,status:'blocked'});
        await restoredEngine.tick();expect(restoredFixture.requests).toHaveLength(0);
      }finally{await restoredEngine.shutdown();restoredStore.close();}
      await engine.shutdown();store.close();store=new Store(db,vault);fixture=repositoryKnowledgeFixture('github',{store,project});
      store.save('sources',{...fixture.source,status:'withdrawn'});
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:fixture.reader});
      expect(store.get('sources',source.id)?.content).toBe('');
      expect(store.get('actions',id)).toMatchObject({status:'pending',payload:{errorCode:'knowledge_read_inflight'}});
      const restored=engine.ingest(input);
      if(task)expect(restored).toMatchObject({id:task.id,version:task.version});else expect(restored).toBeUndefined();
      expect(()=>engine.ingest({...input,content:`${content} changed`})).toThrowError(expect.objectContaining({code:'revision_conflict'}));
      for(let i=0;i<5;i++){vi.setSystemTime(Date.now()+1000);await engine.tick();}
      expect(fixture.requests).toHaveLength(0);
      expect(store.list('actions').filter(a=>a.kind==='knowledge.host-observation')).toHaveLength(0);
      if(task){
        store.save('projects',{...project,trustedChecks:[...project.trustedChecks,'changed']});
        expect(()=>engine.retry(task.id)).toThrowError(expect.objectContaining({code:'stale_source'}));
        expect(fixture.requests).toHaveLength(0);store.save('projects',project);
        engine.retry(task.id);await engine.tick();
      }
      else {engine.ingest({...input,revision:'r2'});await engine.tick();}
      expect(fixture.requests).toHaveLength(2);
    }finally{vi.useRealTimers();await engine.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
  });
  it.each(['restore','withdraw'] as const)('keeps a read hold bound to an expired temporary dependency on %s',async mode=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-read-dependency-')),seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    const db=join(root,'db.sqlite'),config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
    const parentInput={projectId:project.id,kind:'reading' as const,externalId:'parent',revision:'p1',title:'Parent',content:'TEMPORARY_DEPENDENCY_SENTINEL',retention:'ephemeral' as const,purpose:'reference' as const};
    const input={projectId:project.id,kind:'conversation' as const,externalId:'child',revision:'c1',title:'Child',content:JSON.stringify({schemaVersion:1,kind:'repository-facts',quote:'CHILD_TEMPORARY_SENTINEL',repository:project.repository,headSha:H,checks:[]}),retention:'ephemeral' as const};
    let store=new Store(db),fixture=repositoryKnowledgeFixture('github',{store,project});store.save('sources',{...fixture.source,status:'withdrawn'});
    let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:fixture.reader});
    try{
      engine.ingest(parentInput);const parent=store.list('sources').find(s=>s.externalId==='parent')!;
      const task=ingestSource(store,config,input,[{id:parent.id,revision:parent.revision}])!;
      const get=store.get.bind(store);let injected=false;
      const fault=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
        if(!injected&&new Error().stack?.includes('takeRepositoryReadback')){injected=true;throw Object.assign(new Error('consumption fault'),{code:'SQLITE_BUSY'});}
        return get(...args);
      }) as typeof store.get);
      await engine.tick().catch(()=>undefined);fault.mockRestore();expect(injected).toBe(true);expect(fixture.requests).toHaveLength(2);
      await engine.shutdown();store.close();
      for(const path of [db,`${db}-wal`])if(existsSync(path)){const bytes=readFileSync(path);expect(bytes.includes(Buffer.from(parentInput.content))).toBe(false);expect(bytes.includes(Buffer.from('CHILD_TEMPORARY_SENTINEL'))).toBe(false);}
      store=new Store(db);fixture=repositoryKnowledgeFixture('github',{store,project});store.save('sources',{...fixture.source,status:'withdrawn'});
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:fixture.reader});
      engine.ingest(input);expect(()=>engine.retry(task.id)).toThrow();await engine.tick();expect(fixture.requests).toHaveLength(0);
      if(mode==='restore'){
        expect(()=>engine.ingest({...parentInput,content:'changed parent'})).toThrowError(expect.objectContaining({code:'revision_conflict'}));
        engine.ingest(parentInput);engine.retry(task.id);await engine.tick();expect(fixture.requests).toHaveLength(2);
      }else{
        engine.withdraw(parent.id);expect(()=>engine.ingest(input)).toThrowError(expect.objectContaining({code:'revoked_revision'}));
        await engine.tick();expect(fixture.requests).toHaveLength(0);
      }
    }finally{await engine.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
  });
  it.each((['processor', 'adapter'] as const).flatMap(api => (['transient', 'persistent'] as const).map(failure => [api, failure] as const)))('reports a committed Vault error through the %s for a %s failure without another read', async (api, failure) => {
    const root=mkdtempSync(join(tmpdir(),'patrick-structured-vault-')),seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    const store=new Store(join(root,'db.sqlite'),join(root,'vault')),f=repositoryKnowledgeFixture('github',{store,project});
    const state=store as unknown as {vaultJobs:Map<string,unknown>;publish:(job:{table:string;entity:{claim?:unknown}})=>void};
    const publish=state.publish.bind(store);let faults=0;
    const spy=vi.spyOn(state,'publish').mockImplementation(job=>{
      if(job.table==='cards'&&job.entity.claim&&(failure==='persistent'||faults===0)){faults++;throw Object.assign(new Error('injected filesystem failure'),{code:'EIO'});}
      return publish(job);
    });
    const invoke=()=>api==='processor'?ingestStructuredKnowledge(store,f.reader,f.source.id,new AbortController().signal):ingestStructuredExperience(store,f.reader,f.source.id,new AbortController().signal);
    try{
      await expect(invoke()).rejects.toMatchObject({code:'vault_sync_unavailable'});
      expect(faults).toBe(1);
      const job=store.get('actions',structuredKnowledgeJobId(f.source));
      expect(job).toMatchObject({status:'completed',payload:{phase:'processed'}});
      expect(state.vaultJobs.size).toBeGreaterThan(0);
      const card=store.list('cards').find(value=>value.claim)!;
      const cardPath=join(root,'vault',project.id,project.domain,'cards',`${encodeURIComponent(card.id).replaceAll('.','%2E')}.md`),beforeVault=readFileSync(cardPath,'utf8');
      expect(beforeVault).not.toContain('"claim":');
      const requestCount=f.requests.length;expect(requestCount).toBeGreaterThan(0);
      if(failure==='persistent'){
        expect(()=>store.reconcileVault()).toThrowError(expect.objectContaining({code:'vault_sync_unavailable'}));
        expect(faults).toBeGreaterThan(1);expect(f.requests).toHaveLength(requestCount);
        expect(store.get('actions',job!.id)).toEqual(job);
        await expect(invoke()).resolves.toBe(api==='processor'?'processed':true);
        expect(state.vaultJobs.size).toBeGreaterThan(0);expect(f.requests).toHaveLength(requestCount);
      }
      spy.mockRestore();store.reconcileVault();expect(state.vaultJobs.size).toBe(0);
      expect(readFileSync(cardPath,'utf8')).toContain('"claim":');
      await expect(invoke()).resolves.toBe(api==='processor'?'processed':true);
      expect(f.requests).toHaveLength(requestCount);
    }finally{spy.mockRestore();store.close();rmSync(root,{recursive:true,force:true});}
  });
  it.each(['SQLITE_BUSY','SQLITE_LOCKED','SQLITE_SCHEMA'])('propagates %s from retained host source validation without changing evidence',async code=>{
    const f=repositoryKnowledgeFixture();try{
      expect(await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal)).toBe('processed');
      const host=f.store.list('actions').find(value=>value.kind==='knowledge.host-observation')!,before=f.store.list('actions'),get=f.store.get.bind(f.store);let injected=false;
      expect(readHostObservation(f.store,host.id,f.project)).toBeDefined();
      const spy=vi.spyOn(f.store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
        const stack=new Error().stack??'';
        if(!injected&&stack.includes('readHostObservationBody')&&stack.includes('assertKnowledgeSource')){injected=true;throw Object.assign(new Error('injected contention'),{code});}
        return get(...args);
      }) as typeof f.store.get);
      try{expect(()=>readHostObservation(f.store,host.id,f.project)).toThrowError(expect.objectContaining({code:'knowledge_snapshot_unavailable',status:503}));expect(injected).toBe(true);}finally{spy.mockRestore();}
      expect(f.store.list('actions')).toEqual(before);expect(readHostObservation(f.store,host.id,f.project)).toBeDefined();
    }finally{f.close();}
  });
  it.each(['file','feishu','conversation'] as const)('does not treat passive %s duplicate ingestion as authorization to repeat a held read',async kind=>{
    const f=repositoryKnowledgeFixture();let engine:Workbench|undefined;
    try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      const input={projectId:f.project.id,externalId:`passive-${kind}`,kind,title:'Replay',content:f.source.content,purpose:'reference' as const};engine.ingest(input);
      const get=f.store.get.bind(f.store);let injected=false;
      const spy=vi.spyOn(f.store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{if(!injected&&new Error().stack?.includes('takeRepositoryReadback')){injected=true;throw Object.assign(new Error('post-consumption failure'),{code:'SQLITE_BUSY'});}return get(...args);}) as typeof f.store.get);
      await engine.tick().catch(()=>undefined);spy.mockRestore();expect(injected).toBe(true);
      const requests=f.requests.length;engine.ingest(input);await engine.tick();expect(f.requests).toHaveLength(requests);
      expect(f.store.list('actions').filter(action=>action.kind==='knowledge.host-observation')).toEqual([]);
    }finally{await engine?.shutdown();f.close();}
  });
  it('does not automatically repeat a consumed repository read across ticks or reopen; explicit task retry can recover',async()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-held-read-')),seed=repositoryKnowledgeFixture(),project=seed.project,content=seed.source.content;seed.close();
    let store=new Store(join(root,'db')),f=repositoryKnowledgeFixture('github',{store,project}),engine:Workbench|undefined;
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      const input={projectId:project.id,externalId:'held-read',title:'Held',content,purpose:'task' as const};const task=engine.ingest(input)!;
      const get=store.get.bind(store);let injected=false;
      const spy=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
        if(!injected&&new Error().stack?.includes('takeRepositoryReadback')){injected=true;throw Object.assign(new Error('post-consumption contention'),{code:'SQLITE_BUSY_SNAPSHOT'});}
        return get(...args);
      }) as typeof store.get);
      await engine.tick().catch(()=>undefined);spy.mockRestore();expect(injected).toBe(true);
      const firstRequests=f.requests.length;expect(firstRequests).toBeGreaterThan(0);
      for(let i=0;i<48;i++){vi.setSystemTime(new Date(Date.now()+750));await engine.tick().catch(()=>undefined);}
      expect(f.requests).toHaveLength(firstRequests);
      expect(store.list('actions').filter(value=>value.kind==='knowledge.host-observation')).toEqual([]);
      await engine.shutdown();store.close();store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      for(let i=0;i<4;i++){vi.setSystemTime(new Date(Date.now()+750));await engine.tick();}
      expect(f.requests).toEqual([]);
      const held=store.list('actions').find(action=>action.kind==='knowledge.structured-ingest')!;
      const read=store.get.bind(store),badJob=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof read>)=>{const value=read(...args);return args[0]==='actions'&&args[1]===held.id?{...held,payload:{...held.payload,sourceHash:'0'.repeat(64)}}:value;}) as typeof store.get);
      try{expect(()=>engine!.retry(task.id)).toThrow();}finally{badJob.mockRestore();}
      expect(store.get('actions',held.id)?.payload.errorCode).toBe('knowledge_read_inflight');
      store.save('projects',{...project,trustedChecks:[]});
      expect(()=>engine!.retry(task.id)).toThrow();expect(store.get('actions',held.id)?.payload.errorCode).toBe('knowledge_read_inflight');
      store.save('projects',project);
      const liveTask=store.get('tasks',task.id)!,liveSource=store.get('sources',task.sourceId)!;store.save('tasks',{...liveTask,status:'blocked'});
      const currentGet=store.get.bind(store),badSource=vi.spyOn(store,'get').mockImplementation(((...args:Parameters<typeof currentGet>)=>{const value=currentGet(...args);return args[0]==='sources'&&args[1]===liveSource.id?{...liveSource,content:`${liveSource.content} changed`}:value;}) as typeof store.get);
      try{expect(()=>engine!.retry(task.id)).toThrow();}finally{badSource.mockRestore();}
      expect(store.get('actions',held.id)?.payload.errorCode).toBe('knowledge_read_inflight');
      engine.retry(task.id);await engine.tick();
      expect(f.requests.length).toBeGreaterThan(0);
      expect(store.list('actions').some(value=>value.kind==='knowledge.host-observation')).toBe(true);
      await engine.shutdown();
    }finally{vi.useRealTimers();await engine?.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
  });
  it.each(['pause','shutdown'] as const)('drains an abort-ignoring sibling before %s and permits a later explicit recovery',async lifecycle=>{
    const f=repositoryKnowledgeFixture();let releaseFail!:()=>void,releaseSibling!:()=>void,enteredSibling!:()=>void;
    const failGate=new Promise<void>(resolve=>{releaseFail=resolve;}),siblingGate=new Promise<void>(resolve=>{releaseSibling=resolve;}),siblingEntered=new Promise<void>(resolve=>{enteredSibling=resolve;});
    let running:Promise<unknown>|undefined,engine:Workbench|undefined;
    try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const reader={async read(...args:Parameters<typeof f.reader.read>){
        const result=await f.reader.read(...args);
        if(args[1].externalId==='contention'){await failGate;return result;}
        enteredSibling();await siblingGate;return result;
      }};
      engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:reader});
      const input={projectId:f.project.id,externalId:'contention',title:'Failing',content:f.source.content,purpose:'task' as const};
      const task=engine.ingest(input)!;engine.ingest({...input,externalId:'held',title:'Held'});
      const source=f.store.list('sources').find(value=>value.externalId==='contention')!,get=f.store.get.bind(f.store);let injected=false;
      const spy=vi.spyOn(f.store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
        if(!injected&&args[0]==='sources'&&args[1]===source.id&&new Error().stack?.includes('takeRepositoryReadback')){injected=true;throw Object.assign(new Error('post-consumption contention'),{code:'SQLITE_BUSY_SNAPSHOT'});}
        return get(...args);
      }) as typeof f.store.get);
      running=engine.drainStructuredKnowledge().then(()=>undefined,error=>error);
      await siblingEntered;releaseFail();
      for(let i=0;i<200;i++)await Promise.resolve();
      expect(injected).toBe(true);
      let finished=false;const ending=(lifecycle==='pause'?engine.pause():engine.shutdown()).then(value=>{finished=true;return value;});
      for(let i=0;i<200;i++)await Promise.resolve();
      expect(finished).toBe(false);
      expect(await engine.drainStructuredKnowledge()).toBe(0);
      releaseSibling();const error=await running;running=undefined;const resume=await ending;if(resume)resume();spy.mockRestore();
      expect(error).toMatchObject({code:'knowledge_snapshot_unavailable'});
      expect(f.store.list('actions').filter(value=>value.kind==='knowledge.host-observation')).toEqual([]);
      const requests=f.requests.length;
      for(let i=0;i<4;i++)await engine.tick();
      expect(f.requests).toHaveLength(requests);
      if(lifecycle==='shutdown')engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:reader});
      engine.retry(task.id);await engine.drainStructuredKnowledge();
      expect(f.requests.length).toBeGreaterThan(requests);
      expect(f.store.list('actions').some(value=>value.kind==='knowledge.host-observation')).toBe(true);
      await engine.shutdown();
    }finally{releaseFail();releaseSibling();if(running)await running;await engine?.shutdown();f.close();}
  });
  it.each(['SQLITE_BUSY','SQLITE_LOCKED_SHAREDCACHE','SQLITE_SCHEMA'])('does not redact a structured card when dependency validation receives %s',async code=>{
    const f=repositoryKnowledgeFixture();try{
      expect(await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal)).toBe('processed');
      const card=f.store.list('cards').find(value=>value.id.startsWith('knowledge-structured-card:'))!;
      const get=f.store.get.bind(f.store);
      const spy=vi.spyOn(f.store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
        if(new Error().stack?.includes('structuredRepositoryRequest'))throw Object.assign(new Error('injected SQLite failure'),{code});
        return get(...args);
      }) as typeof f.store.get);
      expect(()=>f.store.save('cards',card)).toThrowError(expect.objectContaining({code}));
      spy.mockRestore();
      expect(f.store.get('cards',card.id)).toEqual(card);
    }finally{f.close();}
  });
  it.each(['source-save','job-delete'] as const)('rolls back %s when structured-card protection encounters SQLite contention',async operation=>{
    const f=repositoryKnowledgeFixture();try{
      expect(await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal)).toBe('processed');
      const card=f.store.list('cards').find(value=>value.id.startsWith('knowledge-structured-card:'))!,job=f.store.list('actions').find(value=>value.kind==='knowledge.structured-ingest')!,beforeSource=f.store.get('sources',f.source.id);
      const get=f.store.get.bind(f.store);let injected=false;
      const spy=vi.spyOn(f.store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
        if(!injected&&new Error().stack?.includes('structuredCardDependencyState')&&args[0]==='sources'){injected=true;throw Object.assign(new Error('protection contention'),{code:'SQLITE_BUSY'});}
        return get(...args);
      }) as typeof f.store.get);
      try{
        if(operation==='source-save')expect(()=>f.store.save('sources',{...f.source,title:'changed'})).toThrowError(expect.objectContaining({code:'knowledge_snapshot_unavailable'}));
        else expect(()=>f.store.delete('actions',job.id)).toThrowError(expect.objectContaining({code:'knowledge_snapshot_unavailable'}));
        expect(injected).toBe(true);
      }finally{spy.mockRestore();}
      expect(f.store.get('sources',f.source.id)).toEqual(beforeSource);expect(f.store.get('actions',job.id)).toEqual(job);expect(f.store.get('cards',card.id)).toEqual(card);
    }finally{f.close();}
  });
  it('enqueues a reference once and processes it without model workers', async () => {
    const f = repositoryKnowledgeFixture();
    try {
      const config = readConfig({ PATRICK_MODE: 'demo' }); configureDemo(config); config.projects = [f.project];
      const engine = new Workbench({ store: f.store, config, workers: [], writer: demoWriter, research: demoResearch, repositoryKnowledgeReader: f.reader });
      const input = { projectId: f.project.id, externalId: 'reference', title: 'Reference', content: f.source.content, purpose: 'reference' as const };
      expect(engine.ingest(input)).toBeUndefined(); expect(engine.ingest(input)).toBeUndefined();
      expect(f.store.list('tasks')).toHaveLength(0);
      expect(f.store.list('actions').filter(a => a.kind === 'knowledge.structured-ingest')).toHaveLength(1);
      await engine.tick();
      expect(f.store.list('actions').find(a => a.kind === 'knowledge.structured-ingest')?.payload.phase).toBe('processed');
      expect(f.store.list('actions').filter(a => a.kind === 'knowledge.host-observation').length).toBeGreaterThan(0);
      expect(f.store.list('attempts')).toHaveLength(0);
    } finally { f.close(); }
  });

  it('classifies ordinary references and runs ordinary task extraction once without a reader', async () => {
    const f=repositoryKnowledgeFixture();try{
      const project={...f.project,budgetUsd:10};f.store.save('projects',project);
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      const worker=new DemoWorker('grok'),calls:string[]=[];
      const engine=new Workbench({store:f.store,config,workers:[{name:'grok',async run(input){calls.push(input.role);return worker.run(input);}}],writer:demoWriter,research:demoResearch});
      engine.ingest({projectId:project.id,externalId:'ordinary-ref',title:'Reference',content:'Ordinary reference.',purpose:'reference'});
      const task=engine.ingest({projectId:project.id,externalId:'ordinary-task',title:'Task',content:'Ordinary task.'})!;
      await engine.tick();
      expect(calls).toEqual(['knowledge_extract']);expect(f.store.get('tasks',task.id)?.stage).toBe('case_extract');
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest').map(a=>a.payload.phase)).toEqual(['ordinary','ordinary']);
    }finally{f.close();}
  });

  it.each(['missing-reader','denied-egress'] as const)('publishes only pending locators with %s and no model work',async mode=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.runnerPolicies=config.runnerPolicies.map(p=>({...p,admitted:false}));
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,...(mode==='denied-egress'?{repositoryKnowledgeReader:f.reader,canRun:()=>false}:{})});
      engine.ingest({projectId:f.project.id,externalId:mode,title:'Reference',content:f.source.content,purpose:'reference'});
      await engine.runUntilIdle();
      const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      expect(job).toMatchObject({status:'pending',payload:{phase:'pending-readback',tries:1,errorCode:mode==='denied-egress'?'host_egress_unavailable':'repository_reader_unavailable'}});
      expect(Date.parse(job.payload.runAfter as string)).toBeGreaterThan(Date.now());
      expect(f.store.list('cards').filter(c=>c.pendingClaim).length).toBeGreaterThan(0);
      expect(f.store.list('cards').every(c=>!c.claim)).toBe(true);
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.host-observation'||a.kind==='experience.test-observation')).toEqual([]);
      expect(f.store.list('attempts')).toEqual([]);expect(f.requests).toEqual([]);
    }finally{f.close();}
  });

  it('records malformed recognized input as invalid and never falls back to a worker',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const calls:string[]=[];const worker=new DemoWorker('grok');
      const engine=new Workbench({store:f.store,config,workers:[{name:'grok',async run(input){calls.push(input.role);return worker.run(input);}}],writer:demoWriter,research:demoResearch});
      const task=engine.ingest({projectId:f.project.id,externalId:'bad',title:'Bad',content:'{"schemaVersion":1,"kind":"repository-facts"}'})!;
      await engine.runUntilIdle();
      expect(f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')).toMatchObject({status:'completed',payload:{phase:'invalid',errorCode:'invalid_structured_knowledge'}});
      expect(f.store.get('tasks',task.id)?.status).toBe('blocked');expect(calls).toEqual([]);expect(f.store.list('attempts')).toEqual([]);
    }finally{f.close();}
  });

  it('blocks a task with a malformed stored job without spinning or dispatching a worker',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch});
      const task=engine.ingest({projectId:f.project.id,externalId:'corrupt-job',title:'Task',content:'ordinary'})!;
      const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      f.store.save('actions',{...job,payload:{...job.payload,schemaVersion:9}});
      await engine.runUntilIdle(3);expect(f.store.get('tasks',task.id)?.status).toBe('blocked');expect(f.store.list('attempts')).toEqual([]);
    }finally{f.close();}
  });

  it.each(['source','policy','candidate'] as const)('rejects an in-flight %s change before committing observations',async kind=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest({projectId:f.project.id,externalId:'race',title:'Race',content:f.source.content,purpose:'reference'});
      const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      f.setAfter(path=>{if(path!=='')return;f.setAfter(undefined);
        if(kind==='source'){const s=f.store.get('sources',job.payload.sourceId as string)!;f.store.save('sources',{...s,content:s.content+' '});}
        if(kind==='policy')f.store.save('projects',{...f.project,trustedChecks:[]});
        if(kind==='candidate'){const c=f.store.list('cards')[0]!;f.store.save('cards',{...c,body:'changed during read'});}
      });
      await engine.tick();
      expect(f.store.list('actions').filter(a=>['knowledge.host-observation','knowledge.evidence-link','experience.test-observation'].includes(a.kind))).toEqual([]);
      expect(f.store.get('actions',job.id)?.payload.phase).not.toBe('processed');expect(f.store.list('attempts')).toEqual([]);
      if(kind==='policy')expect(f.store.get('actions',job.id)).toMatchObject({status:'pending',payload:{phase:'pending-readback',errorCode:'repository_readback_failed'}});
    }finally{f.close();}
  });

  it('rolls back all admitted observations when the job is deleted during readback',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest({projectId:f.project.id,externalId:'removed-job',title:'Race',content:f.source.content,purpose:'reference'});
      const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      f.setAfter(path=>{if(path===''){f.setAfter(undefined);f.store.delete('actions',job.id);}});
      await engine.tick();
      expect(f.store.list('actions').filter(a=>['knowledge.host-observation','knowledge.evidence-link','experience.test-observation'].includes(a.kind))).toEqual([]);
    }finally{f.close();}
  });

  it('does not bind a candidate edited before a retry or spin on it',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const first=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch});
      first.ingest({projectId:f.project.id,externalId:'edited-candidate',title:'Reference',content:f.source.content,purpose:'reference'});await first.tick();
      const card=f.store.list('cards').find(c=>c.pendingClaim)!,job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      f.store.save('cards',{...card,body:'Modified before retry'});f.store.save('actions',{...job,payload:{...job.payload,runAfter:new Date(0).toISOString()}});
      const second=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      await second.runUntilIdle(3);
      expect(f.requests).toEqual([]);expect(f.store.list('actions').filter(a=>['knowledge.host-observation','knowledge.evidence-link','experience.test-observation'].includes(a.kind))).toEqual([]);
    }finally{f.close();}
  });

  it('redacts an in-flight withdrawn reference and refuses the old revision',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      const input={projectId:f.project.id,externalId:'withdrawn',revision:'v1',title:'Withdrawn',content:f.source.content,purpose:'reference' as const};
      engine.ingest(input);const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!,sourceId=job.payload.sourceId as string;
      f.setAfter(path=>{if(path===''){f.setAfter(undefined);engine.withdraw(sourceId);}});await engine.tick();
      expect(f.store.get('sources',sourceId)?.status).toBe('withdrawn');
      expect(f.store.list('actions').filter(a=>['knowledge.host-observation','knowledge.evidence-link','experience.test-observation'].includes(a.kind))).toEqual([]);
      expect(f.store.get('actions',job.id)).toMatchObject({status:'completed',payload:{retracted:true}});
      expect(()=>engine.ingest(input)).toThrow();expect(f.store.list('attempts')).toEqual([]);
    }finally{f.close();}
  });

  it('rejects a duplicate revision with a different purpose before changing its job',()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch});
      const input={projectId:f.project.id,externalId:'purpose',revision:'v1',title:'Purpose',content:'ordinary',purpose:'reference' as const};engine.ingest(input);
      const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      expect(()=>engine.ingest({...input,purpose:'task'})).toThrow();expect(f.store.get('actions',job.id)).toEqual(job);expect(f.store.list('tasks')).toEqual([]);
    }finally{f.close();}
  });

  it('recreates a temporary source job after the original content is reaccepted',async()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-restored-'));const fixture=repositoryKnowledgeFixture();const project=fixture.project;fixture.close();
    let store=new Store(join(root,'db'));try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
      const input={projectId:project.id,externalId:'temporary',title:'Temporary',content:'Temporary ordinary text',retention:'ephemeral' as const};
      const task=engine.ingest(input)!,first=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      await engine.shutdown();store.close();store=new Store(join(root,'db'));
      expect(store.get('sources',task.sourceId)?.content).toBe('');expect(store.get('actions',first.id)).toBeUndefined();
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});const restored=engine.ingest(input)!;
      expect(restored.id).toBe(task.id);expect(store.get('actions',first.id)?.status).toBe('pending');
      expect(await engine.drainStructuredKnowledge()).toBe(1);expect(store.get('actions',first.id)?.payload.phase).toBe('ordinary');await engine.shutdown();
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('retries the same job after readback failure without storing provider errors',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest({projectId:f.project.id,externalId:'retry',title:'Retry',content:f.source.content,purpose:'reference'});
      f.setOverride(path=>path===''?new Response('PRIVATE_REMOTE_ERROR',{status:503}):undefined);await engine.tick();
      const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      expect(job).toMatchObject({status:'pending',payload:{phase:'pending-readback',tries:1,errorCode:'repository_readback_failed'}});
      expect(JSON.stringify(job)).not.toContain('PRIVATE_REMOTE_ERROR');
      f.setOverride(undefined);f.store.save('actions',{...job,payload:{...job.payload,runAfter:new Date(0).toISOString()}});await engine.tick();
      expect(f.store.get('actions',job.id)).toMatchObject({status:'completed',payload:{phase:'processed',tries:1}});
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest')).toHaveLength(1);
      expect(f.store.list('attempts')).toEqual([]);
    }finally{f.close();}
  });

  it('refreshes an authorized current change through the same reader without changing its completed ingest job',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      expect(await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal)).toBe('processed');
      const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!,before=structuredClone(job);
      f.routes['/merge_requests/17/pipelines']=[{id:53,sha:H2}];
      f.routes['/pipelines/53']={...f.routes['/pipelines/52'],id:53,sha:H2};
      f.routes['/jobs/72']={...f.routes['/jobs/71'],id:72,pipeline:{id:53,project_id:42,sha:H2},commit:{id:H2}};
      f.routes['/pipelines/53/jobs']=[{...f.routes['/pipelines/52/jobs'][0],id:72,pipeline:{id:53,project_id:42,sha:H2},commit:{id:H2}}];
      const count=f.store.list('actions').filter(a=>a.kind==='knowledge.host-observation').length;
      expect(await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal,{refresh:'current'})).toBe('processed');
      expect(f.store.get('actions',job.id)).toEqual(before);
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest')).toHaveLength(1);
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.host-observation').length).toBeGreaterThan(count);
      expect(f.store.list('attempts')).toEqual([]);
    }finally{f.close();}
  });

  it('limits each drain to four jobs and applies pause and shutdown leases',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch});
      for(let i=0;i<6;i++)engine.ingest({projectId:f.project.id,externalId:`ref-${i}`,title:'Reference',content:`Ordinary ${i}`,purpose:'reference'});
      const resume=await engine.pause();expect(await engine.drainStructuredKnowledge()).toBe(0);resume();
      expect(await engine.drainStructuredKnowledge(99)).toBe(4);
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest'&&a.status==='completed')).toHaveLength(4);
      await engine.shutdown();expect(await engine.drainStructuredKnowledge()).toBe(0);
    }finally{f.close();}
  });
  it('keeps the fixed 30-second host abort and rejects a late result',async()=>{
    const f=repositoryKnowledgeFixture(),timeout=new AbortController();let release!:()=>void,entered!:()=>void,running:Promise<number>|undefined,engine:Workbench|undefined;
    const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const spy=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{expect(ms).toBe(30_000);return timeout.signal;});
    try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const reader={async read(...args:Parameters<typeof f.reader.read>){const result=await f.reader.read(...args);entered();await held;return result;}};
      engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:reader});
      engine.ingest({projectId:f.project.id,externalId:'timeout-held',title:'Held',content:f.source.content,purpose:'reference'});
      running=engine.drainStructuredKnowledge();await started;timeout.abort();expect(await running).toBe(1);running=undefined;
      expect(spy).toHaveBeenCalledWith(30_000);const before=f.store.list('actions');release();for(let i=0;i<100;i++)await Promise.resolve();
      expect(f.store.list('actions')).toEqual(before);expect(before.filter(value=>value.kind==='knowledge.host-observation')).toEqual([]);
    }finally{spy.mockRestore();release();if(running)await running;await engine?.shutdown();f.close();}
  });

  it('includes the selected task job within the four-job tick limit',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      for(let i=0;i<5;i++)engine.ingest({projectId:f.project.id,externalId:`early-${i}`,title:'Reference',content:`Ordinary ${i}`,purpose:'reference'});
      const task=engine.ingest({projectId:f.project.id,externalId:'selected',title:'Selected',content:f.source.content})!;await engine.tick();
      expect(f.store.get('tasks',task.id)?.stage).toBe('case_extract');
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest'&&a.status==='completed')).toHaveLength(4);
      expect(f.store.list('attempts')).toEqual([]);
    }finally{f.close();}
  });

  it.each(['superseded','withdrawn'] as const)('accepts later same-project readbacks after %s host evidence, including retry and reopen',async mode=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-fix1-retraction-')),seed=repositoryKnowledgeFixture(),project=seed.project,content=seed.source.content;seed.close();
    let store=new Store(join(root,'db'));let f=repositoryKnowledgeFixture('github',{store,project});
    try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      const input={projectId:project.id,externalId:'old',revision:'v1',title:'Old',content,purpose:'reference' as const};
      engine.ingest(input);await engine.tick();
      const old=store.list('actions').filter(a=>a.kind==='knowledge.host-observation');expect(old.length).toBeGreaterThan(0);
      const sourceId=(store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!.payload.sourceId as string);
      if(mode==='superseded')engine.ingest({...input,revision:'v2',title:'New revision'});
      else {engine.withdraw(sourceId);engine.ingest({...input,externalId:'unrelated',title:'Unrelated'});}
      for(const row of old){expect(store.get('actions',row.id)?.payload).toMatchObject({retracted:true});expect(readHostObservation(store,row.id,project)).toBeUndefined();}
      f.setOverride(path=>path===''?new Response('unavailable',{status:503}):undefined);await engine.tick();
      const pending=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest'&&a.status==='pending')!;
      expect(pending.payload).toMatchObject({phase:'pending-readback',tries:1});
      f.setOverride(undefined);store.save('actions',{...pending,payload:{...pending.payload,runAfter:new Date(0).toISOString()}});await engine.tick();
      expect(store.get('actions',pending.id)).toMatchObject({status:'completed',payload:{phase:'processed',tries:1}});
      await engine.shutdown();store.close();store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      for(const row of old)expect(readHostObservation(store,row.id,project)).toBeUndefined();
      engine.ingest({...input,externalId:'after-reopen',title:'After reopen'});await engine.tick();
      expect(store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest'&&a.status==='pending')).toEqual([]);
      expect(store.list('actions').some(a=>a.kind==='knowledge.host-observation'&&!!readHostObservation(store,a.id,project))).toBe(true);
      await engine.shutdown();
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('preempts a preferred task read for a newly ingested unrelated task without a late commit',async()=>{
    const f=repositoryKnowledgeFixture();let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    let first:Promise<void>|undefined,second:Promise<void>|undefined;
    try{
      const project={...f.project,budgetUsd:10};f.store.save('projects',project);
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      const worker=new DemoWorker('grok'),roles:string[]=[],reads:string[]=[];
      const reader={async read(...args:Parameters<typeof f.reader.read>){reads.push(args[1].id);const authentic=await f.reader.read(...args);entered();await gate;return authentic;}};
      const engine=new Workbench({store:f.store,config,workers:[{name:'grok',async run(input){roles.push(input.role);return worker.run(input);}}],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:reader});
      const a=engine.ingest({projectId:project.id,externalId:'preferred-a',title:'A',content:f.source.content})!;
      first=engine.tick();await started;
      await engine.tick();expect(reads).toEqual([a.sourceId]); // A periodic self-tick must not abort A.
      const b=engine.ingest({projectId:project.id,externalId:'ordinary-b',title:'B',content:'ordinary task B'})!;
      let done=false;second=engine.tick().then(()=>{done=true;});
      for(let i=0;i<150;i++)await Promise.resolve();
      expect(done).toBe(true);expect(roles).toContain('knowledge_extract');expect(f.store.get('tasks',b.id)?.stage).toBe('case_extract');
      expect(f.store.get('tasks',a.id)?.stage).toBe('knowledge_extract');
      const job=f.store.list('actions').find(x=>x.kind==='knowledge.structured-ingest'&&x.payload.sourceId===a.sourceId)!;
      expect(job).toMatchObject({status:'pending',payload:{phase:'pending-readback',tries:1}});
      expect(f.store.list('actions').filter(x=>x.kind==='knowledge.host-observation')).toEqual([]);
      const before=JSON.stringify(f.store.list('actions'));release();for(let i=0;i<100;i++)await Promise.resolve();
      expect(JSON.stringify(f.store.list('actions'))).toBe(before);
      await second;second=undefined;await first;first=undefined;await engine.shutdown();
    }finally{release();if(first)await first;if(second)await second;f.close();}
  });

  it.each(['pause','shutdown'] as const)('interrupts a preferred read on %s without advancing the task',async mode=>{
    const f=repositoryKnowledgeFixture();let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let first:Promise<void>|undefined;
    try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const reader={async read(...args:Parameters<typeof f.reader.read>){const authentic=await f.reader.read(...args);entered();await gate;return authentic;}};
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:reader});
      const task=engine.ingest({projectId:f.project.id,externalId:'preferred-control',title:'A',content:f.source.content})!;
      first=engine.tick();await started;
      let finished=false;const ending=(mode==='pause'?engine.pause().then(resume=>{resume();}):engine.shutdown()).then(()=>{finished=true;});
      for(let i=0;i<100;i++)await Promise.resolve();
      expect(finished).toBe(false);
      await first;first=undefined;expect(f.store.get('tasks',task.id)?.stage).toBe('knowledge_extract');
      expect(f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')).toMatchObject({status:'pending',payload:{phase:'pending-readback',tries:1}});
      const before=JSON.stringify(f.store.list('actions'));release();await ending;expect(finished).toBe(true);for(let i=0;i<100;i++)await Promise.resolve();
      expect(JSON.stringify(f.store.list('actions'))).toBe(before);expect(f.store.list('attempts')).toEqual([]);await engine.shutdown();
    }finally{release();if(first)await first;f.close();}
  });

  it('limits unfinished reads across preferred and repeated background preemption while starting unrelated tasks',async()=>{
    const f=repositoryKnowledgeFixture();let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    let first:Promise<void>|undefined,second:Promise<void>|undefined,third:Promise<void>|undefined;
    try{
      const project={...f.project,budgetUsd:10};f.store.save('projects',project);const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      const worker=new DemoWorker('grok'),worked:string[]=[],readIds:string[]=[];let active=0,maximum=0,activeWorkers=0,maximumWorkers=0;
      const reader={async read(...args:Parameters<typeof f.reader.read>){active++;maximum=Math.max(maximum,active);readIds.push(args[1].id);try{const authentic=await f.reader.read(...args);entered();await gate;return authentic;}finally{active--;}}};
      const engine=new Workbench({store:f.store,config,workers:[{name:'grok',async run(input){worked.push(input.task.id);activeWorkers++;maximumWorkers=Math.max(maximumWorkers,activeWorkers);try{return await worker.run(input);}finally{activeWorkers--;}}}],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:reader});
      const a=engine.ingest({projectId:project.id,externalId:'preferred-backlog',title:'A',content:f.source.content})!;
      first=engine.tick();await started;
      for(let i=0;i<8;i++)engine.ingest({projectId:project.id,externalId:`held-backlog-${i}`,title:`Reference ${i}`,content:f.source.content,purpose:'reference'});
      const b=engine.ingest({projectId:project.id,externalId:'unrelated-b',title:'B',content:'ordinary B'})!;
      second=engine.tick();for(let i=0;i<300;i++)await Promise.resolve();
      expect(worked).toContain(b.id);expect(readIds).toHaveLength(4);expect(maximum).toBe(4);
      engine.cancel(b.id);
      const c=engine.ingest({projectId:project.id,externalId:'unrelated-c',title:'C',content:'ordinary C'})!;
      third=engine.tick();for(let i=0;i<300;i++)await Promise.resolve();
      expect(worked).toContain(c.id);expect(readIds).toHaveLength(4);expect(maximum).toBe(4);
      await first;first=undefined;await second;second=undefined;await third;third=undefined;
      expect(worked.filter(id=>id===b.id)).toHaveLength(1);expect(worked.filter(id=>id===c.id)).toHaveLength(1);expect(maximumWorkers).toBe(1);
      expect(f.store.get('tasks',a.id)?.stage).toBe('knowledge_extract');
      const before=JSON.stringify(f.store.list('actions'));release();for(let i=0;i<100;i++)await Promise.resolve();
      expect(JSON.stringify(f.store.list('actions'))).toBe(before);expect(f.store.list('actions').filter(a=>a.kind==='knowledge.host-observation')).toEqual([]);
      await engine.shutdown();
    }finally{release();if(first)await first;if(second)await second;if(third)await third;f.close();}
  });

  it.each(['same-process','reopen','retry'] as const)('rebuilds candidates after a missing job through an authorized duplicate (%s)',async mode=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-fix2-rebuild-')),seed=repositoryKnowledgeFixture(),project=seed.project,content=seed.source.content;seed.close();
    let store=new Store(join(root,'db'));let f=repositoryKnowledgeFixture('github',{store,project});
    try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
      const input={projectId:project.id,externalId:'recover',revision:'v1',title:'Recover',content,purpose:'reference' as const};
      engine.ingest(input);await engine.tick();
      const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!,ids=store.list('cards').map(c=>c.id);
      expect(ids.length).toBeGreaterThan(0);store.delete('actions',job.id);
      expect(ids.every(id=>store.get('cards',id)?.status==='withdrawn')).toBe(true);
      if(mode==='reopen'){await engine.shutdown();store.close();store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});}
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest(input);if(mode==='retry')f.setOverride(path=>path===''?new Response('unavailable',{status:503}):undefined);
      await engine.tick();
      if(mode==='retry'){
        const pending=store.get('actions',job.id)!;expect(pending).toMatchObject({status:'pending',payload:{phase:'pending-readback',tries:1}});
        f.setOverride(undefined);store.save('actions',{...pending,payload:{...pending.payload,runAfter:new Date(0).toISOString()}});await engine.tick();
      }
      expect(store.get('actions',job.id)).toMatchObject({status:'completed',payload:{phase:'processed'}});
      expect(ids.every(id=>store.get('cards',id)?.status==='active')).toBe(true);
      expect(store.list('actions').filter(a=>a.kind==='knowledge.host-observation').length).toBeGreaterThan(0);
      expect(store.list('actions').filter(a=>a.kind==='knowledge.evidence-link').length).toBeGreaterThan(0);
      expect(store.list('attempts')).toEqual([]);await engine.shutdown();
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('reclassifies an ordinary reference after its completed job is deleted and reaccepted',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      const input={projectId:f.project.id,externalId:'ordinary-recovery',title:'Ordinary',content:'An ordinary reference.',purpose:'reference' as const};
      engine.ingest(input);await engine.tick();const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      expect(job).toMatchObject({status:'completed',payload:{phase:'ordinary'}});f.store.delete('actions',job.id);
      engine.ingest(input);await engine.tick();expect(f.store.get('actions',job.id)).toMatchObject({status:'completed',payload:{phase:'ordinary'}});
      expect(f.requests).toEqual([]);expect(f.store.list('cards')).toEqual([]);expect(f.store.list('attempts')).toEqual([]);await engine.shutdown();
    }finally{f.close();}
  });

  it('requires a fresh authenticated read to replace links after a processed job disappears',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const input={projectId:f.project.id,externalId:'processed-recovery',title:'Reference',content:f.source.content,purpose:'reference' as const};
      let engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest(input);await engine.tick();const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!,oldLinks=f.store.list('actions').filter(a=>a.kind==='knowledge.evidence-link');
      expect(oldLinks.length).toBeGreaterThan(0);f.store.delete('actions',job.id);
      expect(oldLinks.every(link=>f.store.get('actions',link.id)?.payload.retracted===true)).toBe(true);
      const before=f.requests.length;engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest(input);await engine.tick();expect(f.requests.length).toBeGreaterThan(before);
      expect(f.store.get('actions',job.id)).toMatchObject({status:'completed',payload:{phase:'processed'}});
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.evidence-link').every(a=>a.payload.retracted!==true)).toBe(true);
      expect(f.store.list('cards').filter(c=>c.sourceId===job.payload.sourceId).every(c=>c.status==='active')).toBe(true);await engine.shutdown();
    }finally{f.close();}
  });

  it('starts an unrelated ready task while background readers are held and counts at most four host jobs',async()=>{
    const f=repositoryKnowledgeFixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let running:Promise<void>|undefined;
    try{
      const project={...f.project,budgetUsd:10};f.store.save('projects',project);
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      const worker=new DemoWorker('grok'),roles:string[]=[],started:string[]=[];
      const reader={async read(...args:Parameters<typeof f.reader.read>){started.push(args[1].id);await gate;return f.reader.read(...args);}};
      const engine=new Workbench({store:f.store,config,workers:[{name:'grok',async run(input){roles.push(input.role);return worker.run(input);}}],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:reader});
      const task=engine.ingest({projectId:project.id,externalId:'ready',title:'Ready',content:'ordinary task'})!;await engine.tick();expect(f.store.get('tasks',task.id)?.stage).toBe('case_extract');
      for(let i=0;i<5;i++)engine.ingest({projectId:project.id,externalId:`held-${i}`,title:`Held ${i}`,content:f.source.content,purpose:'reference'});
      running=engine.tick();for(let i=0;i<40;i++)await Promise.resolve();
      expect(roles).toContain('case_extract');expect(started.length).toBeLessThanOrEqual(4);
      release();await running;running=undefined;
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest'&&a.payload.phase==='processed')).toHaveLength(4);
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest'&&a.status==='pending')).toHaveLength(1);
      await engine.shutdown();
    }finally{release();if(running)await running;f.close();}
  });

  it.each(['pause','shutdown','ready-task'] as const)('aborts an ignoring reader for %s without a late commit',async mode=>{
    const f=repositoryKnowledgeFixture();let release!:()=>void,started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    let drain:Promise<number>|undefined;
    try{
      const project={...f.project,budgetUsd:10};f.store.save('projects',project);
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      const worker=new DemoWorker('grok'),roles:string[]=[];
      const reader={async read(...args:Parameters<typeof f.reader.read>){const authentic=await f.reader.read(...args);started();await gate;return authentic;}};
      const engine=new Workbench({store:f.store,config,workers:[{name:'grok',async run(input){roles.push(input.role);return worker.run(input);}}],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:reader});
      engine.ingest({projectId:project.id,externalId:'held-ignore',title:'Held',content:f.source.content,purpose:'reference'});
      drain=engine.drainStructuredKnowledge();await entered;
      let completed=false;let operation:Promise<unknown>;
      if(mode==='pause')operation=engine.pause().then(resume=>{completed=true;resume();});
      else if(mode==='shutdown')operation=engine.shutdown().then(()=>{completed=true;});
      else {engine.ingest({projectId:project.id,externalId:'new-ready',title:'Ready',content:'ordinary task'});operation=engine.tick().then(()=>{completed=true;});}
      for(let i=0;i<100;i++)await Promise.resolve();
      expect(completed).toBe(mode==='ready-task');if(mode==='ready-task')expect(roles).toContain('knowledge_extract');
      await drain;drain=undefined;
      const before=JSON.stringify(f.store.list('actions'));release();await operation;expect(completed).toBe(true);for(let i=0;i<100;i++)await Promise.resolve();
      expect(JSON.stringify(f.store.list('actions'))).toBe(before);
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.host-observation'||a.kind==='experience.test-observation')).toEqual([]);
      expect(f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest'&&a.payload.sourceId!==undefined&&a.status==='pending')).toMatchObject({payload:{phase:'pending-readback',tries:1}});
      await engine.shutdown();
    }finally{release();if(drain)await drain;f.close();}
  });

  it('services the task and advances repeated four-job backlogs without retrying unavailable reads early',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const project={...f.project,budgetUsd:10};f.store.save('projects',project);const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      const worker=new DemoWorker('grok'),roles:string[]=[];
      const engine=new Workbench({store:f.store,config,workers:[{name:'grok',async run(input){roles.push(input.role);return worker.run(input);}}],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      f.setOverride(path=>path===''?new Response('unavailable',{status:503}):undefined);
      for(let i=0;i<9;i++)engine.ingest({projectId:project.id,externalId:`backlog-${i}`,title:`Backlog ${i}`,content:f.source.content,purpose:'reference'});
      const task=engine.ingest({projectId:project.id,externalId:'task-fairness',title:'Task',content:'Ordinary task.'})!;
      for(const expected of [3,7,9]){await engine.tick();expect(f.requests.filter(r=>r.url.pathname==='/repos/owner/repo')).toHaveLength(expected);}
      expect(roles.slice(0,2)).toEqual(['knowledge_extract','case_extract']);expect(f.store.get('tasks',task.id)?.stage).not.toBe('knowledge_extract');
      const failed=f.store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest'&&a.payload.errorCode==='repository_readback_failed');
      expect(failed).toHaveLength(9);expect(failed.every(a=>a.payload.tries===1&&Date.parse(a.payload.runAfter as string)>Date.now())).toBe(true);
      await engine.shutdown();
    }finally{f.close();}
  });

  it('signals an abort-aware background reader and settles the lease on shutdown',async()=>{
    const f=repositoryKnowledgeFixture();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let aborted=false,drain:Promise<number>|undefined;
    try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const reader={read(_project:Parameters<typeof f.reader.read>[0],_source:Parameters<typeof f.reader.read>[1],_request:Parameters<typeof f.reader.read>[2],signal:AbortSignal){entered();return new Promise<Awaited<ReturnType<typeof f.reader.read>>>((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));}};
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:reader});
      engine.ingest({projectId:f.project.id,externalId:'abort-aware',title:'Held',content:f.source.content,purpose:'reference'});
      drain=engine.drainStructuredKnowledge();await started;await engine.shutdown();expect(await drain).toBe(1);drain=undefined;
      expect(aborted).toBe(true);expect(f.store.list('actions').filter(a=>a.kind==='knowledge.host-observation')).toEqual([]);
      expect(f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')).toMatchObject({status:'pending',payload:{phase:'pending-readback',tries:1}});
    }finally{if(drain)await drain;f.close();}
  });
});
