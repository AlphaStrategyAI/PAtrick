import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { readConfig } from '../../src/config.js';
import { configureDemo, demoResearch, demoWriter, DemoWorker } from '../../src/demo.js';
import { createApp } from '../../src/app.js';
import { Workbench } from '../../src/orchestrator.js';
import { Store } from '../../src/store.js';
import { withdrawSource } from '../../src/intake.js';
import { digest } from '../../src/domain.js';
import { canonicalCiTestPayloadSchema, canonicalHostPayloadSchema, canonicalKnowledgePayloadSchema, hostObservationId, readHostObservation } from '../../src/knowledge-records.js';
import type { HostObservation } from '../../src/knowledge-contract.js';
import { acceptRepositoryReadback, linkKnowledgeEvidence } from '../../src/knowledge-evidence.js';
import type { RepositoryKnowledgeReader } from '../../src/integrations/repository-knowledge.js';
import { ingestStructuredExperience, parseStructuredExperience, readExperienceCi } from '../../src/integrations/experience-ci.js';
import { repositoryKnowledgeFixture, H, reportPath } from '../fixtures/repository-knowledge.js';

function envelope(projectId:string,repository:string,extra:Record<string,unknown>={}){
  return JSON.stringify({schemaVersion:1,quote:'Report',details:{schemaVersion:1,problem:'A problem',symptomAliases:['problem'],solution:'A reported fix',files:['docs/test.ts'],productId:projectId,codeVersion:H,environment:'reported',invalidationConditions:['changed']},repository,headSha:H,runId:'52',jobId:'71',checkIds:['validate'],...extra});
}

describe('structured experience host intake', () => {
  it('advances an authenticated structured task without knowledge extraction', async () => {
    const f = repositoryKnowledgeFixture();
    try {
      const config = readConfig({ PATRICK_MODE: 'demo' }); configureDemo(config); config.projects = [f.project];
      const engine = new Workbench({ store: f.store, config, workers: [], writer: demoWriter, research: demoResearch, repositoryKnowledgeReader: f.reader });
      const content = envelope(f.project.id,f.project.repository);
      const task = engine.ingest({ projectId: f.project.id, externalId: 'experience', title: 'Report', content })!;
      await engine.tick();
      expect(f.store.get('tasks', task.id)?.stage).toBe('case_extract');
      expect(f.store.list('attempts')).toHaveLength(0);
      expect(f.store.list('cards').some(c => c.kind === 'experience' && c.experience?.solution === 'A reported fix')).toBe(true);
      expect(f.store.list('actions').some(a => a.kind === 'experience.test-observation')).toBe(true);
    } finally { f.close(); }
  });

  it('keeps an experience pending without a reader and does not fabricate a check result',async()=>{
    const f=repositoryKnowledgeFixture();try{
      f.source.content=envelope(f.project.id,f.project.repository);f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,undefined,f.source.id,new AbortController().signal)).toBe(false);
      expect(f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')).toMatchObject({status:'pending',payload:{phase:'pending-readback',errorCode:'repository_reader_unavailable'}});
      expect(f.store.list('cards').find(c=>c.kind==='experience')?.experience?.solution).toBe('A reported fix');
      expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation'||a.kind==='knowledge.host-observation')).toEqual([]);
      expect(f.requests).toEqual([]);expect(f.store.list('attempts')).toEqual([]);
    }finally{f.close();}
  });

  it('uses the same one-use reader identity and retains actual GitLab test-report details',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      f.source.content=envelope(f.project.id,f.project.repository,{testReportPath:reportPath});f.store.save('sources',f.source);
      const input=parseStructuredExperience(f.source,f.project)!;
      const readback=await readExperienceCi(f.reader,f.store,f.project,f.source,input,new AbortController().signal);
      const ids=acceptRepositoryReadback(f.store,f.source.id,readback);
      const ci=f.store.list('actions').find(a=>a.kind==='experience.test-observation')!;
      expect(ci.payload).toMatchObject({observation:{snapshot:{revision:H},environment:{observed:{node:'24'},unknown:['browser']},checks:[{testFile:'docs/test.ts',result:'success'}],comparable:{snapshotDigest:expect.any(String),testDefinitionDigest:expect.any(String)}}});
      expect((ci.payload.hostObservationIds as string[]).every(id=>ids.includes(id))).toBe(true);
      expect((ci.payload.hostObservationIds as string[])).toHaveLength(2);
      expect(()=>acceptRepositoryReadback(f.store,f.source.id,readback)).toThrow();
    }finally{f.close();}
  });

  it('does not admit observations from an untrusted CI producer',async()=>{
    const f=repositoryKnowledgeFixture();try{
      f.source.content=envelope(f.project.id,f.project.repository);f.store.save('sources',f.source);f.routes['/check-runs/99'].app.id=999;
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(false);
      expect(f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')).toMatchObject({status:'pending',payload:{phase:'pending-readback'}});
      expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation'||a.kind==='knowledge.host-observation')).toEqual([]);
    }finally{f.close();}
  });

  it('retains only narrow CI when a test definition is not attested',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');try{
      f.source.content=envelope(f.project.id,f.project.repository,{testReportPath:reportPath});f.store.save('sources',f.source);
      f.report.definitions[0]!.command='a different definition';
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const ci=f.store.list('actions').find(a=>a.kind==='experience.test-observation')!;
      expect((ci.payload.observation as any).comparable).toBeUndefined();
      expect(f.store.list('actions').filter(a=>a.kind==='experience.evidence-link')).toEqual([]);
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.host-observation').map(a=>(a.payload.observation as any).claim.kind)).not.toContain('test-result');
    }finally{f.close();}
  });

  it('rejects a structured experience for another product before any readback',async()=>{
    const f=repositoryKnowledgeFixture();try{
      f.source.content=envelope('foreign',f.project.repository);f.store.save('sources',f.source);
      await expect(ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).rejects.toMatchObject({code:'invalid_structured_knowledge'});
      expect(f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')).toMatchObject({status:'completed',payload:{phase:'invalid'}});
      expect(f.requests).toEqual([]);expect(f.store.list('cards')).toEqual([]);
    }finally{f.close();}
  });

  it('rejects source-controlled refresh authority',async()=>{
    const f=repositoryKnowledgeFixture();try{
      f.source.content=envelope(f.project.id,f.project.repository,{refresh:'current'});f.store.save('sources',f.source);
      await expect(ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).rejects.toMatchObject({code:'invalid_structured_knowledge'});
      expect(f.requests).toEqual([]);expect(f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')?.payload.phase).toBe('invalid');
    }finally{f.close();}
  });

  it.each(['edit','revision','withdrawal'] as const)('rejects an in-flight issue %s before committing the readback',async kind=>{
    const f=repositoryKnowledgeFixture();try{
      const issue={...f.source,id:'issue',externalId:'issue',content:'Issue resolution',title:'Issue'};f.store.save('sources',issue);
      f.source.content=envelope(f.project.id,f.project.repository,{issueId:issue.id});f.store.save('sources',f.source);
      f.setAfter(path=>{if(path===''){f.setAfter(undefined);if(kind==='withdrawal')withdrawSource(f.store,issue.id);else f.store.save('sources',{...issue,...(kind==='revision'?{revision:'r2'}:{content:'changed'})});}});
      expect(await ingestStructuredExperience(f.store,f.reader,f.source.id,new AbortController().signal)).toBe(false);
      expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation'||a.kind==='knowledge.host-observation')).toEqual([]);
      if(kind==='withdrawal')expect(f.store.list('cards').filter(c=>c.sourceId===f.source.id).every(c=>c.status==='withdrawn'&&!c.body&&!c.experience)).toBe(true);
    }finally{f.close();}
  });

  it('fails closed for an incomplete legacy issue dependency closure',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const issue={...f.source,id:'issue',externalId:'issue',content:'Issue resolution'};f.store.save('sources',issue);
      f.source.content=envelope(f.project.id,f.project.repository,{issueId:issue.id});f.store.save('sources',f.source);
      const input=parseStructuredExperience(f.source,f.project)!,readback=await readExperienceCi(f.reader,f.store,f.project,f.source,input,new AbortController().signal);
      const ids=acceptRepositoryReadback(f.store,f.source.id,readback),row=f.store.get('actions',ids[0]!)!,observation=structuredClone(row.payload.observation) as HostObservation;
      observation.sourceRefs=[{id:f.source.id,revision:f.source.revision}];observation.origin.derivedFrom=[];observation.id=hostObservationId(observation);
      f.store.save('actions',{...row,id:observation.id,payload:{...row.payload,observation,digest:digest(observation),sourceRefs:observation.sourceRefs}});
      expect(readHostObservation(f.store,observation.id,f.project)).toBeUndefined();
    }finally{f.close();}
  });

  it('rejects a changed issue resolution between readback and direct admission',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const issue={...f.source,id:'issue',externalId:'issue',content:'Issue resolution'};f.store.save('sources',issue);
      f.source.content=envelope(f.project.id,f.project.repository,{issueId:issue.id});f.store.save('sources',f.source);
      const input=parseStructuredExperience(f.source,f.project)!,readback=await readExperienceCi(f.reader,f.store,f.project,f.source,input,new AbortController().signal);
      f.store.save('sources',{...issue,content:'A changed resolution'});
      expect(()=>acceptRepositoryReadback(f.store,f.source.id,readback)).toThrow();
      expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation'||a.kind==='knowledge.host-observation')).toEqual([]);
    }finally{f.close();}
  });

  it('invalidates admitted evidence when an issue changes without a revision change',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const issue={...f.source,id:'issue',externalId:'issue',content:'Issue resolution'};f.store.save('sources',issue);
      f.source.content=envelope(f.project.id,f.project.repository,{issueId:issue.id});f.store.save('sources',f.source);
      const input=parseStructuredExperience(f.source,f.project)!,readback=await readExperienceCi(f.reader,f.store,f.project,f.source,input,new AbortController().signal);
      const ids=acceptRepositoryReadback(f.store,f.source.id,readback);expect(readHostObservation(f.store,ids[0]!,f.project)).toBeDefined();
      f.store.save('sources',{...issue,content:'Altered issue resolution'});
      expect(readHostObservation(f.store,ids[0]!,f.project)).toBeUndefined();
    }finally{f.close();}
  });

  it('does not start an adapter read for an expired temporary issue',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const issue={...f.source,id:'issue',externalId:'issue',content:'',retention:'ephemeral' as const};f.store.save('sources',issue);
      f.source.content=envelope(f.project.id,f.project.repository,{issueId:issue.id});f.store.save('sources',f.source);
      const input=parseStructuredExperience(f.source,f.project)!;
      await expect(readExperienceCi(f.reader,f.store,f.project,f.source,input,new AbortController().signal)).rejects.toBeDefined();
      expect(f.requests).toEqual([]);
    }finally{f.close();}
  });

  it.each(['reference','task'] as const)('keeps an expired issue-dependent %s job pending without spinning or a provider read',async purpose=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      const issue={...f.source,id:'issue',externalId:'issue',content:'',retention:'ephemeral' as const};f.store.save('sources',issue);
      const engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest({projectId:f.project.id,externalId:'expired-issue',title:'Experience',content:envelope(f.project.id,f.project.repository,{issueId:issue.id}),purpose});
      await engine.runUntilIdle(3);
      const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      expect(job).toMatchObject({status:'pending',payload:{phase:'pending-readback',errorCode:'source_dependency_unavailable'}});
      expect(f.store.list('cards').filter(card=>card.status==='active')).toEqual([]);
      f.store.save('actions',{...job,payload:{...job.payload,runAfter:new Date(0).toISOString()}});await engine.runUntilIdle(3);
      expect(f.requests).toEqual([]);expect(f.store.list('attempts')).toEqual([]);
    }finally{f.close();}
  });

  it.each(['already-ephemeral','retention-switch'] as const)('keeps issue-dependent jobs, evidence and structured cards private for %s',async mode=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-issue-private-')),base=repositoryKnowledgeFixture('gitlab'),project=base.project;base.close();
    let store=new Store(join(root,'db'),join(root,'vault'));const f=repositoryKnowledgeFixture('gitlab',{store,project});
    try{
      const parent={...f.source,id:'issue-parent',externalId:'issue-parent',content:'private issue ancestor',retention:mode==='already-ephemeral'?'ephemeral' as const:'permanent' as const};
      store.save('sources',parent);
      const issue={...f.source,id:'issue',externalId:'issue',content:'issue',parentSources:[{id:parent.id,revision:parent.revision}]};store.save('sources',issue);
      f.source.content=envelope(project.id,project.repository,{issueId:issue.id});store.save('sources',f.source);
      expect(await ingestStructuredExperience(store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const actions=store.list('actions').filter(a=>['knowledge.structured-ingest','knowledge.host-observation','knowledge.evidence-link','experience.test-observation'].includes(a.kind));
      const cards=store.list('cards').filter(c=>c.sourceId===f.source.id);
      expect(actions.length).toBeGreaterThan(2);expect(cards.length).toBeGreaterThan(0);
      for(const action of actions)expect((action.payload.sourceRefs as {id:string}[]).map(r=>r.id)).toEqual(expect.arrayContaining([f.source.id,issue.id,parent.id]));
      const ci=actions.find(a=>a.kind==='experience.test-observation')!;expect(canonicalCiTestPayloadSchema.safeParse({...ci.payload,issueSourceHash:undefined}).success).toBe(false);
      const directory=join(root,'vault',encodeURIComponent(project.id),encodeURIComponent(project.domain),'cards');
      if(mode==='retention-switch'){
        expect(store.searchCards('problem',project).length).toBeGreaterThan(0);
        const experience=cards.find(card=>card.kind==='experience')!;
        writeFileSync(join(directory,`${encodeURIComponent(experience.id)}.conflict-manual.md`),'A reported fix');
        store.save('sources',{...parent,retention:'ephemeral'});
      }
      expect(store.searchCards('problem',project)).toEqual([]);
      await store.backup(join(root,'backup'));store.close();
      for(const id of [...actions.map(a=>a.id),...cards.map(c=>c.id)])for(const file of ['db','backup'])expect(readFileSync(join(root,file)).includes(Buffer.from(id))).toBe(false);
      for(const card of cards)if(existsSync(directory))for(const name of readdirSync(directory).filter(name=>name.startsWith(encodeURIComponent(card.id))))expect(readFileSync(join(directory,name),'utf8')).not.toContain('A reported fix');
      store=new Store(join(root,'db'));for(const row of actions)expect(store.get('actions',row.id)).toBeUndefined();for(const card of cards)expect(store.get('cards',card.id)).toBeUndefined();
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each(['deleted','malformed','retracted'] as const)('makes structured cards non-durable when their job is %s',async mode=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-card-job-')),base=repositoryKnowledgeFixture(),project=base.project;base.close();
    let store=new Store(join(root,'db'),join(root,'vault'));const f=repositoryKnowledgeFixture('github',{store,project});
    try{
      f.source.content=envelope(project.id,project.repository);store.save('sources',f.source);
      expect(await ingestStructuredExperience(store,f.reader,f.source.id,new AbortController().signal)).toBe(true);
      const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!,cards=store.list('cards').filter(c=>c.sourceId===f.source.id);
      expect(store.searchCards('problem',project).length).toBeGreaterThan(0);
      if(mode==='deleted')store.delete('actions',job.id);
      else store.save('actions',{...job,payload:mode==='malformed'?{...job.payload,sourceRefs:{unexpected:true}}:{retracted:true}});
      expect(store.searchCards('problem',project)).toEqual([]);store.close();
      for(const card of cards){expect(readFileSync(join(root,'db')).includes(Buffer.from(card.id))).toBe(false);const path=join(root,'vault',project.id,project.domain,'cards',`${encodeURIComponent(card.id)}.md`);if(existsSync(path))expect(readFileSync(path,'utf8')).not.toContain('A reported fix');}
      store=new Store(join(root,'db'));for(const card of cards)expect(store.get('cards',card.id)).toBeUndefined();
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each(['deleted','malformed','retracted','missing-issue','bad-phase'] as const)('redacts unknown issue-dependent cards in live views when their job is %s before withdrawal',async mode=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-fix1-card-')),seed=repositoryKnowledgeFixture(),project={...seed.project,budgetUsd:10};seed.close();
    let store=new Store(join(root,'db'),join(root,'vault'));const f=repositoryKnowledgeFixture('github',{store,project});
    try{
      const issue={...f.source,id:'issue',externalId:'issue',content:'Private issue dependency'};store.save('sources',issue);
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      const worker=new DemoWorker('grok');let workerCards:unknown;
      const engine=new Workbench({store,config,workers:[{name:'grok',async run(input){workerCards=input.cards;return worker.run(input);}}],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      const task=engine.ingest({projectId:project.id,externalId:'issue-dependent',title:'Report',content:envelope(project.id,project.repository,{issueId:issue.id})})!;
      await engine.tick();expect(store.get('tasks',task.id)?.stage).toBe('case_extract');
      const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest'&&a.payload.sourceId===task.sourceId)!,cards=store.list('cards').filter(c=>c.sourceId===task.sourceId);
      expect(job.payload.sourceId).toBe(task.sourceId);
      expect(cards.find(c=>c.kind==='experience')?.experience?.solution).toBe('A reported fix');
      const directory=join(root,'vault',encodeURIComponent(project.id),encodeURIComponent(project.domain),'cards'),card=cards.find(c=>c.kind==='experience')!;
      writeFileSync(join(directory,`${encodeURIComponent(card.id)}.conflict-manual.md`),'A reported fix');
      if(mode==='deleted')store.delete('actions',job.id);
      else if(mode==='malformed')store.save('actions',{...job,payload:{...job.payload,sourceRefs:{unexpected:true}}});
      else if(mode==='missing-issue')store.save('actions',{...job,payload:{...job.payload,sourceRefs:(job.payload.sourceRefs as {id:string;revision:string}[]).filter(ref=>ref.id!==issue.id)}});
      else if(mode==='bad-phase')store.save('actions',{...job,status:'pending'});
      else store.save('actions',{...job,payload:{retracted:true}});
      for(const candidate of cards){const live=store.get('cards',candidate.id);expect(live&&{id:live.id,status:live.status,body:live.body,experience:live.experience}).toMatchObject({status:'withdrawn',body:'',experience:undefined});}
      expect(store.list('cards').filter(c=>c.sourceId===task.sourceId&&c.status==='active')).toEqual([]);
      expect(store.searchCards('problem',project)).toEqual([]);
      engine.withdraw(issue.id);
      const app=createApp({store,config,engine});
      const state=await (await app.request('/api/state?project=p')).json(),page=await (await app.request('/knowledge?project=p')).text();
      expect(JSON.stringify((state as {cards:unknown}).cards)).not.toContain('A reported fix');expect(page).not.toContain('A reported fix');
      await engine.tick();expect(JSON.stringify(workerCards)).not.toContain('A reported fix');
      await store.backup(join(root,'backup'));await engine.shutdown();store.close();
      for(const candidate of cards)for(const file of ['db','backup'])expect(readFileSync(join(root,file)).includes(Buffer.from(candidate.id))).toBe(false);
      if(existsSync(directory))for(const name of readdirSync(directory))expect(readFileSync(join(directory,name),'utf8')).not.toContain('A reported fix');
      store=new Store(join(root,'db'),join(root,'vault'));for(const candidate of cards)expect(store.get('cards',candidate.id)?.status).not.toBe('active');
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each(['same-process','reopen'] as const)('rebuilds an active experience with its issue closure after a deleted job (%s)',async mode=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-fix2-experience-')),seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    let store=new Store(join(root,'db'));let f=repositoryKnowledgeFixture('github',{store,project});
    try{
      const issue={...f.source,id:'issue',externalId:'issue',content:'Active issue'};store.save('sources',issue);
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
      const input={projectId:project.id,externalId:'active-experience',revision:'v1',title:'Report',content:envelope(project.id,project.repository,{issueId:issue.id}),purpose:'reference' as const};
      engine.ingest(input);await engine.tick();const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      const card=store.list('cards').find(c=>c.kind==='experience')!;expect(card.experience?.solution).toBe('A reported fix');
      store.delete('actions',job.id);expect(store.get('cards',card.id)).toMatchObject({status:'withdrawn',body:''});
      if(mode==='reopen'){await engine.shutdown();store.close();store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});}
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest(input);await engine.tick();
      expect(store.get('actions',job.id)).toMatchObject({status:'completed',payload:{phase:'processed',sourceRefs:expect.arrayContaining([{id:issue.id,revision:issue.revision}])}});
      expect(store.get('cards',card.id)).toMatchObject({status:'active',experience:{solution:'A reported fix'}});
      expect(store.list('actions').some(a=>a.kind==='knowledge.host-observation')).toBe(true);await engine.shutdown();
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each([
    {timing:'before job deletion',reopen:false,advance:'before-delete'},
    {timing:'during the missing-job interval',reopen:false,advance:'before-recovery'},
    {timing:'after reopening before the deadline',reopen:true,advance:'before-recovery'},
    {timing:'before reopening',reopen:true,advance:'before-reopen'},
    {timing:'during authenticated recovery',reopen:false,advance:'during-read'},
    {timing:'after successful recovery',reopen:true,advance:'after-recovery'},
  ] as const)('honors the original expiry $timing',async ({reopen,advance})=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-expiry-order-')),seed=repositoryKnowledgeFixture(),project={...seed.project,budgetUsd:10};seed.close();
    const realNow=Date.now,base=realNow(),deadline=new Date(base+60_000).toISOString();let clock=base;
    Date.now=()=>clock;
    let store=new Store(join(root,'db'),join(root,'vault'));let f=repositoryKnowledgeFixture('github',{store,project});
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
    let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
    try{
      const issue={...f.source,id:'expiry-issue',externalId:'expiry-issue',content:'Active issue'};store.save('sources',issue);
      const input={projectId:project.id,externalId:'expiry-experience',revision:'v1',title:'Report',content:envelope(project.id,project.repository,{issueId:issue.id}),purpose:'reference' as const};
      engine.ingest(input);await engine.tick();
      const source=store.list('sources').find(s=>s.externalId==='expiry-experience')!;
      const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest'&&a.payload.sourceId===source.id)!;
      const cards=store.list('cards').filter(c=>c.sourceId===job.payload.sourceId),experience=cards.find(c=>c.kind==='experience')!,fact=cards.find(c=>c.pendingClaim?.kind==='commit-exists')!;
      expect(experience.experience?.solution).toBe('A reported fix');expect(fact).toBeDefined();
      for(const card of cards)store.save('cards',{...card,expiresAt:deadline});
      if(advance==='before-delete')clock=base+60_001;
      store.delete('actions',job.id);
      expect(store.get('cards',experience.id)?.status).toBe('withdrawn');
      expect(store.list('actions').filter(a=>a.kind==='knowledge.evidence-link'&&canonicalKnowledgePayloadSchema.safeParse(a.payload).success)).toEqual([]);
      if(advance==='before-reopen')clock=base+60_001;
      if(reopen){await engine.shutdown();store.close();store=new Store(join(root,'db'),join(root,'vault'));f=repositoryKnowledgeFixture('github',{store,project});}
      if(advance==='before-recovery')clock=base+60_000;
      let targetReads=0;const reader:RepositoryKnowledgeReader={async read(project,readSource,request,signal){
        if(readSource.id===source.id)targetReads++;
        const result=await f.reader.read(project,readSource,request,signal);
        if(readSource.id===source.id&&advance==='during-read')clock=base+60_001;
        return result;
      }};
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:reader});
      engine.ingest(input);await engine.tick();
      if(advance==='after-recovery'){
        expect(store.get('cards',experience.id)).toMatchObject({status:'active',expiresAt:deadline,experience:{solution:'A reported fix'}});
        expect(store.get('cards',fact.id)).toMatchObject({status:'active',expiresAt:deadline,claim:{claim:{kind:'commit-exists'}}});
        const fresh=store.list('actions').filter(a=>a.kind==='knowledge.evidence-link').map(a=>canonicalKnowledgePayloadSchema.safeParse(a.payload)).find(p=>p.success&&p.data.link.cardId===fact.id);
        expect(fresh?.success).toBe(true);
        if(fresh?.success)expect(fresh.data.link.observationIds.every(id=>readHostObservation(store,id,project))).toBe(true);
        expect(targetReads).toBe(1);clock=base+60_001;
        if(fresh?.success)expect(()=>linkKnowledgeEvidence(store,fact.id,fresh.data.link.observationIds)).toThrow();
      }else{
        expect(store.get('cards',experience.id)?.status).not.toBe('active');
        expect(store.get('cards',fact.id)?.status).not.toBe('active');
        expect(store.list('actions').filter(a=>a.kind==='knowledge.evidence-link'&&canonicalKnowledgePayloadSchema.safeParse(a.payload).success)).toEqual([]);
        expect(store.list('actions').filter(a=>a.kind==='knowledge.host-observation').map(a=>canonicalHostPayloadSchema.safeParse(a.payload)).some(p=>p.success&&p.data.sourceRefs.some(ref=>ref.id===source.id))).toBe(false);
        expect(targetReads).toBe(advance==='during-read'?1:0);
      }
      expect(store.searchCards('problem',project)).toEqual([]);
      const app=createApp({store,config,engine});
      const state=await (await app.request('/api/state?project=p')).json(),page=await (await app.request('/knowledge?project=p')).text();
      expect(JSON.stringify((state as {cards:unknown}).cards)).not.toContain('A reported fix');expect(page).not.toContain('A reported fix');
      await engine.shutdown();
      let workerCards:unknown;const worker=new DemoWorker('grok');
      engine=new Workbench({store,config,workers:[{name:'grok',async run(input){workerCards=input.cards;return worker.run(input);}}],writer:demoWriter,research:demoResearch});
      engine.ingest({projectId:project.id,externalId:'expiry-worker',title:'problem',content:'problem',purpose:'task'});await engine.tick();
      expect(workerCards).toBeDefined();expect(JSON.stringify(workerCards)).not.toContain('A reported fix');
    }finally{Date.now=realNow;await engine.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each(['permanent','ephemeral'] as const)('retains the deadline through repeated deleted-job recovery for %s content',async retention=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-expiry-cycles-')),seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    const realNow=Date.now,base=realNow(),deadline=new Date(base+60_000).toISOString().replace('Z','+00:00');let clock=base;Date.now=()=>clock;
    let store=new Store(join(root,'db'));let f=repositoryKnowledgeFixture('github',{store,project});
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
    let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
    try{
      const input={projectId:project.id,externalId:'expiry-cycles',revision:'v1',title:'Report',content:envelope(project.id,project.repository),retention,purpose:'reference' as const};
      engine.ingest(input);await engine.tick();const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      const cards=store.list('cards').filter(c=>c.sourceId===job.payload.sourceId),experience=cards.find(c=>c.kind==='experience')!,fact=cards.find(c=>c.pendingClaim?.kind==='commit-exists')!;
      for(const card of cards)store.save('cards',{...card,expiresAt:deadline});
      for(let cycle=0;cycle<2;cycle++){
        clock=base+(cycle+1)*10_000;store.delete('actions',job.id);
        expect(store.get('cards',experience.id)).toMatchObject({status:'withdrawn',body:'',expiresAt:deadline});
        expect(store.list('actions').filter(a=>a.kind==='knowledge.evidence-link').map(a=>canonicalKnowledgePayloadSchema.safeParse(a.payload)).some(p=>p.success&&p.data.link.cardId===fact.id)).toBe(false);
        await engine.shutdown();store.close();
        const db=new Database(join(root,'db'),{readonly:true});
        try{
          const row=db.prepare('SELECT data FROM cards WHERE id = ?').get(experience.id) as {data:string};
          expect(JSON.parse(row.data)).toMatchObject({id:experience.id,status:'withdrawn',title:'',body:'',quote:'',aliases:[],expiresAt:deadline});
          expect(row.data).not.toContain('A reported fix');expect(row.data).not.toContain('docs/test.ts');expect(row.data).not.toContain('pendingClaim');expect(row.data).not.toContain('claim');
        }finally{db.close();}
        if(retention==='ephemeral')expect(readFileSync(join(root,'db')).includes(Buffer.from('A reported fix'))).toBe(false);
        store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});
        engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
        engine.ingest(input);await engine.tick();
        expect(store.get('cards',experience.id)).toMatchObject({status:'active',expiresAt:deadline,experience:{solution:'A reported fix'}});
        expect(store.get('cards',fact.id)).toMatchObject({status:'active',expiresAt:deadline,claim:{claim:{kind:'commit-exists'}}});
        const link=store.list('actions').filter(a=>a.kind==='knowledge.evidence-link').map(a=>canonicalKnowledgePayloadSchema.safeParse(a.payload)).find(p=>p.success&&p.data.link.cardId===fact.id);
        expect(link?.success).toBe(true);expect(f.requests.length).toBeGreaterThan(0);
      }
      clock=base+60_001;expect(store.get('cards',experience.id)?.status).toBe('withdrawn');expect(store.searchCards('problem',project)).toEqual([]);
    }finally{Date.now=realNow;await engine.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each(['experience','fact'] as const)('does not rebuild an expired $kind while other candidates have no deadline',async kind=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-one-expiry-')),seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    const realNow=Date.now,base=realNow();let clock=base;Date.now=()=>clock;
    let store=new Store(join(root,'db'));let f=repositoryKnowledgeFixture('github',{store,project});
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
    let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
    try{
      const input={projectId:project.id,externalId:'one-expiry',revision:'v1',title:'Report',content:envelope(project.id,project.repository),purpose:'reference' as const};
      engine.ingest(input);await engine.tick();const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!;
      const card=store.list('cards').find(c=>kind==='experience'?c.kind==='experience':c.pendingClaim?.kind==='commit-exists')!;
      store.save('cards',{...card,expiresAt:new Date(base+60_000).toISOString()});store.delete('actions',job.id);
      await engine.shutdown();store.close();clock=base+60_001;store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest(input);await engine.tick();expect(store.get('cards',card.id)?.status).not.toBe('active');expect(f.requests).toEqual([]);
      expect(store.list('actions').filter(a=>a.kind==='knowledge.evidence-link'&&canonicalKnowledgePayloadSchema.safeParse(a.payload).success)).toEqual([]);
    }finally{Date.now=realNow;await engine.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each(['owner','source','issue'] as const)('does not use a future expiry marker to undo $mode revocation',async mode=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-expiry-revoked-')),seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    const realNow=Date.now,base=realNow();Date.now=()=>base;
    let store=new Store(join(root,'db'));let f=repositoryKnowledgeFixture('github',{store,project});
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
    let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
    try{
      const issue={...f.source,id:'expiry-revoked-issue',externalId:'expiry-revoked-issue',content:'Active issue'};store.save('sources',issue);
      const input={projectId:project.id,externalId:'expiry-revoked',revision:'v1',title:'Report',content:envelope(project.id,project.repository,{issueId:issue.id}),purpose:'reference' as const};
      engine.ingest(input);await engine.tick();const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!,card=store.list('cards').find(c=>c.kind==='experience')!;
      store.save('cards',{...card,expiresAt:new Date(base+60_000).toISOString()});store.delete('actions',job.id);
      if(mode==='owner')store.save('cards',{...store.get('cards',card.id)!,status:'withdrawn'});
      if(mode==='source')engine.withdraw(card.sourceId);
      if(mode==='issue')engine.withdraw(issue.id);
      await engine.shutdown();store.close();store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      if(mode==='source')expect(()=>engine.ingest(input)).toThrow();else{engine.ingest(input);await engine.tick();}
      expect(store.get('cards',card.id)?.status).not.toBe('active');expect(f.requests).toEqual([]);
      expect(store.list('actions').filter(a=>a.kind==='knowledge.evidence-link'&&canonicalKnowledgePayloadSchema.safeParse(a.payload).success)).toEqual([]);
    }finally{Date.now=realNow;await engine.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('retains an ephemeral deadline when the active source is re-saved before restart',async()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-expiry-temporary-')),seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    const realNow=Date.now,base=realNow(),deadline=new Date(base+60_000).toISOString();Date.now=()=>base;
    let store=new Store(join(root,'db'));let f=repositoryKnowledgeFixture('github',{store,project});
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
    let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
    try{
      const input={projectId:project.id,externalId:'expiry-temporary',revision:'v1',title:'Report',content:envelope(project.id,project.repository),retention:'ephemeral' as const,purpose:'reference' as const};
      engine.ingest(input);await engine.tick();const card=store.list('cards').find(c=>c.kind==='experience')!;
      store.save('cards',{...card,expiresAt:deadline});store.save('sources',store.get('sources',card.sourceId)!);
      await engine.shutdown();store.close();expect(readFileSync(join(root,'db')).includes(Buffer.from('A reported fix'))).toBe(false);
      store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest(input);await engine.tick();expect(store.get('cards',card.id)).toMatchObject({status:'active',expiresAt:deadline,experience:{solution:'A reported fix'}});
      expect(f.requests.length).toBeGreaterThan(0);
    }finally{Date.now=realNow;await engine.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('retains an expired revocation when an invalid job is later deleted and reaccepted',async()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-expiry-invalid-job-')),seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    const realNow=Date.now,base=realNow();let clock=base;Date.now=()=>clock;
    let store=new Store(join(root,'db'));let f=repositoryKnowledgeFixture('github',{store,project});
    const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
    let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
    try{
      const input={projectId:project.id,externalId:'expiry-invalid-job',revision:'v1',title:'Report',content:envelope(project.id,project.repository),purpose:'reference' as const};
      engine.ingest(input);await engine.tick();const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!,card=store.list('cards').find(c=>c.kind==='experience')!;
      store.save('cards',{...card,expiresAt:new Date(base+60_000).toISOString()});
      store.save('actions',{...job,payload:{...job.payload,sourceRefs:{invalid:true}}});store.delete('actions',job.id);
      await engine.shutdown();store.close();clock=base+60_001;store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest(input);await engine.tick();expect(store.get('cards',card.id)?.status).not.toBe('active');expect(f.requests).toEqual([]);
    }finally{Date.now=realNow;await engine.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each((['owner-retracted','expired','source-withdrawn','issue-withdrawn'] as const).flatMap(mode=>(['same-process','reopen'] as const).map(lifecycle=>({mode,lifecycle}))))('does not revive $mode after job deletion ($lifecycle)',async ({mode,lifecycle})=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-fix2-no-revival-')),seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    let store=new Store(join(root,'db'));let f=repositoryKnowledgeFixture('github',{store,project});
    try{
      const issue={...f.source,id:'issue',externalId:'issue',content:'Active issue'};store.save('sources',issue);
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
      const input={projectId:project.id,externalId:'revoked-experience',revision:'v1',title:'Report',content:envelope(project.id,project.repository,{issueId:issue.id}),purpose:'reference' as const};
      engine.ingest(input);await engine.tick();const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!,card=store.list('cards').find(c=>c.kind==='experience')!;
      if(mode==='owner-retracted')store.save('cards',{...card,status:'withdrawn'});
      if(mode==='expired')store.save('cards',{...card,expiresAt:new Date(0).toISOString()});
      store.delete('actions',job.id);
      if(mode==='source-withdrawn')engine.withdraw(card.sourceId);
      if(mode==='issue-withdrawn')engine.withdraw(issue.id);
      if(lifecycle==='reopen'){await engine.shutdown();store.close();store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});}
      engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      if(mode==='source-withdrawn')expect(()=>engine.ingest(input)).toThrow();else {engine.ingest(input);await engine.tick();}
      expect(store.get('cards',card.id)?.status).not.toBe('active');
      expect(store.list('actions').filter(a=>a.kind==='knowledge.host-observation'||a.kind==='knowledge.evidence-link'||a.kind==='experience.test-observation')).toEqual([]);
      expect(f.requests).toEqual([]);await engine.shutdown();
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each(['owner-retracted','expired'] as const)('retains only a sanitized %s tombstone for an ephemeral card across repeated reopen',async mode=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-fix2-private-revocation-')),seed=repositoryKnowledgeFixture(),project=seed.project;seed.close();
    let store=new Store(join(root,'db'));let f=repositoryKnowledgeFixture('github',{store,project});
    try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[project];
      let engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});
      const input={projectId:project.id,externalId:'private-revocation',revision:'v1',title:'Report',content:envelope(project.id,project.repository),retention:'ephemeral' as const,purpose:'reference' as const};
      engine.ingest(input);await engine.tick();const job=store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')!,card=store.list('cards').find(c=>c.kind==='experience')!;
      store.save('cards',mode==='owner-retracted'?{...card,status:'withdrawn'}:{...card,expiresAt:new Date(0).toISOString()});store.delete('actions',job.id);
      await engine.shutdown();store.close();expect(readFileSync(join(root,'db')).includes(Buffer.from('A reported fix'))).toBe(false);
      store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest(input);await engine.tick();expect(store.get('cards',card.id)?.status).toBe('withdrawn');expect(f.requests).toEqual([]);
      await engine.shutdown();store.close();expect(readFileSync(join(root,'db')).includes(Buffer.from('A reported fix'))).toBe(false);
      store=new Store(join(root,'db'));f=repositoryKnowledgeFixture('github',{store,project});engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});
      engine.ingest(input);await engine.tick();expect(store.get('cards',card.id)?.status).toBe('withdrawn');expect(f.requests).toEqual([]);await engine.shutdown();
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('does not rebuild a deleted job from a same-revision issue whose accepted content changed',async()=>{
    const f=repositoryKnowledgeFixture();try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];
      let engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch});
      engine.ingest({projectId:f.project.id,externalId:'bound-issue',revision:'v1',title:'Issue',content:'Accepted issue',purpose:'reference'});await engine.tick();
      const issue=f.store.list('sources').find(s=>s.externalId==='bound-issue')!;
      const input={projectId:f.project.id,externalId:'bound-experience',revision:'v1',title:'Report',content:envelope(f.project.id,f.project.repository,{issueId:issue.id}),purpose:'reference' as const};
      engine.ingest(input);await engine.tick();const job=f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest'&&a.payload.sourceId!==issue.id)!,card=f.store.list('cards').find(c=>c.kind==='experience')!;
      f.store.delete('actions',job.id);f.store.save('sources',{...issue,content:'Changed issue under the same revision'});
      engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch,repositoryKnowledgeReader:f.reader});engine.ingest(input);await engine.tick();
      expect(f.store.get('cards',card.id)?.status).not.toBe('active');expect(f.requests).toEqual([]);
      expect(f.store.get('actions',job.id)).toMatchObject({status:'pending',payload:{phase:'pending-readback',errorCode:'source_dependency_unavailable'}});await engine.shutdown();
    }finally{f.close();}
  });

  it('keeps a source-reported candidate available when its issue locator never resolved to an authorized dependency',async()=>{
    const f=repositoryKnowledgeFixture();try{
      f.source.content=envelope(f.project.id,f.project.repository,{issueId:'unresolved-locator'});f.store.save('sources',f.source);
      expect(await ingestStructuredExperience(f.store,undefined,f.source.id,new AbortController().signal)).toBe(false);
      const card=f.store.list('cards').find(c=>c.kind==='experience')!;expect(card).toMatchObject({status:'active',verification:'reported',experience:{solution:'A reported fix'}});
      expect(f.store.list('actions').find(a=>a.kind==='knowledge.structured-ingest')?.payload.sourceRefs).toEqual([{id:f.source.id,revision:f.source.revision}]);
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.host-observation'||a.kind==='experience.test-observation')).toEqual([]);
    }finally{f.close();}
  });

  it('keeps a structured card temporary even when its title is edited',async()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g5-edited-card-')),base=repositoryKnowledgeFixture(),project=base.project;base.close();
    let store=new Store(join(root,'db'));const f=repositoryKnowledgeFixture('github',{store,project});
    try{
      const issue={...f.source,id:'issue',externalId:'issue',retention:'ephemeral' as const,content:'private issue'};store.save('sources',issue);
      f.source.content=envelope(project.id,project.repository,{issueId:issue.id});store.save('sources',f.source);
      expect(await ingestStructuredExperience(store,undefined,f.source.id,new AbortController().signal)).toBe(false);
      const card=store.list('cards').find(c=>c.kind==='experience')!;store.save('cards',{...card,title:'PRIVATE_EDITED_STRUCTURED_TITLE'});
      store.close();expect(readFileSync(join(root,'db')).includes(Buffer.from('PRIVATE_EDITED_STRUCTURED_TITLE'))).toBe(false);
      store=new Store(join(root,'db'));expect(store.get('cards',card.id)).toBeUndefined();
    }finally{store.close();rmSync(root,{recursive:true,force:true});}
  });
});
