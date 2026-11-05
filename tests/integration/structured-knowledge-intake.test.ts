import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../../src/config.js';
import { configureDemo, demoResearch, demoWriter, DemoWorker } from '../../src/demo.js';
import { Workbench } from '../../src/orchestrator.js';
import { ingestStructuredKnowledge } from '../../src/knowledge.js';
import { Store } from '../../src/store.js';
import { readHostObservation } from '../../src/knowledge-records.js';
import { repositoryKnowledgeFixture, H2 } from '../fixtures/repository-knowledge.js';

describe('shared structured host intake', () => {
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
      if(mode==='pause'){const resume=await engine.pause();resume();}else await engine.shutdown();
      await first;first=undefined;expect(f.store.get('tasks',task.id)?.stage).toBe('knowledge_extract');
      expect(f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')).toMatchObject({status:'pending',payload:{phase:'pending-readback',tries:1}});
      const before=JSON.stringify(f.store.list('actions'));release();for(let i=0;i<100;i++)await Promise.resolve();
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
      expect(completed).toBe(true);if(mode==='ready-task')expect(roles).toContain('knowledge_extract');
      await operation;await drain;drain=undefined;
      const before=JSON.stringify(f.store.list('actions'));release();for(let i=0;i<100;i++)await Promise.resolve();
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
