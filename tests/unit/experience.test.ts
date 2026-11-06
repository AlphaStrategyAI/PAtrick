import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, stableId, type ActionRecord, type Attempt, type KnowledgeCard, type Project, type SourceRevision, type Task } from '../../src/domain.js';
import type { TestObservation } from '../../src/knowledge-contract.js';
import { knowledgeCandidateHash, knowledgePolicyHash, snapshotDigest, testDefinitionDigest } from '../../src/knowledge-identity.js';
import { publishKnowledge } from '../../src/knowledge.js';
import { experienceReference, linkAvailableExperienceEvidence } from '../../src/experience.js';
import { invalidateSource } from '../../src/intake.js';
import { Store } from '../../src/store.js';
import { Workbench } from '../../src/orchestrator.js';
import { readConfig } from '../../src/config.js';
import { configureDemo, demoResearch, demoWriter, DemoWorker } from '../../src/demo.js';
import { referenceExperienceObservation } from '../../src/knowledge-records.js';

function relations(...records:{problem:string;files:string[];checks:string[]}[]):string {
  return ['@@experience-relations-v1',...records.map(({problem,files,checks})=>JSON.stringify({problem,files,checks})),'@@end-experience-relations-v1.'].join('\n');
}

function replaceLocalRun(f:ReturnType<typeof retainedLocalFixture>, quote:string, commands:string[], checks:TestObservation['checks'], files:TestObservation['snapshot']['files']) {
  f.project.trustedChecks=commands;f.source.content=quote;
  f.store.save('projects',f.project);f.store.save('sources',f.source);f.store.save('tasks',{...f.task,description:quote});
  const row=f.store.get('actions',f.observation.id)!;f.store.delete('actions',row.id);
  const observation:TestObservation={...f.observation,id:'',snapshot:{...f.observation.snapshot,files},checks};
  if(observation.origin.kind!=='local')throw new Error('Expected local observation');
  observation.id=stableId('local-test-observation',observation.origin.runId,digest(observation.origin),digest(observation));
  const accepted={...(row.payload.accepted as Record<string,unknown>),sourceHash:digest(f.source),policyHash:knowledgePolicyHash(f.project)};
  f.store.save('actions',{...row,id:observation.id,payload:{...row.payload,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted)}});
  f.observation=observation;
}

function reviseSeededObservation(f:ReturnType<typeof retainedLocalFixture>,original:TestObservation,change:(observation:TestObservation)=>void):TestObservation {
  const row=f.store.get('actions',original.id)!;f.store.delete('actions',row.id);
  const observation=structuredClone(original);observation.id='';change(observation);
  if(observation.origin.kind!=='local')throw new Error('Expected local observation');
  observation.id=stableId('local-test-observation',observation.origin.runId,digest(observation.origin),digest(observation));
  f.store.save('actions',{...row,id:observation.id,payload:{...row.payload,observation,digest:digest(observation)}});return observation;
}

// Seed a retained canonical G3 row; this fixture is not a new execution.
function retainedLocalFixture(managed=false,commandSuffix='',databasePath=':memory:',retention:'permanent'|'ephemeral'='permanent') {
  const store = new Store(databasePath);
  const project: Project = { id:'p', projectId:'p', domain:'personal', name:'P', description:'', repository:'owner/repo', repositoryProvider:'github', prdPath:'docs/PRD.md', allowedPaths:['docs/'], trustedChecks:['npm test -- docs/test.ts'], trustedAppIds:managed?[17]:[], ownerId:'owner', autoMerge:managed, budgetUsd:0, createdAt:'' };
  const quote = relations({problem:'cache misses',files:['docs/test.ts'],checks:[`npm test -- docs/test.ts${commandSuffix}`]});
  const source: SourceRevision = { id:'source', projectId:'p', domain:'personal', kind:'manual', externalId:'source', revision:'r1', title:'Task', content:`${quote}\nSeparate report: request timeout.`, locator:'manual:source', authorId:'owner', status:'active', retention, createdAt:'' };
  const task: Task = { id:'task', projectId:'p', domain:'personal', sourceId:source.id, sourceRevision:source.revision, title:'Task', description:source.content, status:'delivered', version:3, createdAt:'', updatedAt:'', runAfter:'', attempts:1, repairCount:0, budgetUsd:0, spentUsd:0, stage:'feedback' };
  const attempt: Attempt = { id:'attempt', projectId:'p', domain:'personal', taskId:task.id, taskVersion:1, role:'execute', runner:'codex', model:'test', provider:'test', inputHash:'a'.repeat(64), status:'succeeded', costUsd:0, startedAt:'' };
  store.save('projects',project);store.save('sources',source);store.save('tasks',task);store.save('attempts',attempt);
  const file={path:'docs/test.ts',sha256:'b'.repeat(64),mode:'100644'},revision='c'.repeat(40),command='npm test -- docs/test.ts';
  const origin: Extract<TestObservation['origin'],{kind:'local'}>={kind:'local',taskId:task.id,taskVersion:1,attemptId:attempt.id,inputHash:attempt.inputHash,planHash:'d'.repeat(64),artifactHash:'e'.repeat(64),role:'execute',runId:'run-1'};
  const observation:TestObservation={schemaVersion:1,id:'',projectId:'p',domain:'personal',sourceId:source.id,sourceRevision:source.revision,repository:project.repository,observedAt:'2026-11-04T12:00:00Z',snapshot:{revision,...(managed?{overlayHash:'a'.repeat(64)}:{}),files:[file]},checks:[{id:stableId('local-check',command),command,testFile:file.path,result:'success',outputDigest:'f'.repeat(64),process:{exitCode:0,signal:null,timedOut:false,startedAt:'2026-11-04T11:59:00Z',finishedAt:'2026-11-04T12:00:00Z'}}],environment:{observed:{node:'24'},unknown:['browser']},origin};
  observation.id=stableId('local-test-observation',origin.runId,digest(origin),digest(observation));
  const accepted={attemptId:attempt.id,taskId:task.id,taskVersion:1,role:'execute' as const,runner:attempt.runner,provider:attempt.provider,model:attempt.model,inputHash:attempt.inputHash,outputHash:'1'.repeat(64),planHash:origin.planHash,artifactHash:origin.artifactHash,runId:origin.runId,sourceHash:digest(source),policyHash:knowledgePolicyHash(project)};
  store.save('actions',{id:observation.id,projectId:'p',domain:'personal',taskId:task.id,kind:'experience.test-observation',status:'completed',payload:{schemaVersion:1,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted),sourceRefs:[{id:source.id,revision:source.revision}]},updatedAt:observation.observedAt});
  const details={schemaVersion:1 as const,problem:'cache misses',symptomAliases:['cache miss'],solution:'Clear the cache',files:[file.path],productId:project.id,codeVersion:revision,environment:'reported environment',invalidationConditions:['cache format changes']};
  const publish=(problem=details.problem,record=quote,version=revision):KnowledgeCard => publishKnowledge(store,source,{cards:[{title:problem,body:problem,quote:record,aliases:[problem],verification:'reported',kind:'experience',experience:{...details,problem,codeVersion:version}}]})[0]!;
  return {store,project,source,task,attempt,observation,file,quote,publish};
}

function seedAdditional(f:ReturnType<typeof retainedLocalFixture>,suffix:string,result:'success'|'failure',observedAt:string,ownSource=true,revision=f.observation.snapshot.revision,content=f.source.content,retention:'permanent'|'ephemeral'='permanent') {
 const source=ownSource?{...f.source,id:`record-${suffix}`,externalId:`record-${suffix}`,retention,content} : f.source;
 if(ownSource)f.store.save('sources',source);
 const task={...f.task,id:`task-${suffix}`,sourceId:source.id};f.store.save('tasks',task);
 const attempt={...f.attempt,id:`attempt-${suffix}`,taskId:task.id};f.store.save('attempts',attempt);
 const previous=f.observation;if(previous.origin.kind!=='local')throw new Error('Expected seeded local run');
 const origin={...previous.origin,taskId:task.id,attemptId:attempt.id,runId:`run-${suffix}`};
 const observation:TestObservation={...previous,id:'',sourceId:source.id,observedAt,snapshot:{...previous.snapshot,revision},checks:previous.checks.map(check=>({...check,result,...(check.process?{process:{...check.process,exitCode:result==='success'?0:1,startedAt:observedAt,finishedAt:observedAt}}:{})})),origin};
 observation.id=stableId('local-test-observation',origin.runId,digest(origin),digest(observation));
 const accepted={attemptId:attempt.id,taskId:task.id,taskVersion:1,role:'execute' as const,runner:attempt.runner,provider:attempt.provider,model:attempt.model,inputHash:attempt.inputHash,outputHash:'1'.repeat(64),planHash:origin.planHash,artifactHash:origin.artifactHash,runId:origin.runId,sourceHash:digest(source),policyHash:knowledgePolicyHash(f.project)};
 f.store.save('actions',{id:observation.id,projectId:'p',domain:'personal',taskId:task.id,kind:'experience.test-observation',status:'completed',payload:{schemaVersion:1,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted),sourceRefs:[{id:source.id,revision:source.revision}]},updatedAt:observedAt});
 return {source,observation};
}

describe('card-specific retained experience',()=>{
  it('rejects worker-input projection using a stale project snapshot',async()=>{
    const f=retainedLocalFixture();let engine:Workbench|undefined;try{
      const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.ownerId=f.project.ownerId;
      engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch});
      f.store.save('projects',{...f.project,name:'Changed before input'});
      expect(()=>(engine as any).input(f.task,f.project,'knowledge_extract')).toThrowError(expect.objectContaining({code:'stale_project_state',status:409}));
    }finally{await engine?.shutdown();f.store.close();}
  });
  it.each(['SQLITE_BUSY','SQLITE_LOCKED_SHAREDCACHE','SQLITE_SCHEMA'])('propagates %s through candidate, later-check and local-reference catch boundaries',code=>{
    const f=retainedLocalFixture();try{
      const card=f.publish();seedAdditional(f,'catch-later','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40));
      const before=f.store.list('actions'),get=f.store.get.bind(f.store),localReference=referenceExperienceObservation(f.store,f.observation.id,f.project);
      for(const seam of ['candidateValid','laterRelatedChecks','referenceExperienceObservationBody'] as const){
        let injected=false;
        const spy=vi.spyOn(f.store,'get').mockImplementation(((...args:Parameters<typeof get>)=>{
          const stack=new Error().stack??'';
          if(!injected&&stack.includes(seam)&&(seam==='referenceExperienceObservationBody'||stack.includes('assertKnowledgeSource'))){injected=true;throw Object.assign(new Error('injected contention'),{code});}
          return get(...args);
        }) as typeof f.store.get);
        try{
          const read=()=>seam==='referenceExperienceObservationBody'?referenceExperienceObservation(f.store,f.observation.id,f.project):experienceReference(f.store,card,f.project);
          expect(read).toThrowError(expect.objectContaining({code:'knowledge_snapshot_unavailable',status:503}));expect(injected).toBe(true);
        }finally{spy.mockRestore();}
        expect(f.store.list('actions')).toEqual(before);
        expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true});
        expect(referenceExperienceObservation(f.store,f.observation.id,f.project)).toEqual(localReference);
      }
    }finally{f.store.close();}
  });
  it('links a named regression to its exact retained local check, while another same-task card stays pending',()=>{
    const f=retainedLocalFixture();try{
      const linked=f.publish(),unrelated=f.publish('request timeout','request timeout');
      const results=f.store.searchCards('cache misses',f.project);
      expect(results.find(card=>card.id===linked.id)).toMatchObject({experienceReference:{label:'historical-test-backed-reference',reportedSolution:{text:'Clear the cache',status:'inference'},observed:[{observationId:f.observation.id,observedAt:f.observation.observedAt,evidenceLocator:'local-run:run-1',checks:[{id:f.observation.checks[0]!.id,result:'success'}],snapshot:{revision:f.observation.snapshot.revision,files:[f.file]},relevance:{recordSourceId:f.source.id,recordRevision:f.source.revision,quote:f.quote,locator:f.source.locator}}],currentApplicability:{status:'unknown'}}});
      expect(f.store.searchCards('request timeout',f.project)).toEqual([]);
      expect(f.store.searchCards('request timeout',f.project,20,{usage:'browse'}).find(card=>card.id===unrelated.id)).toMatchObject({experienceState:{state:'pending',reason:'missing_relevance_binding'}});
    }finally{f.store.close();}
  });

  it('keeps genuine history after later task progress but excludes a withdrawn source',()=>{
    const f=retainedLocalFixture();try{
      f.publish();expect(f.store.searchCards('cache misses',f.project)).toHaveLength(1);
      f.store.save('sources',{...f.source,status:'withdrawn'});
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
    }finally{f.store.close();}
  });
  it('links retained evidence regardless of whether the candidate or observation arrives first',()=>{
    const f=retainedLocalFixture();try{
      const row=f.store.get('actions',f.observation.id)!;f.store.delete('actions',row.id);
      const card=f.publish();expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
      f.store.save('actions',row);expect(linkAvailableExperienceEvidence(f.store,row.id)).toBe(1);
      expect(linkAvailableExperienceEvidence(f.store,row.id)).toBe(0);
      expect(f.store.searchCards('cache misses',f.project).map(value=>value.id)).toContain(card.id);
    }finally{f.store.close();}
  });

  it('normalizes unknown version from the observation without changing the raw source',()=>{
    const f=retainedLocalFixture();try{
      const original=f.source.content,card=f.publish('cache misses',f.quote,'unknown');
      expect(f.store.get('cards',card.id)?.experience?.codeVersion).toBe(f.observation.snapshot.revision);
      expect(f.store.get('sources',f.source.id)?.content).toBe(original);
      const link=f.store.list('actions').find(row=>row.kind==='experience.evidence-link');
      expect(link?.payload.association).toMatchObject({versionBinding:{reported:'unknown',observedRevision:f.observation.snapshot.revision}});
      expect(f.store.searchCards('cache misses',f.project)[0]?.experienceReference?.label).toBe('historical-test-backed-reference');
    }finally{f.store.close();}
  });

  it('does not pair the unrelated cache check with an ambiguous timeout report',()=>{
    const f=retainedLocalFixture();try{
      const quote='Cache misses in docs/cache.ts: npm test -- tests/cache.test.ts; request timeouts in docs/network.ts: npm test -- tests/network.test.ts.';
      const command='npm test -- tests/cache.test.ts',positive=relations({problem:'Cache misses',files:['docs/cache.ts'],checks:[command]});
      const source={...f.source,content:`${positive}\n${quote}`};
      const project={...f.project,allowedPaths:['docs/','tests/'],trustedChecks:[command,'npm test -- tests/network.test.ts']};
      f.store.save('projects',project);f.store.save('sources',source);f.store.save('tasks',{...f.task,description:source.content});
      const old=f.store.get('actions',f.observation.id)!;f.store.delete('actions',old.id);
      const files=['docs/cache.ts','docs/network.ts','tests/cache.test.ts'].map(path=>({path,sha256:'b'.repeat(64),mode:'100644'}));
      const observation:TestObservation={...f.observation,id:'',snapshot:{...f.observation.snapshot,files},checks:[{id:stableId('local-check',command),command,testFile:'tests/cache.test.ts',result:'success',outputDigest:'f'.repeat(64)}]};
      if(observation.origin.kind!=='local')throw new Error('Expected local observation');
      observation.id=stableId('local-test-observation',observation.origin.runId,digest(observation.origin),digest(observation));
      const accepted={...(old.payload.accepted as Record<string,unknown>),sourceHash:digest(source),policyHash:knowledgePolicyHash(project)};
      f.store.save('actions',{...old,id:observation.id,payload:{...old.payload,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted)}});
      const make=(problem:string,file:string,record:string)=>publishKnowledge(f.store,source,{cards:[{title:problem,body:problem,quote:record,aliases:[problem],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem,symptomAliases:[problem],solution:'Review the configuration',files:[file],productId:project.id,codeVersion:observation.snapshot.revision,environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const ambiguous=make('request timeouts','docs/network.ts',quote),correct=make('Cache misses','docs/cache.ts',positive);
      expect(f.store.searchCards('request timeouts',project)).toEqual([]);
      expect(f.store.searchCards('request timeouts',project,20,{usage:'browse'}).find(value=>value.id===ambiguous.id)).toMatchObject({experienceState:{state:'pending'}});
      expect(f.store.searchCards('Cache misses',project).map(value=>value.id)).toContain(correct.id);
    }finally{f.store.close();}
  });

  it.each(['','"'])('keeps a same-file multi-issue passage pending when the other check ran (outer quote %s)',outer=>{
    const f=retainedLocalFixture();try{
      const quote=`${outer}Cache misses in docs/test.ts: npm test -- docs/test.ts; request timeouts in the same file: npm test -- docs/network.test.ts.${outer}`;
      const correctQuote=relations({problem:'Cache misses',files:[f.file.path],checks:[f.project.trustedChecks[0]!]});
      const project={...f.project,trustedChecks:[...f.project.trustedChecks,'npm test -- docs/network.test.ts']},source={...f.source,content:`${correctQuote}\n${quote}`};
      f.store.save('projects',project);f.store.save('sources',source);f.store.save('tasks',{...f.task,description:source.content});
      const row=f.store.get('actions',f.observation.id)!,accepted={...(row.payload.accepted as Record<string,unknown>),sourceHash:digest(source),policyHash:knowledgePolicyHash(project)};
      f.store.save('actions',{...row,payload:{...row.payload,accepted,acceptedDigest:digest(accepted)}});
      const card=publishKnowledge(f.store,source,{cards:[{title:'request timeouts',body:'request timeouts',quote,aliases:['request timeouts'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'request timeouts',symptomAliases:['request timeouts'],solution:'Review the configuration',files:[f.file.path],productId:project.id,codeVersion:f.observation.snapshot.revision,environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      expect(f.store.searchCards('request timeouts',project)).toEqual([]);
      expect(f.store.searchCards('request timeouts',project,20,{usage:'browse'}).find(value=>value.id===card.id)).toMatchObject({experienceState:{state:'pending'}});
      const correct=publishKnowledge(f.store,source,{cards:[{title:'Cache misses',body:'Cache misses',quote:correctQuote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'Cache misses',symptomAliases:['cache'],solution:'Review the configuration',files:[f.file.path],productId:project.id,codeVersion:f.observation.snapshot.revision,environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      expect(f.store.searchCards('Cache misses',project).map(value=>value.id)).toContain(correct.id);
      const onlyCacheTrusted={...project,trustedChecks:[f.project.trustedChecks[0]!]};f.store.save('projects',onlyCacheTrusted);
      const updated=f.store.get('actions',f.observation.id)!,newAccepted={...(updated.payload.accepted as Record<string,unknown>),policyHash:knowledgePolicyHash(onlyCacheTrusted)};
      f.store.save('actions',{...updated,payload:{...updated.payload,accepted:newAccepted,acceptedDigest:digest(newAccepted)}});
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      expect(f.store.searchCards('request timeouts',onlyCacheTrusted)).toEqual([]);
    }finally{f.store.close();}
  });

  it('does not use an unrelated same-file failure from an anaphoric multi-issue passage',()=>{
    const f=retainedLocalFixture();try{
      const quote=relations({problem:'request timeouts',files:[f.file.path],checks:['npm test -- docs/test.ts']});
      const ambiguous='Cache misses in docs/test.ts: npm test -- docs/test.ts; request timeouts in the same file: npm test -- docs/network.test.ts.';
      f.project.trustedChecks.push('npm test -- docs/network.test.ts');f.store.save('projects',f.project);
      f.source.content=quote;f.store.save('sources',f.source);f.store.save('tasks',{...f.task,description:quote});
      const row=f.store.get('actions',f.observation.id)!,accepted={...(row.payload.accepted as Record<string,unknown>),sourceHash:digest(f.source),policyHash:knowledgePolicyHash(f.project)};
      f.store.save('actions',{...row,payload:{...row.payload,accepted,acceptedDigest:digest(accepted)}});
      const card=f.publish('request timeouts',quote);
      const failure=seedAdditional(f,'ambiguous-same-file','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40),ambiguous);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[]}}});
      expect(linkAvailableExperienceEvidence(f.store,failure.observation.id)).toBe(0);
    }finally{f.store.close();}
  });

  it('keeps separately explicit same-file relations bound to their own successful checks',()=>{
    const f=retainedLocalFixture();try{
      const network='npm test -- docs/network.test.ts',quote=relations({problem:'Cache misses',files:[f.file.path],checks:['npm test -- docs/test.ts']},{problem:'request timeouts',files:[f.file.path],checks:[network]});
      f.project.trustedChecks.push(network);f.store.save('projects',f.project);f.source.content=quote;f.store.save('sources',f.source);f.store.save('tasks',{...f.task,description:quote});
      const row=f.store.get('actions',f.observation.id)!;f.store.delete('actions',row.id);
      const observation:TestObservation={...f.observation,id:'',snapshot:{...f.observation.snapshot,files:[f.file,{...f.file,path:'docs/network.test.ts'}]},checks:[...f.observation.checks,{id:stableId('local-check',network),command:network,testFile:'docs/network.test.ts',result:'success',outputDigest:'a'.repeat(64)}]};
      if(observation.origin.kind!=='local')throw new Error('Expected local observation');observation.id=stableId('local-test-observation',observation.origin.runId,digest(observation.origin),digest(observation));
      const accepted={...(row.payload.accepted as Record<string,unknown>),sourceHash:digest(f.source),policyHash:knowledgePolicyHash(f.project)};
      f.store.save('actions',{...row,id:observation.id,payload:{...row.payload,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted)}});
      const card=publishKnowledge(f.store,f.source,{cards:[{title:'request timeouts',body:'request timeouts',quote,aliases:['request timeouts'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'request timeouts',symptomAliases:['request timeouts'],solution:'Review the configuration',files:[f.file.path],productId:f.project.id,codeVersion:observation.snapshot.revision,environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const view=experienceReference(f.store,card,f.project);
      expect(view).toMatchObject({eligible:true,reference:{observed:[{checks:[{command:network}],relevance:{quote}}]}});
    }finally{f.store.close();}
  });

  it('keeps punctuation inside an exact quoted command out of relation boundaries',()=>{
    const f=retainedLocalFixture();try{
      const command="npm test -- 'docs/test.ts;verify'",quote=relations({problem:'cache misses',files:[f.file.path],checks:[command]});
      f.project.trustedChecks=[command];f.store.save('projects',f.project);f.source.content=quote;f.store.save('sources',f.source);f.store.save('tasks',{...f.task,description:quote});
      const row=f.store.get('actions',f.observation.id)!;f.store.delete('actions',row.id);
      const observation:TestObservation={...f.observation,id:'',checks:[{...f.observation.checks[0]!,id:stableId('local-check',command),command}]};
      if(observation.origin.kind!=='local')throw new Error('Expected local observation');observation.id=stableId('local-test-observation',observation.origin.runId,digest(observation.origin),digest(observation));
      const accepted={...(row.payload.accepted as Record<string,unknown>),sourceHash:digest(f.source),policyHash:knowledgePolicyHash(f.project)};
      f.store.save('actions',{...row,id:observation.id,payload:{...row.payload,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted)}});
      const card=f.publish('cache misses',quote);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{observed:[{checks:[{command}],relevance:{quote}}]}});
    }finally{f.store.close();}
  });

  it.each(['success','failure','missing'] as const)('retains a single-regression success with a second %s check',secondResult=>{
    const f=retainedLocalFixture();try{
      const second='npm test -- docs/network.test.ts',quote=relations({problem:'cache misses',files:[f.file.path],checks:['npm test -- docs/test.ts',second]});
      const project={...f.project,trustedChecks:[...f.project.trustedChecks,second]},source={...f.source,content:quote};
      f.store.save('projects',project);f.store.save('sources',source);f.store.save('tasks',{...f.task,description:quote});
      const row=f.store.get('actions',f.observation.id)!;f.store.delete('actions',row.id);
      const observation:TestObservation={...f.observation,id:'',snapshot:{...f.observation.snapshot,files:[f.file,{...f.file,path:'docs/network.test.ts'}]},checks:[...f.observation.checks,...(secondResult==='missing'?[]:[{id:stableId('local-check',second),command:second,testFile:'docs/network.test.ts',result:secondResult,outputDigest:'a'.repeat(64)}])]};
      if(observation.origin.kind!=='local')throw new Error('Expected local observation');
      observation.id=stableId('local-test-observation',observation.origin.runId,digest(observation.origin),digest(observation));
      const accepted={...(row.payload.accepted as Record<string,unknown>),sourceHash:digest(source),policyHash:knowledgePolicyHash(project)};
      f.store.save('actions',{...row,id:observation.id,payload:{...row.payload,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted)}});
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote,aliases:['cache misses'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache misses'],solution:'Review the configuration',files:[f.file.path],productId:project.id,codeVersion:observation.snapshot.revision,environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const view=f.store.searchCards('cache misses',project).find(value=>value.id===card.id);
      expect(view?.experienceReference?.observed[0]?.checks.map(check=>check.result)).toEqual(secondResult==='success'?['success','success']:['success']);
      if(secondResult==='failure')expect(view?.experienceReference?.currentApplicability).toMatchObject({status:'needs-revalidation',evidenceIds:[observation.id],reasons:expect.arrayContaining([expect.stringContaining(second)])});
      if(secondResult==='missing')expect(view?.experienceReference?.currentApplicability.reasons).toEqual(expect.arrayContaining([expect.stringContaining(second)]));
    }finally{f.store.close();}
  });

  it('does not attribute a separate unbound solution statement to the candidate',()=>{
    const f=retainedLocalFixture();try{
      f.publish();expect(f.store.searchCards('cache misses',f.project)[0]?.experienceReference?.reportedSolution.status).toBe('inference');
      const source={...f.source,id:'grounded',externalId:'grounded',content:`${f.quote}\nClear the cache`};f.store.save('sources',source);
      const card=publishKnowledge(f.store,source,{cards:[{title:'grounded cache misses',body:'cache misses',quote:f.quote,aliases:['cache misses'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache miss'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:f.observation.snapshot.revision,environment:'reported',invalidationConditions:['changes']}}]})[0]!;
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{reportedSolution:{status:'inference'}}});
    }finally{f.store.close();}
  });

  it.each(['Do not Clear the cache; it deletes data.','Unrelated storage advice: Clear the cache.'])('does not report a rejected or unrelated solution mention: %s',statement=>{
    const f=retainedLocalFixture();try{
      const source={...f.source,id:'solution-source',externalId:'solution-source',content:`${f.quote}\n${statement}`};f.store.save('sources',source);
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses solution',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:f.observation.snapshot.revision,environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{reportedSolution:{text:'Clear the cache',status:'inference'}}});
    }finally{f.store.close();}
  });

  it('preserves the full meaning of an explicitly candidate-bound solution statement',()=>{
    const f=retainedLocalFixture();try{
      const solution='For cache misses in docs/test.ts, do not clear the cache; it deletes data.';
      const quote=`${f.quote}\n${solution}`;f.source.content=quote;f.store.save('sources',f.source);f.store.save('tasks',{...f.task,description:quote});
      const row=f.store.get('actions',f.observation.id)!,accepted={...(row.payload.accepted as Record<string,unknown>),sourceHash:digest(f.source)};
      f.store.save('actions',{...row,payload:{...row.payload,accepted,acceptedDigest:digest(accepted)}});
      const source={...f.source,id:'complete-solution',externalId:'complete-solution'};f.store.save('sources',source);
      const card=publishKnowledge(f.store,source,{cards:[{title:'complete solution',body:'cache misses',quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution,files:[f.file.path],productId:f.project.id,codeVersion:f.observation.snapshot.revision,environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{reportedSolution:{text:solution,status:'reported'}}});
    }finally{f.store.close();}
  });

  it.each(['withdrawn','superseded'] as const)('preserves normalization origin after the first relation is %s before a replacement arrives',status=>{
    const f=retainedLocalFixture();try{
      const candidate={...f.source,id:'candidate-source',externalId:'candidate-source'};f.store.save('sources',candidate);
      const original=publishKnowledge(f.store,candidate,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      let card=f.store.get('cards',original.id)!;expect(card.experience?.codeVersion).toBe(f.observation.snapshot.revision);
      const oldLink=f.store.list('actions').find(row=>row.kind==='experience.evidence-link'&&JSON.stringify(row.payload).includes(card.id))!;
      invalidateSource(f.store,f.source.id,status);
      const tombstone=f.store.get('actions',oldLink.id)?.payload;expect(tombstone).toMatchObject({retracted:true,normalizationOrigin:{cardId:card.id,reported:'unknown',observedRevision:f.observation.snapshot.revision}});
      for(const sensitive of [f.quote,f.observation.id,'Clear the cache',f.source.locator])expect(JSON.stringify(tombstone)).not.toContain(sensitive);
      const next=seedAdditional(f,'replacement','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(f.store,next.observation.id)).toBeGreaterThan(0);
      card=f.store.get('cards',original.id)!;
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{observationIds:[next.observation.id],versionBinding:{reported:'unknown',observedRevision:next.observation.snapshot.revision}}});
    }finally{f.store.close();}
  });

  it('does not lose normalization origin if the first observation becomes unavailable before link sanitation',()=>{
    const f=retainedLocalFixture();try{
      const source={...f.source,id:'candidate-source',externalId:'candidate-source'};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      f.store.save('sources',{...f.source,status:'withdrawn'});
      const later=seedAdditional(f,'new-record','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(f.store,later.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,f.store.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[later.observation.id],versionBinding:{reported:'unknown',observedRevision:later.observation.snapshot.revision}}});
    }finally{f.store.close();}
  });

  it('does not reinterpret a covered edit as authored version metadata while the original link is intact',()=>{
    const f=retainedLocalFixture();try{
      const source={...f.source,id:'candidate-before-tombstone',externalId:'candidate-before-tombstone'};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',original.id)!;
      const link=f.store.experienceActions('experience.evidence-link',{scope:f.project,cardId:original.id})[0]!;
      expect(link.payload).toHaveProperty('association.versionBinding');
      f.store.save('cards',{...normalized,experience:{...normalized.experience!,solution:'A covered edit'}});
      const next=seedAdditional(f,'before-tombstone','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(f.store,next.observation.id)).toBeGreaterThan(0);
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      expect(experienceReference(f.store,f.store.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[next.observation.id],versionBinding:{reported:'unknown',observedRevision:next.observation.snapshot.revision}}});
      expect(f.store.experienceActions('experience.evidence-link',{scope:f.project,cardId:original.id})).toHaveLength(2);
      invalidateSource(f.store,f.source.id,'withdrawn');
      expect(experienceReference(f.store,f.store.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[next.observation.id],versionBinding:{reported:'unknown',observedRevision:next.observation.snapshot.revision}}});
    }finally{f.store.close();}
  });

  it('retains normalization origin across reopen before the original link is sanitized',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-intact-origin-')),path=join(root,'store.sqlite');const f=retainedLocalFixture(false,'',path);let reopened:Store|undefined;
    try{
      const source={...f.source,id:'candidate-intact-reopen',externalId:'candidate-intact-reopen'};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',original.id)!;f.store.save('cards',{...normalized,experience:{...normalized.experience!,solution:'A covered edit'}});f.store.close();
      reopened=new Store(path);const next=seedAdditional({...f,store:reopened},'intact-reopened','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(reopened,next.observation.id)).toBeGreaterThan(0);
      expect(linkAvailableExperienceEvidence(reopened,f.observation.id)).toBe(0);
      expect(experienceReference(reopened,reopened.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[next.observation.id],versionBinding:{reported:'unknown',observedRevision:next.observation.snapshot.revision}}});
    }finally{reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('keeps the normalization marker through reopen, and does not bind it to a changed candidate',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-origin-')),path=join(root,'store.sqlite');const f=retainedLocalFixture(false,'',path);let reopened:Store|undefined;
    try{
      const source={...f.source,id:'candidate-source',externalId:'candidate-source'};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      invalidateSource(f.store,f.source.id,'withdrawn');f.store.close();reopened=new Store(path);
      const marker=reopened.list('actions').find(row=>row.kind==='experience.evidence-link'&&row.payload.normalizationOrigin)!;
      expect(marker.payload.normalizationOrigin).toMatchObject({cardId:original.id,reported:'unknown'});
      for(const sensitive of [f.quote,f.observation.id,'Clear the cache',f.source.locator])expect(JSON.stringify(marker.payload)).not.toContain(sensitive);
      expect(experienceReference(reopened,reopened.get('cards',original.id)!,f.project).eligible).toBe(false);
      const holder={...f,store:reopened};const later=seedAdditional(holder,'after-reopen','success','2026-11-04T13:00:00Z');
      const saved=reopened.get('cards',original.id)!;reopened.save('cards',{...saved,experience:{...saved.experience!,solution:'Different solution'}});
      expect(linkAvailableExperienceEvidence(reopened,later.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(reopened,reopened.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[later.observation.id],versionBinding:{reported:'unknown',observedRevision:later.observation.snapshot.revision}}});
      reopened.save('cards',saved);expect(linkAvailableExperienceEvidence(reopened,later.observation.id)).toBe(0);
      const fresh=seedAdditional(holder,'after-restore','success','2026-11-04T14:00:00Z');expect(linkAvailableExperienceEvidence(reopened,fresh.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(reopened,saved,f.project)).toMatchObject({eligible:true,reference:{versionBinding:{reported:'unknown',observedRevision:fresh.observation.snapshot.revision}}});
      invalidateSource(reopened,source.id,'withdrawn');expect(JSON.stringify(reopened.get('actions',marker.id)?.payload)).not.toContain('normalizationOrigin');
    }finally{reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('keeps normalization derived from an ephemeral relation in memory and out of reopened storage',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-transient-')),path=join(root,'store.sqlite');const f=retainedLocalFixture(false,'',path,'ephemeral');let reopened:Store|undefined;
    try{
      const source={...f.source,id:'candidate-source',externalId:'candidate-source',retention:'permanent' as const};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      expect(f.store.get('cards',original.id)?.experience?.codeVersion).toBe(f.observation.snapshot.revision);
      invalidateSource(f.store,f.source.id,'withdrawn');const later=seedAdditional(f,'durable','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(f.store,later.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,f.store.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{versionBinding:{reported:'unknown'}}});
      f.store.close();reopened=new Store(path);
      expect(reopened.get('cards',original.id)?.experience?.codeVersion).toBe('unknown');
      expect(reopened.list('actions').some(row=>row.kind==='experience.evidence-link'&&JSON.stringify(row.payload).includes(original.id))).toBe(false);
      expect(linkAvailableExperienceEvidence(reopened,later.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(reopened,reopened.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{versionBinding:{reported:'unknown'}}});
    }finally{reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('reopens the original unknown candidate before an independent permanent observation arrives',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-ephemeral-reopen-')),path=join(root,'store.sqlite');const f=retainedLocalFixture(false,'',path,'ephemeral');let reopened:Store|undefined;
    try{
      const source={...f.source,id:'candidate-source',externalId:'candidate-source',retention:'permanent' as const};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      expect(f.store.get('cards',original.id)?.experience?.codeVersion).toBe(f.observation.snapshot.revision);f.store.close();
      reopened=new Store(path);expect(reopened.get('cards',original.id)?.experience?.codeVersion).toBe('unknown');
      expect(reopened.get('actions',f.observation.id)).toBeUndefined();
      const later=seedAdditional({...f,store:reopened},'after-reopen','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(reopened,later.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(reopened,reopened.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[later.observation.id],versionBinding:{reported:'unknown',observedRevision:later.observation.snapshot.revision}}});
    }finally{reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('persists authored card updates and exact expiry across a temporary normalization and reopen',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-transient-updates-')),path=join(root,'store.sqlite');const f=retainedLocalFixture(false,'',path,'ephemeral');let reopened:Store|undefined,afterDeadline:Store|undefined,engine:Workbench|undefined;
    try{
      const source={...f.source,id:'candidate-updates',externalId:'candidate-updates',retention:'permanent' as const};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const deadline='2026-11-05T12:30:00+00:00',normalized=f.store.get('cards',original.id)!;
      expect(normalized.experience?.codeVersion).toBe(f.observation.snapshot.revision);
      f.store.save('cards',{...normalized,title:'Updated title',body:'Updated body',expiresAt:deadline});
      f.store.save('cards',{...f.store.get('cards',original.id)!,aliases:['updated alias']});
      f.store.close();reopened=new Store(path);
      expect(reopened.get('cards',original.id)).toMatchObject({title:'Updated title',body:'Updated body',aliases:['updated alias'],expiresAt:deadline,experience:{codeVersion:'unknown'}});
      expect(reopened.get('actions',f.observation.id)).toBeUndefined();
      const before=seedAdditional({...f,store:reopened},'update-before-deadline','success','2026-11-05T12:10:00Z');
      expect(linkAvailableExperienceEvidence(reopened,before.observation.id)).toBeGreaterThan(0);
      expect(reopened.searchCards('updated alias',f.project).map(card=>card.id)).toContain(original.id);
      reopened.close();vi.setSystemTime(new Date('2026-11-05T12:31:00Z'));afterDeadline=new Store(path);
      expect(afterDeadline.get('cards',original.id)?.expiresAt).toBe(deadline);
      expect(afterDeadline.searchCards('updated alias',f.project)).toEqual([]);
      const after=seedAdditional({...f,store:afterDeadline},'update-after-deadline','success','2026-11-05T12:31:00Z');
      expect(linkAvailableExperienceEvidence(afterDeadline,after.observation.id)).toBe(0);
      expect(experienceReference(afterDeadline,afterDeadline.get('cards',original.id)!,f.project)).toMatchObject({eligible:false});
      f.project.budgetUsd=10;afterDeadline.save('projects',f.project);const config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.ownerId=f.project.ownerId;
      const worker=new DemoWorker('grok');let workerCards:unknown;
      engine=new Workbench({store:afterDeadline,config,workers:[{name:'grok',async run(input){workerCards=input.cards;return worker.run(input);}}],writer:demoWriter,research:demoResearch});
      engine.ingest({projectId:f.project.id,externalId:'after-expiry',title:'cache misses',content:'cache misses',purpose:'task'});await engine.tick();
      expect(workerCards).toBeDefined();expect(JSON.stringify(workerCards)).not.toContain(original.id);
    }finally{await engine?.shutdown();afterDeadline?.close();reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});vi.useRealTimers();}
  });

  it('allows a fresh independent observation to bind an authored edit without rebinding the temporary observation',()=>{
    const f=retainedLocalFixture(false,'',':memory:','ephemeral');try{
      const source={...f.source,id:'candidate-live-edit',externalId:'candidate-live-edit',retention:'permanent' as const};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',original.id)!;f.store.save('cards',{...normalized,title:'Owner updated title'});
      const next=seedAdditional(f,'live-independent','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(f.store,next.observation.id)).toBeGreaterThan(0);
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      expect(experienceReference(f.store,f.store.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[next.observation.id],versionBinding:{reported:'unknown',observedRevision:next.observation.snapshot.revision}}});
    }finally{f.store.close();}
  });

  it('persists explicit withdrawal while the version is overlaid from temporary evidence',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-transient-withdraw-')),path=join(root,'store.sqlite');const f=retainedLocalFixture(false,'',path,'ephemeral');let reopened:Store|undefined;
    try{
      const source={...f.source,id:'candidate-withdraw',externalId:'candidate-withdraw',retention:'permanent' as const};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      f.store.save('cards',{...f.store.get('cards',original.id)!,status:'withdrawn'});f.store.close();reopened=new Store(path);
      expect(reopened.get('cards',original.id)).toMatchObject({status:'withdrawn'});
      const next=seedAdditional({...f,store:reopened},'after-withdrawal','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(reopened,next.observation.id)).toBe(0);expect(reopened.searchCards('cache misses',f.project)).toEqual([]);
    }finally{reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('keeps history under drift, requires fresh checks for checked, and labels a later failure',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish(),scope=f.project;
      const drift=experienceReference(f.store,card,scope,{projectId:'p',domain:'personal',repository:scope.repository,revision:'d'.repeat(40),environment:{node:'25'},observedAt:'2026-11-04T11:00:00Z'});
      expect(drift).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',reasons:expect.arrayContaining([expect.stringContaining('Current revision'),expect.stringContaining('Current node')])}}});
      const checked=experienceReference(f.store,card,scope,{projectId:'p',domain:'personal',repository:scope.repository,revision:f.observation.snapshot.revision,environment:{node:'24'},observedAt:'2026-11-04T11:00:00Z'});
      expect(checked).toMatchObject({eligible:true,reference:{currentApplicability:{status:'checked',evidenceIds:[f.observation.id]}}});
      const later=seedAdditional(f,'later','failure','2026-11-04T13:00:00Z',false);
      expect(experienceReference(f.store,card,scope)).toMatchObject({eligible:true,reference:{observationIds:[f.observation.id],currentApplicability:{status:'needs-revalidation',evidenceIds:[later.observation.id]}}});
    }finally{f.store.close();}
  });

  it('retains history and reports a separately authorized later failure at a changed revision',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish();const later=seedAdditional(f,'revision','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40));
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{observationIds:[f.observation.id],currentApplicability:{status:'needs-revalidation',evidenceIds:[later.observation.id],reasons:expect.arrayContaining([expect.stringContaining(later.observation.observedAt)])}}});
    }finally{f.store.close();}
  });

  it('orders offset timestamps by the actual observation instant',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish(),later=seedAdditional(f,'offset','failure','2026-11-04T10:00:00-04:00',true,'d'.repeat(40));
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:[later.observation.id]}}});
    }finally{f.store.close();}
  });

  it('keeps local history but does not invent an execution time for legacy observations',()=>{
    const f=retainedLocalFixture();try{
      const row=f.store.get('actions',f.observation.id)!;f.store.delete('actions',row.id);
      const checks=f.observation.checks.map(({process:_,...check})=>check),observation:TestObservation={...f.observation,id:'',checks};
      if(observation.origin.kind!=='local')throw new Error('Expected local observation');observation.id=stableId('local-test-observation',observation.origin.runId,digest(observation.origin),digest(observation));
      f.store.save('actions',{...row,id:observation.id,payload:{...row.payload,observation,digest:digest(observation)}});
      const card=f.publish(),current={projectId:'p',domain:'personal',repository:f.project.repository,revision:observation.snapshot.revision,environment:{node:'24'},observedAt:'2026-11-04T11:00:00Z'};
      expect(experienceReference(f.store,card,f.project,current)).toMatchObject({eligible:true,reference:{observed:[{observedAt:observation.observedAt,timeBasis:'unknown'}],currentApplicability:{status:'unknown',reasons:expect.arrayContaining([expect.stringContaining('execution time is unknown')])}}});
      const failure=seedAdditional({...f,observation},'legacy-failure','failure','2026-11-04T13:00:00Z');
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[failure.observation.id],reasons:expect.arrayContaining([expect.stringContaining('execution order is unknown')])}}});
    }finally{f.store.close();}
  });

  it('ignores unrelated later task text, retracts a failure, and accepts an independent later success',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish();seedAdditional(f,'unrelated','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40),'An unrelated lint task.');
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown'}}});
      const failure=seedAdditional(f,'related','failure','2026-11-04T14:00:00Z',true,'d'.repeat(40));
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:[failure.observation.id]}}});
      invalidateSource(f.store,failure.source.id,'withdrawn');
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown'}}});
      const success=seedAdditional(f,'positive','success','2026-11-04T15:00:00Z');expect(linkAvailableExperienceEvidence(f.store,success.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{observationIds:expect.arrayContaining([f.observation.id,success.observation.id]),currentApplicability:{status:'unknown'}}});
    }finally{f.store.close();}
  });

  it('does not hide one related check failure behind a newer success for a different check',()=>{
    const f=retainedLocalFixture();try{
      const second='npm test -- docs/network.test.ts',quote=relations({problem:'cache misses',files:[f.file.path],checks:['npm test -- docs/test.ts',second]});
      f.project.trustedChecks.push(second);f.store.save('projects',f.project);f.source.content=quote;f.store.save('sources',f.source);f.store.save('tasks',{...f.task,description:quote});
      const row=f.store.get('actions',f.observation.id)!,accepted={...(row.payload.accepted as Record<string,unknown>),sourceHash:digest(f.source),policyHash:knowledgePolicyHash(f.project)};
      f.store.save('actions',{...row,payload:{...row.payload,accepted,acceptedDigest:digest(accepted)}});const card=f.publish('cache misses',quote);
      const seeded=seedAdditional(f,'other-check-failure','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40),quote),failureRow=f.store.get('actions',seeded.observation.id)!;f.store.delete('actions',failureRow.id);
      const failure:TestObservation={...seeded.observation,id:'',snapshot:{...seeded.observation.snapshot,files:[f.file,{...f.file,path:'docs/network.test.ts'}]},checks:[{id:stableId('local-check',second),command:second,testFile:'docs/network.test.ts',result:'failure',outputDigest:'a'.repeat(64),process:{exitCode:1,signal:null,timedOut:false,startedAt:'2026-11-04T13:00:00Z',finishedAt:'2026-11-04T13:00:00Z'}}]};
      if(failure.origin.kind!=='local')throw new Error('Expected local observation');failure.id=stableId('local-test-observation',failure.origin.runId,digest(failure.origin),digest(failure));
      f.store.save('actions',{...failureRow,id:failure.id,payload:{...failureRow.payload,observation:failure,digest:digest(failure)}});
      const success=seedAdditional(f,'newer-other-success','success','2026-11-04T14:00:00Z',true,undefined,quote);expect(linkAvailableExperienceEvidence(f.store,success.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:[failure.id],reasons:expect.arrayContaining([expect.stringContaining(second)])}}});
    }finally{f.store.close();}
  });

  it('reports only the check in the later candidate-specific relation',()=>{
    const f=retainedLocalFixture();try{
      const second='npm test -- docs/network.test.ts',quote=relations({problem:'cache misses',files:[f.file.path],checks:['npm test -- docs/test.ts',second]});
      f.project.trustedChecks.push(second);f.store.save('projects',f.project);f.source.content=quote;f.store.save('sources',f.source);f.store.save('tasks',{...f.task,description:quote});
      const row=f.store.get('actions',f.observation.id)!,accepted={...(row.payload.accepted as Record<string,unknown>),sourceHash:digest(f.source),policyHash:knowledgePolicyHash(f.project)};
      f.store.save('actions',{...row,payload:{...row.payload,accepted,acceptedDigest:digest(accepted)}});const card=f.publish('cache misses',quote);
      const unrelated=relations({problem:'cache misses',files:[f.file.path],checks:['npm test -- docs/test.ts']},{problem:'unrelated issue',files:['docs/other.ts'],checks:[second]});
      const seeded=seedAdditional(f,'mixed-relations','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40),unrelated),failureRow=f.store.get('actions',seeded.observation.id)!;f.store.delete('actions',failureRow.id);
      const failure:TestObservation={...seeded.observation,id:'',snapshot:{...seeded.observation.snapshot,files:[f.file,{...f.file,path:'docs/network.test.ts'},{...f.file,path:'docs/other.ts'}]},checks:[...seeded.observation.checks,{id:stableId('local-check',second),command:second,testFile:'docs/network.test.ts',result:'failure',outputDigest:'a'.repeat(64),process:{exitCode:1,signal:null,timedOut:false,startedAt:'2026-11-04T13:00:00Z',finishedAt:'2026-11-04T13:00:00Z'}}]};
      if(failure.origin.kind!=='local')throw new Error('Expected local observation');failure.id=stableId('local-test-observation',failure.origin.runId,digest(failure.origin),digest(failure));
      f.store.save('actions',{...failureRow,id:failure.id,payload:{...failureRow.payload,observation:failure,digest:digest(failure)}});
      const view=experienceReference(f.store,card,f.project);expect(view).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:[failure.id]}}});
      if(!view.eligible)throw new Error('Expected history');expect(view.reference.currentApplicability.reasons.filter(reason=>reason.includes(failure.id)).join(' ')).not.toContain(second);
    }finally{f.store.close();}
  });

  it('ignores an unrelated lint failure and does not describe it as the related failure',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish();
      const withChecks=(suffix:string,time:string,includeRelated:boolean)=>{
        const seeded=seedAdditional(f,suffix,'failure',time,true,'d'.repeat(40));const row=f.store.get('actions',seeded.observation.id)!;f.store.delete('actions',row.id);
        const lint={id:stableId('local-check','npm run lint'),command:'npm run lint',result:'failure' as const,outputDigest:'a'.repeat(64)};
        const observation:TestObservation={...seeded.observation,id:'',checks:[...(includeRelated?seeded.observation.checks:[]),lint]};
        if(observation.origin.kind!=='local')throw new Error('Expected local observation');
        observation.id=stableId('local-test-observation',observation.origin.runId,digest(observation.origin),digest(observation));
        f.store.save('actions',{...row,id:observation.id,payload:{...row.payload,observation,digest:digest(observation)}});return observation;
      };
      withChecks('lint-only','2026-11-04T13:00:00Z',false);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown'}}});
      const related=withChecks('mixed','2026-11-04T14:00:00Z',true),view=experienceReference(f.store,card,f.project);
      expect(view).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:[related.id]}}});
      if(!view.eligible)throw new Error('Expected history');
      expect(view.reference.currentApplicability.reasons.join(' ')).not.toContain('npm run lint');
    }finally{f.store.close();}
  });

  it('isolates a candidate relation from an unrelated named lint sentence in the same source',()=>{
    const f=retainedLocalFixture();try{
      const lint='npm run lint',quote=`${f.quote}\nUnrelated lint check ${lint}.`,project={...f.project,trustedChecks:[...f.project.trustedChecks,lint]},source={...f.source,content:quote};
      f.store.save('projects',project);f.store.save('sources',source);f.store.save('tasks',{...f.task,description:quote});
      const row=f.store.get('actions',f.observation.id)!,accepted={...(row.payload.accepted as Record<string,unknown>),sourceHash:digest(source),policyHash:knowledgePolicyHash(project)};
      f.store.save('actions',{...row,payload:{...row.payload,accepted,acceptedDigest:digest(accepted)}});
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:project.id,codeVersion:f.observation.snapshot.revision,environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const later=seedAdditional({...f,project,source},'unrelated-lint','failure','2026-11-04T13:00:00Z');const original=f.store.get('actions',later.observation.id)!;f.store.delete('actions',original.id);
      const observation:TestObservation={...later.observation,id:'',checks:[{id:stableId('local-check',lint),command:lint,result:'failure',outputDigest:'a'.repeat(64)}]};
      if(observation.origin.kind!=='local')throw new Error('Expected local observation');observation.id=stableId('local-test-observation',observation.origin.runId,digest(observation.origin),digest(observation));
      f.store.save('actions',{...original,id:observation.id,payload:{...original.payload,observation,digest:digest(observation)}});
      const view=experienceReference(f.store,card,project);expect(view).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[]}}});
      if(!view.eligible)throw new Error('Expected history');expect(view.reference.currentApplicability.reasons.join(' ')).not.toContain(lint);
      expect(view.reference.observed[0]?.relevance.quote).toBe(f.quote);
    }finally{f.store.close();}
  });

  it('includes temporary observations and drops rolled-back or withdrawn failures from the index',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish();expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown'}}});
      expect(()=>f.store.transaction(()=>{const rolled=seedAdditional(f,'rollback','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40),f.source.content,'ephemeral');expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{evidenceIds:[rolled.observation.id]}}});throw new Error('rollback');})).toThrow('rollback');
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown'}}});
      const temporary=seedAdditional(f,'temporary','failure','2026-11-04T14:00:00Z',true,'d'.repeat(40),f.source.content,'ephemeral');
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:[temporary.observation.id]}}});
      invalidateSource(f.store,temporary.source.id,'withdrawn');
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown'}}});
    }finally{f.store.close();}
  });

  it.each(['superseded','withdrawn'] as const)('retracts one %s relevance source while preserving an independent alternative',status=>{
    const f=retainedLocalFixture();try{
      const candidateSource={...f.source,id:'candidate-source',externalId:'candidate-source'};f.store.save('sources',candidateSource);
      const original=f.publish();const card={...original,id:'independent-card',sourceId:candidateSource.id,locator:candidateSource.locator};f.store.save('cards',card);
      const alternative=seedAdditional(f,'alternative','success','2026-11-04T12:30:00Z');
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBeGreaterThan(0);expect(linkAvailableExperienceEvidence(f.store,alternative.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{observationIds:expect.arrayContaining([f.observation.id,alternative.observation.id])}});
      const link=f.store.list('actions').find(row=>row.kind==='experience.evidence-link'&&JSON.stringify(row.payload).includes(f.observation.id)&&JSON.stringify(row.payload).includes(card.id))!;
      invalidateSource(f.store,f.source.id,status);
      expect(JSON.stringify(f.store.get('actions',link.id)?.payload)).not.toContain(f.quote);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{observationIds:[alternative.observation.id]}});
    }finally{f.store.close();}
  });

  it('filters high-ranked pending hits before applying the caller limit',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish();
      for(let i=0;i<130;i++)publishKnowledge(f.store,f.source,{cards:[{title:`cache misses cache misses cache misses ${i}`,body:'cache misses cache misses cache misses',quote:'request timeout',aliases:['cache misses'],verification:'reported',kind:'experience',experience:{...card.experience!,problem:'request timeout'}}]});
      expect(f.store.searchCards('cache misses',f.project,100,{usage:'browse'}).map(value=>value.id)).not.toContain(card.id);
      expect(f.store.searchCards('cache misses',f.project,1).map(value=>value.id)).toEqual([card.id]);
    }finally{f.store.close();}
  });

  it('keeps a managed receipt head and merge separate from the tested snapshot and overlay',()=>{
    const f=retainedLocalFixture(true);try{
      const fileContent='delivered specification',head='d'.repeat(40),merge='e'.repeat(40);
      const artifact={taskVersion:1,planHash:'d'.repeat(64),baselineSha:f.observation.snapshot.revision,files:[{path:f.project.prdPath,content:fileContent}],tests:[{command:f.project.trustedChecks[0]!,passed:true,output:''}],summary:'delivered'};
      const receipt={id:'receipt',projectId:'p',domain:'personal',taskId:f.task.id,repository:f.project.repository,path:f.project.prdPath,pullRequestUrl:'https://github.com/owner/repo/pull/1',pullRequestNumber:1,headSha:head,mergeSha:merge,contentHash:digest(fileContent),verifiedAt:'2026-11-04T14:00:00Z',checks:[{name:f.project.trustedChecks[0]!,conclusion:'success',headSha:head,appId:17,url:'https://github.com/owner/repo/checks/1'}]};
      f.store.save('receipts',receipt);f.store.save('tasks',{...f.task,artifact,receiptId:receipt.id});
      const card=f.publish();expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{observed:[{snapshot:{revision:f.observation.snapshot.revision,overlayHash:'a'.repeat(64)}}],delivery:{receiptId:receipt.id,headSha:head,mergeSha:merge},currentApplicability:{status:'unknown'}}});
      expect(experienceReference(f.store,card,f.project,{projectId:'p',domain:'personal',repository:f.project.repository,revision:f.observation.snapshot.revision,environment:{node:'24'},observedAt:'2026-11-04T11:00:00Z'})).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',reasons:expect.arrayContaining([expect.stringContaining('overlay')])}}});
    }finally{f.store.close();}
  });

  it('does not scan all actions for each publication and filtered lookup',()=>{
    const f=retainedLocalFixture();try{
      for(let i=0;i<300;i++)f.store.save('actions',{id:`unrelated-${i}`,projectId:'p',domain:'personal',kind:'unrelated',status:'completed',payload:{},updatedAt:''});
      const list=vi.spyOn(f.store,'list');const card=f.publish();
      expect(f.store.searchCards('cache misses',f.project).map(value=>value.id)).toContain(card.id);
      expect(list.mock.calls.filter(([table])=>table==='actions')).toHaveLength(0);
    }finally{f.store.close();}
  });

  it('updates the observation index incrementally when new evidence and cards alternate',()=>{
    const f=retainedLocalFixture();try{
      const db=(f.store as any).db,prepare=vi.spyOn(db,'prepare'),card=f.publish();
      for(let i=0;i<4;i++){
        seedAdditional(f,`alternate-${i}`,'success',`2026-11-04T1${i+3}:00:00Z`);
        publishKnowledge(f.store,f.source,{cards:[{title:`unrelated ${i}`,body:'request timeout',quote:'request timeout',aliases:['request timeout'],verification:'reported',kind:'experience',experience:{...card.experience!,problem:'request timeout'}}]});
      }
      expect(prepare.mock.calls.filter(([sql])=>typeof sql==='string'&&sql.startsWith('SELECT id, project_id, domain, data FROM actions'))).toHaveLength(5);
    }finally{f.store.close();}
  });

  it('bounds publication and startup work by affected records and measures synchronous delay',async()=>{
    const totalStart=performance.now(),f=retainedLocalFixture(),seedStart=performance.now();let engine:Workbench|undefined,seedMs:number|undefined;
    try{
      const retained:ActionRecord[]=[];
      for(let i=0;i<1000;i++){
        const name=`scale-${i}`,path=`docs/${name}.ts`,command=f.project.trustedChecks[0]!;
        const source={...f.source,id:`source-${name}`,externalId:name,content:relations({problem:name,files:[path],checks:[command]})};f.store.save('sources',source);
        const task={...f.task,id:`task-${name}`,sourceId:source.id};f.store.save('tasks',task);
        const attempt={...f.attempt,id:`attempt-${name}`,taskId:task.id};f.store.save('attempts',attempt);
        const previous=f.observation;if(previous.origin.kind!=='local')throw new Error('Expected local observation');
        const origin={...previous.origin,taskId:task.id,attemptId:attempt.id,runId:`run-${name}`};
        const observation:TestObservation={...previous,id:'',sourceId:source.id,snapshot:{...previous.snapshot,files:[{...f.file,path}]},checks:previous.checks.map(check=>({...check,testFile:path})),origin};
        observation.id=stableId('local-test-observation',origin.runId,digest(origin),digest(observation));
        const accepted={attemptId:attempt.id,taskId:task.id,taskVersion:1,role:'execute' as const,runner:attempt.runner,provider:attempt.provider,model:attempt.model,inputHash:attempt.inputHash,outputHash:'1'.repeat(64),planHash:origin.planHash,artifactHash:origin.artifactHash,runId:origin.runId,sourceHash:digest(source),policyHash:knowledgePolicyHash(f.project)};
        retained.push({id:observation.id,projectId:'p',domain:'personal',taskId:task.id,kind:'experience.test-observation',status:'completed',payload:{schemaVersion:1,observation,digest:digest(observation),accepted,acceptedDigest:digest(accepted),sourceRefs:[{id:source.id,revision:source.revision}]},updatedAt:observation.observedAt});
      }
      f.store.transaction(()=>{for(const action of retained)f.store.save('actions',action);});
      for(let i=0;i<3000;i++)f.store.save('actions',{id:`other-${i}`,projectId:'p',domain:'personal',kind:'unrelated',status:'completed',payload:{},updatedAt:''});
      seedMs=performance.now()-seedStart;
      const list=vi.spyOn(f.store,'list'),get=vi.spyOn(f.store,'get'),sweep=vi.spyOn(f.store,'experienceObservationIds');
      const start=performance.now(),eventLoop=new Promise<number>(resolve=>setImmediate(()=>resolve(performance.now()-start)));
      const linked=f.publish();
      for(let i=0;i<130;i++)publishKnowledge(f.store,f.source,{cards:[{title:`cache misses cache misses ${i}`,body:'request timeout',quote:'request timeout',aliases:['cache misses'],verification:'reported',kind:'experience',experience:{...linked.experience!,problem:'request timeout'}}]});
      const publicationMs=performance.now()-start,lookupStart=performance.now();
      expect(f.store.searchCards('cache misses',f.project).map(card=>card.id)).toContain(linked.id);
      const lookupMs=performance.now()-lookupStart,startupStart=performance.now(),config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);config.projects=[f.project];config.ownerId=f.project.ownerId;
      engine=new Workbench({store:f.store,config,workers:[],writer:demoWriter,research:demoResearch});
      const startupMs=performance.now()-startupStart,delayMs=await eventLoop;
      const broadObservationReads=sweep.mock.calls.length;
      const actionGets=get.mock.calls.filter(([table])=>table==='actions').length;
      expect(broadObservationReads).toBe(1);expect(actionGets).toBeLessThan(4000);expect(list.mock.calls.filter(([table])=>table==='actions')).toHaveLength(0);
      console.info('experience-scale',JSON.stringify({observations:1001,unrelatedActions:3000,publishedCards:131,broadObservationReads,actionGets,publicationMs,lookupMs,startupMs,eventLoopDelayMs:delayMs}));
    }finally{await engine?.shutdown();f.store.close();console.info('experience-scale-phase',JSON.stringify({fixtureMs:seedStart-totalStart,seedMs,totalMs:performance.now()-totalStart}));}
  });

  it('rejects changed candidates, copied links and retracted canonical observations',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish(),link=f.store.list('actions').find(row=>row.kind==='experience.evidence-link')!;
      f.store.save('cards',{...card,verification:'verified',experience:{...card.experience!,solution:'A changed claim'}});
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
      f.store.save('cards',card);expect(f.store.searchCards('cache misses',f.project)).toHaveLength(1);
      f.store.save('actions',{...link,payload:{...link.payload,digest:'0'.repeat(64)}});
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
      f.store.save('actions',link);expect(f.store.searchCards('cache misses',f.project)).toHaveLength(1);
      const observation=f.store.get('actions',f.observation.id)!;f.store.save('actions',{...observation,payload:{retracted:true}});
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
    }finally{f.store.close();}
  });

  it('discards copied derived-view fields from a pending candidate',()=>{
    const f=retainedLocalFixture();try{
      f.store.delete('actions',f.observation.id);const card=f.publish();
      const copied={...card,experienceReference:{label:'forged'},factual:{eligible:true},reportedStatement:{text:'forged',status:'verified'},success:true,observations:[{result:'success'}]};
      f.store.save('cards',copied);
      expect(f.store.get('cards',card.id)).not.toHaveProperty('experienceReference');expect(f.store.get('cards',card.id)).not.toHaveProperty('success');
      const view=f.store.searchCards('cache misses',f.project,20,{usage:'browse'})[0];
      expect(view).toBeDefined();expect(view).not.toHaveProperty('experienceReference');expect(view).not.toHaveProperty('factual');
      expect(view?.reportedStatement).toEqual({text:card.quote,status:'reported'});
      expect(view?.description).toEqual({text:card.body,status:'reported-summary'});
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
    }finally{f.store.close();}
  });

  it('does not recover copied derived authority from Vault frontmatter',()=>{
    const f=retainedLocalFixture(),root=mkdtempSync(join(tmpdir(),'patrick-g6-vault-'));let writer:Store|undefined,recovered:Store|undefined;
    try{
      f.store.delete('actions',f.observation.id);const original=f.publish();
      const source={...f.source,id:stableId('source',{projectId:f.project.id,domain:f.project.domain},'manual','vault-fixture','r1'),externalId:'vault-fixture'};
      const card={...original,sourceId:source.id};writer=new Store(':memory:',root);writer.save('projects',f.project);writer.save('sources',source);writer.save('cards',card);writer.close();
      const path=join(root,'p','personal','cards',`${encodeURIComponent(card.id)}.md`),text=readFileSync(path,'utf8');
      writeFileSync(path,text.replace(/^patrick_entity: (.+)$/m,(_line,json:string)=>{const value=JSON.parse(json);value.experienceReference={label:'forged'};value.factual={eligible:true};return `patrick_entity: ${JSON.stringify(value)}`;}));
      recovered=new Store(':memory:',root);const loaded=recovered.get('cards',card.id);
      expect(loaded).toBeDefined();expect(loaded).not.toHaveProperty('experienceReference');expect(loaded).not.toHaveProperty('factual');
      const view=recovered.searchCards('cache misses',f.project,20,{usage:'browse'})[0];expect(view).not.toHaveProperty('experienceReference');
      expect(recovered.searchCards('cache misses',f.project)).toEqual([]);
    }finally{writer?.close();recovered?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('does not treat a check command that is only a prefix of the reported command as exact',()=>{
    const f=retainedLocalFixture(false,'.different');try{
      f.publish();expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
      expect(f.store.searchCards('cache misses',f.project,20,{usage:'browse'})[0]?.experienceState).toMatchObject({state:'pending',reason:'missing_relevance_binding'});
    }finally{f.store.close();}
  });

});

describe('G6 relation, normalization and target invariants',()=>{
  it('does not bind the other quoted selector across a comma and anaphoric target',()=>{
    const f=retainedLocalFixture();try{
      const first='npm test -- docs/test.ts',second='npm test -- docs/network.test.ts';
      const quote='Cache misses in docs/test.ts: `npm test -- docs/test.ts`, while request timeouts in the same file require `npm test -- docs/network.test.ts`.';
      replaceLocalRun(f,quote,[first,second],f.observation.checks,[f.file]);
      const card=f.publish('request timeouts',quote);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:false,state:'pending'});
    }finally{f.store.close();}
  });

  it('keeps a single explicit issue eligible when its first selector fails and its second succeeds',()=>{
    const f=retainedLocalFixture();try{
      const first='npm test -- docs/test.ts',second='npm test -- docs/network.test.ts';
      const quote=relations({problem:'cache misses',files:[f.file.path],checks:[first,second]}),prose=`cache misses in docs/test.ts: \`${first}\`, \`${second}\`.`;
      const failed={...f.observation.checks[0]!,result:'failure' as const,process:{...f.observation.checks[0]!.process!,exitCode:1}};
      const succeeded={...f.observation.checks[0]!,id:stableId('local-check',second),command:second,testFile:'docs/network.test.ts'};
      replaceLocalRun(f,`${quote}\n${prose}`,[first,second],[failed,succeeded],[f.file,{...f.file,path:'docs/network.test.ts'}]);
      const card=f.publish('cache misses',quote);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{observed:[{checks:[{command:second,result:'success'}]}],currentApplicability:{status:'needs-revalidation',evidenceIds:[f.observation.id]}}});
      expect(experienceReference(f.store,f.publish('cache misses',prose),f.project)).toMatchObject({eligible:false,state:'pending'});
    }finally{f.store.close();}
  });

  it('keeps the one-success rule for an unquoted comma-separated selector list',()=>{
    const f=retainedLocalFixture();try{
      const first='npm test -- docs/test.ts',second='npm test -- docs/network.test.ts',quote=relations({problem:'cache misses',files:[f.file.path],checks:[first,second]}),prose=`cache misses in docs/test.ts: ${first}, ${second}.`;
      const failed={...f.observation.checks[0]!,result:'failure' as const,process:{...f.observation.checks[0]!.process!,exitCode:1}};
      const succeeded={...f.observation.checks[0]!,id:stableId('local-check',second),command:second,testFile:'docs/network.test.ts'};
      replaceLocalRun(f,`${quote}\n${prose}`,[first,second],[failed,succeeded],[f.file,{...f.file,path:'docs/network.test.ts'}]);
      expect(experienceReference(f.store,f.publish('cache misses',quote),f.project)).toMatchObject({eligible:true,reference:{observed:[{checks:[{command:second}]}]}});
      expect(experienceReference(f.store,f.publish('cache misses',prose),f.project)).toMatchObject({eligible:false,state:'pending'});
    }finally{f.store.close();}
  });

  it.each([', ','; '])('does not treat a prefix of a longer literal command containing %s as a separate selector',separator=>{
    const f=retainedLocalFixture();try{
      const first='npm test -- docs/test.ts',longer=`${first}${separator}verify`,quote=`cache misses in docs/test.ts: \`${longer}\`.`;
      replaceLocalRun(f,quote,[first,longer],f.observation.checks,[f.file]);
      expect(experienceReference(f.store,f.publish('cache misses',quote),f.project)).toMatchObject({eligible:false,state:'pending'});
    }finally{f.store.close();}
  });

  it('isolates complete comma-separated relation units and protects punctuation inside commands',()=>{
    const f=retainedLocalFixture();try{
      const first="npm test -- 'docs/test.ts,verify'",second='npm test -- docs/network.test.ts';
      const quote=relations({problem:'Cache misses',files:[f.file.path],checks:[first]},{problem:'request timeouts',files:[f.file.path],checks:[second]});
      const checks=[{...f.observation.checks[0]!,id:stableId('local-check',first),command:first},{...f.observation.checks[0]!,id:stableId('local-check',second),command:second,testFile:'docs/network.test.ts'}];
      replaceLocalRun(f,quote,[first,second],checks,[f.file,{...f.file,path:'docs/network.test.ts'}]);
      const firstCard=f.publish('Cache misses',quote),secondCard=f.publish('request timeouts',quote);
      expect(experienceReference(f.store,firstCard,f.project)).toMatchObject({eligible:true,reference:{observed:[{checks:[{command:first}]}]}});
      expect(experienceReference(f.store,secondCard,f.project)).toMatchObject({eligible:true,reference:{observed:[{checks:[{command:second}]}]}});
    }finally{f.store.close();}
  });

  it('does not report the other quoted selector as a later failure across a comma',()=>{
    const f=retainedLocalFixture();try{
      const first='npm test -- docs/test.ts',second='npm test -- docs/network.test.ts';
      const quote=relations({problem:'request timeouts',files:[f.file.path],checks:[first]});
      replaceLocalRun(f,quote,[first,second],f.observation.checks,[f.file]);
      const card=f.publish('request timeouts',quote);
      const mixed='Cache misses in docs/test.ts: `npm test -- docs/test.ts`, while request timeouts in the same file require `npm test -- docs/network.test.ts`.';
      const failure=seedAdditional(f,'comma-failure','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40),mixed);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[]}}});
      expect(linkAvailableExperienceEvidence(f.store,failure.observation.id)).toBe(0);
    }finally{f.store.close();}
  });

  it.each(['permanent','ephemeral'] as const)('keeps field origin after edit then withdrawal with %s evidence',retention=>{
    const f=retainedLocalFixture(false,'',':memory:',retention);try{
      const source={...f.source,id:'origin-candidate',externalId:'origin-candidate',retention:'permanent' as const};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',original.id)!,link=f.store.experienceActions('experience.evidence-link',{scope:f.project,cardId:original.id})[0]!;
      f.store.save('cards',{...normalized,title:'Edited title',experience:{...normalized.experience!,solution:'Edited solution'}});
      invalidateSource(f.store,f.source.id,'withdrawn');
      const tombstone=f.store.get('actions',link.id)!.payload;
      expect(tombstone).toMatchObject({retracted:true,normalizationOrigin:{cardId:original.id,reported:'unknown',observedRevision:f.observation.snapshot.revision}});
      for(const secret of [f.quote,f.observation.id,'Clear the cache','Edited solution',f.source.locator])expect(JSON.stringify(tombstone)).not.toContain(secret);
      const next=seedAdditional(f,`after-edited-${retention}`,'success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(f.store,next.observation.id)).toBeGreaterThan(0);
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      expect(experienceReference(f.store,f.store.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[next.observation.id],versionBinding:{reported:'unknown',observedRevision:next.observation.snapshot.revision}}});
    }finally{f.store.close();}
  });

  it('retains only non-authorizing field origin through edit, withdrawal and reopen',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-fix3-origin-')),path=join(root,'store.sqlite'),f=retainedLocalFixture(false,'',path);let reopened:Store|undefined;
    try{
      const source={...f.source,id:'origin-reopen',externalId:'origin-reopen'};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',original.id)!;f.store.save('cards',{...normalized,experience:{...normalized.experience!,solution:'Edited solution'}});
      invalidateSource(f.store,f.source.id,'withdrawn');f.store.close();reopened=new Store(path);
      const next=seedAdditional({...f,store:reopened},'edit-withdraw-reopen','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(reopened,next.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(reopened,reopened.get('cards',original.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[next.observation.id],versionBinding:{reported:'unknown',observedRevision:next.observation.snapshot.revision}}});
    }finally{reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each(['permanent','ephemeral'] as const)("persists descriptor removal and expiry with %s evidence",retention=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-fix3-removed-')),path=join(root,'store.sqlite'),f=retainedLocalFixture(false,'',path,retention);let reopened:Store|undefined,expired:Store|undefined;
    try{
      const source={...f.source,id:'removed-candidate',externalId:'removed-candidate',retention:'permanent' as const};f.store.save('sources',source);
      const original=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const deadline='2026-11-05T12:30:00+00:00',normalized=f.store.get('cards',original.id)!;
      f.store.save('cards',{...normalized,title:'Removed descriptor',body:'Authored body',aliases:['edited alias'],expiresAt:deadline,experience:undefined});
      f.store.close();reopened=new Store(path);
      expect(reopened.get('cards',original.id)).toMatchObject({title:'Removed descriptor',body:'Authored body',aliases:['edited alias'],expiresAt:deadline});
      expect(reopened.get('cards',original.id)?.experience).toBeUndefined();
      const before=seedAdditional({...f,store:reopened},`removed-before-${retention}`,'success','2026-11-05T12:10:00Z');
      expect(linkAvailableExperienceEvidence(reopened,before.observation.id)).toBe(0);
      reopened.close();vi.setSystemTime(new Date('2026-11-05T12:31:00Z'));expired=new Store(path);
      expect(expired.get('cards',original.id)?.expiresAt).toBe(deadline);
      expect(expired.get('cards',original.id)?.experience).toBeUndefined();
      expect(expired.searchCards('edited alias',f.project)).toEqual([]);
      const after=seedAdditional({...f,store:expired},`removed-after-${retention}`,'success','2026-11-05T12:31:00Z');
      expect(linkAvailableExperienceEvidence(expired,after.observation.id)).toBe(0);
    }finally{expired?.close();reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});vi.useRealTimers();}
  });

  it('does not erase a later same-check failure on a different revision when the old revision passes again',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish(),revision='d'.repeat(40),failure=seedAdditional(f,'other-revision','failure','2026-11-04T13:00:00Z',true,revision);
      const oldSuccess=seedAdditional(f,'old-revision-again','success','2026-11-04T14:00:00Z');expect(linkAvailableExperienceEvidence(f.store,oldSuccess.observation.id)).toBeGreaterThan(0);
      const current={projectId:'p',domain:'personal',repository:f.project.repository,revision,environment:{node:'24'},observedAt:'2026-11-04T11:00:00Z'};
      expect(experienceReference(f.store,card,f.project,current)).toMatchObject({eligible:true,reference:{observationIds:expect.arrayContaining([f.observation.id,oldSuccess.observation.id]),currentApplicability:{status:'needs-revalidation',evidenceIds:expect.arrayContaining([failure.observation.id]),reasons:expect.arrayContaining([expect.stringContaining(revision)])}}});
    }finally{f.store.close();}
  });

  it.each(['overlay','file'] as const)('keeps a failure for a different %s despite a later same-check success',difference=>{
    const f=retainedLocalFixture();try{
      const card=f.publish(),seeded=seedAdditional(f,`different-${difference}`,'failure','2026-11-04T13:00:00Z');
      const failure=reviseSeededObservation(f,seeded.observation,o=>{if(difference==='overlay')o.snapshot.overlayHash='a'.repeat(64);else o.snapshot.files[0]!.sha256='d'.repeat(64);});
      const success=seedAdditional(f,`success-${difference}`,'success','2026-11-04T14:00:00Z');expect(linkAvailableExperienceEvidence(f.store,success.observation.id)).toBeGreaterThan(0);
      const view=experienceReference(f.store,card,f.project);
      expect(view).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:expect.arrayContaining([failure.id])}}});
      if(difference==='overlay')expect(JSON.stringify(view)).toContain('a'.repeat(64));
    }finally{f.store.close();}
  });

  it('does not equate incompletely labeled check targets when their other measured files differ',()=>{
    const f=retainedLocalFixture();try{
      const extra={...f.file,path:'docs/extra.test.ts'},check={...f.observation.checks[0]!,testFile:undefined};
      replaceLocalRun(f,f.quote,f.project.trustedChecks,[check],[f.file,extra]);
      const card=f.publish(),seeded=seedAdditional(f,'unlabeled-target','failure','2026-11-04T13:00:00Z');
      const failure=reviseSeededObservation(f,seeded.observation,o=>{o.snapshot.files[1]!.sha256='d'.repeat(64);});
      const later=seedAdditional(f,'unlabeled-other-success','success','2026-11-04T14:00:00Z');expect(linkAvailableExperienceEvidence(f.store,later.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:expect.arrayContaining([failure.id])}}});
    }finally{f.store.close();}
  });

  it('requires equal retained test-definition identities when both same-check observations provide them',()=>{
    const f=retainedLocalFixture();try{
      const command=f.observation.checks[0]!.command!,definitions=[{command,files:[f.file]}],other=[...definitions,{command:'npm run extra-check',files:[f.file]}];
      f.observation={...f.observation,comparable:{snapshotDigest:snapshotDigest(f.observation.snapshot),testDefinitionDigest:testDefinitionDigest(definitions)}};
      replaceLocalRun(f,f.quote,f.project.trustedChecks,f.observation.checks,[f.file]);const card=f.publish();
      const seeded=seedAdditional(f,'other-definition','failure','2026-11-04T13:00:00Z');
      const failure=reviseSeededObservation(f,seeded.observation,o=>{o.comparable!.testDefinitionDigest=testDefinitionDigest(other);});
      const later=seedAdditional(f,'old-definition-success','success','2026-11-04T14:00:00Z');expect(linkAvailableExperienceEvidence(f.store,later.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:expect.arrayContaining([failure.id])}}});
      const repaired=seedAdditional(f,'same-definition-success','success','2026-11-04T15:00:00Z');
      const recovery=reviseSeededObservation(f,repaired.observation,o=>{o.comparable!.testDefinitionDigest=testDefinitionDigest(other);});
      expect(linkAvailableExperienceEvidence(f.store,recovery.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[]}}});
    }finally{f.store.close();}
  });

  it('clears a failure only with a later success on the same tested target and keeps unknown order unknown',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish(),failure=seedAdditional(f,'same-target-failure','failure','2026-11-04T13:00:00Z');
      const later=seedAdditional(f,'same-target-recovery','success','2026-11-04T14:00:00Z');expect(linkAvailableExperienceEvidence(f.store,later.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[]}}});
      expect(failure.observation.snapshot).toEqual(later.observation.snapshot);
      const unknown=seedAdditional(f,'unknown-time','failure','2026-11-04T15:00:00Z');
      const noTime=reviseSeededObservation(f,unknown.observation,o=>{for(const check of o.checks)delete check.process;});
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[noTime.id],reasons:expect.arrayContaining([expect.stringContaining('execution order is unknown')])}}});
    }finally{f.store.close();}
  });

  it('uses a fresh independent success on the failed revision as narrow recovery evidence without rebinding history',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish(),revision='d'.repeat(40),failure=seedAdditional(f,'failed-h2','failure','2026-11-04T13:00:00Z',true,revision);
      const recovery=seedAdditional(f,'recovered-h2','success','2026-11-04T14:00:00Z',true,revision);
      expect(linkAvailableExperienceEvidence(f.store,recovery.observation.id)).toBe(0);
      const current={projectId:'p',domain:'personal',repository:f.project.repository,revision,environment:{node:'24'},observedAt:'2026-11-04T12:30:00Z'};
      const view=experienceReference(f.store,card,f.project,current);
      expect(view).toMatchObject({eligible:true,reference:{observationIds:[f.observation.id],currentApplicability:{evidenceIds:expect.arrayContaining([recovery.observation.id]),reasons:expect.arrayContaining([expect.stringContaining(revision)])}}});
      expect(view.eligible&&view.reference.currentApplicability.evidenceIds).not.toContain(failure.observation.id);
    }finally{f.store.close();}
  });

  it('ends the overlay on source change without persisting its temporary revision',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-fix3-source-')),path=join(root,'store.sqlite'),f=retainedLocalFixture(false,'',path,'ephemeral');let reopened:Store|undefined;
    try{
      const source={...f.source,id:'source-before',externalId:'source-before',retention:'permanent' as const},nextSource={...source,id:'source-after',externalId:'source-after'};
      f.store.save('sources',source);f.store.save('sources',nextSource);
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',card.id)!;expect(normalized.experience?.codeVersion).toBe(f.observation.snapshot.revision);
      f.store.save('cards',{...normalized,sourceId:nextSource.id,sourceRevision:nextSource.revision,locator:nextSource.locator,title:'Changed source'});
      f.store.close();reopened=new Store(path);
      expect(reopened.get('cards',card.id)).toMatchObject({sourceId:nextSource.id,title:'Changed source',experience:{codeVersion:'unknown'}});
      expect(readFileSync(path).includes(Buffer.from(f.observation.snapshot.revision))).toBe(false);
      const next=seedAdditional({...f,store:reopened},'changed-source-new-evidence','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(reopened,next.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(reopened,reopened.get('cards',card.id)!,f.project)).toMatchObject({eligible:true,reference:{versionBinding:{reported:'unknown',observedRevision:next.observation.snapshot.revision}}});
    }finally{reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('does not revive the old durable card after changing an overlaid card to a temporary source',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-fix3-new-temp-source-')),path=join(root,'store.sqlite'),f=retainedLocalFixture(false,'',path,'ephemeral');let reopened:Store|undefined;
    try{
      const source={...f.source,id:'durable-old-source',externalId:'durable-old-source',retention:'permanent' as const};
      const next={...f.source,id:'new-temp-source',externalId:'new-temp-source',content:`${f.quote}\nTEMP_SOURCE_PRIVATE_SENTINEL`,locator:'private:temp-source'};
      f.store.save('sources',source);f.store.save('sources',next);
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',card.id)!;
      f.store.save('cards',{...normalized,sourceId:next.id,sourceRevision:next.revision,locator:next.locator,title:'TEMP_SOURCE_PRIVATE_SENTINEL'});
      expect(f.store.get('cards',card.id)?.sourceId).toBe(next.id);
      f.store.close();reopened=new Store(path);
      expect(reopened.get('cards',card.id)?.status).not.toBe('active');
      expect(reopened.searchCards('cache misses',f.project)).toEqual([]);
      const bytes=readFileSync(path);expect(bytes.includes(Buffer.from('TEMP_SOURCE_PRIVATE_SENTINEL'))).toBe(false);expect(bytes.includes(Buffer.from(f.observation.snapshot.revision))).toBe(false);
    }finally{reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('does not attach the old normalization origin to an explicitly changed version',()=>{
    const f=retainedLocalFixture();try{
      const source={...f.source,id:'changed-version',externalId:'changed-version'};f.store.save('sources',source);
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',card.id)!,revision='d'.repeat(40);
      f.store.save('cards',{...normalized,experience:{...normalized.experience!,codeVersion:revision}});invalidateSource(f.store,f.source.id,'withdrawn');
      const next=seedAdditional(f,'changed-version-fresh','success','2026-11-04T13:00:00Z',true,revision);
      linkAvailableExperienceEvidence(f.store,next.observation.id);
      const result=experienceReference(f.store,f.store.get('cards',card.id)!,f.project);
      if(result.eligible)expect(result.reference.versionBinding?.observedRevision).not.toBe(f.observation.snapshot.revision);
      else expect(['pending','invalidated']).toContain(result.state);
    }finally{f.store.close();}
  });

  it('keeps removal and withdrawal durable when both follow an ephemeral normalization',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-fix3-remove-withdraw-')),path=join(root,'store.sqlite'),f=retainedLocalFixture(false,'',path,'ephemeral');let reopened:Store|undefined;
    try{
      const source={...f.source,id:'remove-withdraw',externalId:'remove-withdraw',retention:'permanent' as const};f.store.save('sources',source);
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      f.store.save('cards',{...f.store.get('cards',card.id)!,experience:undefined,expiresAt:'2027-01-01T00:00:00Z'});
      f.store.save('cards',{...f.store.get('cards',card.id)!,status:'withdrawn'});f.store.close();reopened=new Store(path);
      expect(reopened.get('cards',card.id)).toMatchObject({status:'withdrawn',expiresAt:'2027-01-01T00:00:00Z'});
      expect(reopened.get('cards',card.id)?.experience).toBeUndefined();
      const next=seedAdditional({...f,store:reopened},'withdraw-after-removal','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(reopened,next.observation.id)).toBe(0);
    }finally{reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });

  it('invalidates the temporary association when a removed descriptor is restored',()=>{
    const f=retainedLocalFixture(false,'',':memory:','ephemeral');try{
      const source={...f.source,id:'remove-restore',externalId:'remove-restore',retention:'permanent' as const};f.store.save('sources',source);
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',card.id)!;f.store.save('cards',{...normalized,experience:undefined});
      f.store.save('cards',{...f.store.get('cards',card.id)!,experience:{...normalized.experience!,codeVersion:'unknown'}});
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      expect(f.store.get('cards',card.id)?.experience?.codeVersion).toBe('unknown');
      expect(experienceReference(f.store,f.store.get('cards',card.id)!,f.project)).toMatchObject({eligible:false});
      const fresh=seedAdditional(f,'restore-new-observation','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(f.store,fresh.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,f.store.get('cards',card.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[fresh.observation.id],versionBinding:{reported:'unknown'}}});
    }finally{f.store.close();}
  });

  it('does not recover a discarded overlay origin when its old source is withdrawn after a fresh binding',()=>{
    const f=retainedLocalFixture(false,'',':memory:','ephemeral');try{
      const source={...f.source,id:'discarded-origin',externalId:'discarded-origin',retention:'permanent' as const};f.store.save('sources',source);
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',card.id)!,old=f.store.experienceActions('experience.evidence-link',{scope:f.project,cardId:card.id})[0]!;
      f.store.save('cards',{...normalized,experience:undefined});
      f.store.save('cards',{...f.store.get('cards',card.id)!,experience:{...normalized.experience!,codeVersion:'unknown'}});
      const fresh=seedAdditional(f,'after-origin-discard','success','2026-11-04T13:00:00Z');expect(linkAvailableExperienceEvidence(f.store,fresh.observation.id)).toBeGreaterThan(0);
      invalidateSource(f.store,f.source.id,'withdrawn');
      expect(f.store.get('actions',old.id)?.payload).not.toHaveProperty('normalizationOrigin');
      expect(experienceReference(f.store,f.store.get('cards',card.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[fresh.observation.id],versionBinding:{reported:'unknown'}}});
    }finally{f.store.close();}
  });

  it('does not restore a withdrawn temporary association when the owner later reactivates the card',()=>{
    const f=retainedLocalFixture(false,'',':memory:','ephemeral');try{
      const source={...f.source,id:'revoked-overlay',externalId:'revoked-overlay',retention:'permanent' as const};f.store.save('sources',source);
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',card.id)!;f.store.save('cards',{...normalized,status:'withdrawn'});
      expect(experienceReference(f.store,f.store.get('cards',card.id)!,f.project)).toMatchObject({eligible:false});
      f.store.save('cards',{...f.store.get('cards',card.id)!,status:'active',experience:{...normalized.experience!,codeVersion:'unknown'}});
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      const fresh=seedAdditional(f,'after-card-reactivation','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(f.store,fresh.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,f.store.get('cards',card.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[fresh.observation.id],versionBinding:{reported:'unknown'}}});
    }finally{f.store.close();}
  });
});

describe('fix5 selector prefix ownership',()=>{
  it('suppresses a durable experience candidate using its SQLite ID when a temporary card shadows it',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-card-shadow-')),path=join(root,'store.sqlite'),f=retainedLocalFixture(false,'',path);let raw:Database.Database|undefined;
    try{
      const card=f.publish(),source={...f.source,id:'temporary-shadow-source',externalId:'temporary-shadow-source',retention:'ephemeral' as const};f.store.save('sources',source);
      f.store.save('cards',{...card,id:'shadow-card',sourceId:source.id,kind:'fact',experience:undefined});
      const durable={...card,id:'forged-json-id'};raw=new Database(path);
      raw.prepare('INSERT INTO cards(id,project_id,domain,data) VALUES(?,?,?,?)').run('shadow-card',card.projectId,card.domain,JSON.stringify(durable));
      expect(f.store.experienceCandidates(f.observation).some(value=>value.id==='forged-json-id')).toBe(false);
    }finally{raw?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });
  it('discovers a newly committed later failure in the next batch after an earlier miss',()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-later-external-')),path=join(root,'store.sqlite'),f=retainedLocalFixture(false,'',path);let raw:Database.Database|undefined;
    try{
      const card=f.publish(),failure=seedAdditional(f,'external-failure','failure','2026-11-04T13:00:00Z'),row=f.store.get('actions',failure.observation.id)!;
      f.store.delete('actions',row.id);expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[]}}});
      raw=new Database(path);raw.prepare('INSERT INTO actions(id,project_id,domain,data) VALUES(?,?,?,?)').run(row.id,row.projectId,row.domain,JSON.stringify(row));
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:[row.id]}}});
    }finally{raw?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });
  it('requires the complete declared block as quote prefix and leaves missing or partial quotes pending',()=>{
    const f=retainedLocalFixture();try{
      const command='npm test -- docs/test.ts',block=relations({problem:'cache misses',files:[f.file.path],checks:[command]});
      const suffix='A separate report says cache misses.';replaceLocalRun(f,`${block}\n${suffix}`,[command],f.observation.checks,[f.file]);
      expect(experienceReference(f.store,f.publish('cache misses',block),f.project).eligible).toBe(true);
      for(const quote of [block.slice(0,-1),suffix])expect(experienceReference(f.store,f.publish('cache misses',quote),f.project)).toMatchObject({eligible:false,state:'pending',reason:'missing_relevance_binding'});
      const malformed=block.replace('"problem":','"extra":1,"problem":');replaceLocalRun(f,malformed,[command],f.observation.checks,[f.file]);
      expect(experienceReference(f.store,f.publish('cache misses',malformed),f.project)).toMatchObject({eligible:false,state:'pending',reason:'missing_relevance_binding'});
    }finally{f.store.close();}
  });
  it('attributes a later failure and same-target recovery from a small declaration with a long ignored suffix',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish(),suffix=`\n${'x'.repeat(12000)}\nUnrelated problem and selector npm run lint.`;
      const failure=seedAdditional(f,'long-suffix-failure','failure','2026-11-04T13:00:00Z',true,undefined,`${f.quote}${suffix}`);
      const failed=experienceReference(f.store,card,f.project);
      expect(failed).toMatchObject({eligible:true,reference:{currentApplicability:{status:'needs-revalidation',evidenceIds:[failure.observation.id]}}});
      const recovery=seedAdditional(f,'long-suffix-recovery','success','2026-11-04T14:00:00Z',true,undefined,`${f.quote}${suffix}`);
      const recovered=experienceReference(f.store,card,f.project);
      expect(recovered).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[recovery.observation.id]}}});
      if(recovered.eligible)expect(recovered.reference.currentApplicability.reasons.join(' ')).not.toContain('npm run lint');
    }finally{f.store.close();}
  });
  it('never promotes an old accepted run after its task source is edited to add a declaration',()=>{
    const f=retainedLocalFixture();try{
      const original=f.source.content;f.source.content='legacy prose';f.store.save('sources',f.source);
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
      f.source.content=`${original}\nchanged after acceptance`;f.store.save('sources',f.source);
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      expect(f.store.searchCards('cache misses',f.project)).toEqual([]);
    }finally{f.store.close();}
  });
  it('binds only the matching declared record and never borrows a slot from a literal or suffix',()=>{
    const f=retainedLocalFixture();try{
      const first='npm test -- docs/test.ts',second='npm test -- docs/network.test.ts';
      const record={problem:'Cache misses',files:['docs/test.ts'],checks:[first]};
      const other={problem:'request timeouts',files:['docs/test.ts'],checks:[second]};
      const block=relations(record,other),source=`${block}\nCache misses in docs/other.ts: ${second}`;
      const checks=[f.observation.checks[0]!,{...f.observation.checks[0]!,id:stableId('local-check',second),command:second}];
      replaceLocalRun(f,source,[first,second],checks,[f.file]);
      const cache=f.publish('Cache misses',block),timeout=f.publish('request timeouts',block);
      expect(experienceReference(f.store,cache,f.project)).toMatchObject({eligible:true,reference:{observed:[{checks:[{command:first}],relevance:{quote:block}}]}});
      expect(experienceReference(f.store,timeout,f.project)).toMatchObject({eligible:true,reference:{observed:[{checks:[{command:second}],relevance:{quote:block}}]}});
      expect(experienceReference(f.store,f.publish('docs/other.ts',block),f.project)).toMatchObject({eligible:false,state:'pending'});
      const duplicate=relations(record,record);replaceLocalRun(f,duplicate,[first],f.observation.checks.slice(0,1),[f.file]);
      expect(experienceReference(f.store,f.publish('Cache misses',duplicate),f.project)).toMatchObject({eligible:false,state:'pending'});
    }finally{f.store.close();}
  });
  it('does not borrow a candidate problem or file that appears only inside a declared command',()=>{
    const f=retainedLocalFixture();try{
      const command='npm test -- docs/test.ts -- Cache misses docs/other.ts',block=relations({problem:'unrelated',files:['docs/test.ts'],checks:[command]});
      const other={...f.file,path:'docs/other.ts'},checks=[{...f.observation.checks[0]!,id:stableId('local-check',command),command}];
      replaceLocalRun(f,block,[command],checks,[f.file,other]);
      expect(experienceReference(f.store,f.publish('Cache misses',block),f.project)).toMatchObject({eligible:false,state:'pending'});
      const card=publishKnowledge(f.store,f.source,{cards:[{title:'unrelated',body:'unrelated',quote:block,aliases:['unrelated'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'unrelated',symptomAliases:['unrelated'],solution:'Review the configuration',files:[other.path],productId:f.project.id,codeVersion:f.observation.snapshot.revision,environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:false,state:'pending'});
    }finally{f.store.close();}
  });
  it('keeps the v6 shared-prefix witness out of both cards and reference use',()=>{
    const f=retainedLocalFixture();try{
      const command='npm test -- docs/test.ts';
      const quote='Cache misses in docs/test.ts remain unresolved while request timeouts in the same file require `npm test -- docs/test.ts`.';
      replaceLocalRun(f,quote,[command],f.observation.checks,[f.file]);
      for(const problem of ['Cache misses','request timeouts']){
        const card=f.publish(problem,quote);
        expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:false,state:'pending',reason:'missing_relevance_binding'});
        expect(f.store.searchCards(problem,f.project).some(value=>value.id===card.id)).toBe(false);
        expect(f.store.searchCards(problem,f.project,20,{usage:'browse'}).find(value=>value.id===card.id)).toMatchObject({experienceState:{state:'pending',reason:'missing_relevance_binding'}});
      }
    }finally{f.store.close();}
  });
  it('does not revalidate an old v6 shared-prefix link or attribute that witness as a later failure',()=>{
    const f=retainedLocalFixture(),laterFixture=retainedLocalFixture();try{
      const command='npm test -- docs/test.ts',quote='Cache misses in docs/test.ts remain unresolved while request timeouts in the same file require `npm test -- docs/test.ts`.';
      const first=f.publish(),old=f.store.experienceActions('experience.evidence-link',{scope:f.project,cardId:first.id})[0]!;
      for(const link of f.store.experienceActions('experience.evidence-link',{scope:f.project}))f.store.delete('actions',link.id);
      replaceLocalRun(f,quote,[command],f.observation.checks,[f.file]);const card=f.publish('Cache misses',quote);
      const association={...(old.payload.association as any),cardId:card.id,candidateHash:knowledgeCandidateHash(card),relevance:{...(old.payload.association as any).relevance,quote}};
      f.store.save('actions',{...old,id:stableId('experience-evidence-link',association),payload:{...old.payload,association,digest:digest(association)}});
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:false,state:'pending',reason:'missing_relevance_binding'});
      expect(f.store.searchCards('Cache misses',f.project).some(value=>value.id===card.id)).toBe(false);
      const supported=laterFixture.publish(),failure=seedAdditional(laterFixture,'v6-later','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40),quote);
      expect(experienceReference(laterFixture.store,supported,laterFixture.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[]}}});
      expect(linkAvailableExperienceEvidence(laterFixture.store,failure.observation.id)).toBe(0);
    }finally{f.store.close();laterFixture.store.close();}
  });
  it('keeps the exact single-selector tail witness out of history and use',()=>{
    const f=retainedLocalFixture();try{
      const command='npm test -- docs/test.ts';
      const quote='Cache misses in docs/test.ts: `npm test -- docs/test.ts` while request timeouts happen in the same file.';
      const block=relations({problem:'Cache misses',files:[f.file.path],checks:[command]});
      replaceLocalRun(f,`${block}\n${quote}`,[command],f.observation.checks,[f.file]);
      const cache=f.publish('Cache misses',block),rawCache=f.publish('Cache misses',quote),timeout=f.publish('request timeouts',quote);
      expect(experienceReference(f.store,cache,f.project)).toMatchObject({eligible:true,reference:{observed:[{checks:[{command}]}]}});
      expect(experienceReference(f.store,rawCache,f.project)).toMatchObject({eligible:false,state:'pending'});
      expect(experienceReference(f.store,timeout,f.project)).toMatchObject({eligible:false,state:'pending',reason:'missing_relevance_binding'});
      expect(f.store.searchCards('request timeouts',f.project).some(card=>card.id===timeout.id)).toBe(false);
      expect(f.store.searchCards('request timeouts',f.project,20,{usage:'browse'}).find(card=>card.id===timeout.id)).toMatchObject({experienceState:{state:'pending',reason:'missing_relevance_binding'}});
    }finally{f.store.close();}
  });

  it('does not revalidate an older completed link that used the trailing witness',()=>{
    const f=retainedLocalFixture();try{
      const command='npm test -- docs/test.ts',quote='Cache misses in docs/test.ts: `npm test -- docs/test.ts` while request timeouts happen in the same file.';
      const block=relations({problem:'Cache misses',files:[f.file.path],checks:[command]});
      replaceLocalRun(f,`${block}\n${quote}`,[command],f.observation.checks,[f.file]);
      const cache=f.publish('Cache misses',block),timeout=f.publish('request timeouts',quote);
      const link=f.store.experienceActions('experience.evidence-link',{scope:f.project,cardId:cache.id})[0]!;
      for(const existing of f.store.experienceActions('experience.evidence-link',{scope:f.project,cardId:timeout.id}))f.store.delete('actions',existing.id);
      const association={...(link.payload.association as any),cardId:timeout.id,candidateHash:knowledgeCandidateHash(timeout),relevance:{...(link.payload.association as any).relevance,quote}};
      f.store.save('actions',{...link,id:stableId('experience-evidence-link',association),payload:{...link.payload,association,digest:digest(association)}});
      expect(experienceReference(f.store,timeout,f.project)).toMatchObject({eligible:false,state:'pending',reason:'missing_relevance_binding'});
    }finally{f.store.close();}
  });

  it('does not use a later unrelated selector as a failure for an earlier timeout history',()=>{
    const f=retainedLocalFixture();try{
      const command='npm test -- docs/test.ts',initial=relations({problem:'request timeouts',files:[f.file.path],checks:['npm test -- docs/test.ts']});
      replaceLocalRun(f,initial,[command],f.observation.checks,[f.file]);
      const card=f.publish('request timeouts',initial);
      const mixed='Cache misses in docs/test.ts: `npm test -- docs/test.ts` while request timeouts happen in the same file.';
      const later=seedAdditional(f,'fix5-tail-failure','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40),mixed);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[]}}});
      expect(linkAvailableExperienceEvidence(f.store,later.observation.id)).toBe(0);
    }finally{f.store.close();}
  });

  it('requires the candidate problem and file outside the selector literal',()=>{
    const f=retainedLocalFixture();try{
      const command='npm test -- docs/test.ts',quote='Cache misses: `npm test -- docs/test.ts`.';
      replaceLocalRun(f,quote,[command],f.observation.checks,[f.file]);
      expect(experienceReference(f.store,f.publish('docs/test.ts',quote),f.project)).toMatchObject({eligible:false,state:'pending'});
    }finally{f.store.close();}
  });

  it.each([
    ['request timeouts in docs/test.ts: `npm test -- docs/test.ts` while cache misses remain.',false],
    ['Cache misses in docs/test.ts: `npm test -- docs/test.ts` while request timeouts in docs/test.ts remain.',false],
  ] as const)('uses the explicit prefix and selector order in %s',(quote,expected)=>{
    const f=retainedLocalFixture();try{
      replaceLocalRun(f,quote,['npm test -- docs/test.ts'],f.observation.checks,[f.file]);
      expect(experienceReference(f.store,f.publish('request timeouts',quote),f.project).eligible).toBe(expected);
      const declared=relations({problem:'request timeouts',files:[f.file.path],checks:['npm test -- docs/test.ts']});
      replaceLocalRun(f,declared,['npm test -- docs/test.ts'],f.observation.checks,[f.file]);
      expect(experienceReference(f.store,f.publish('request timeouts',declared),f.project).eligible).toBe(true);
    }finally{f.store.close();}
  });
});

describe('fix4 candidate-local relations',()=>{
  it.each([
    'Cache misses in docs/test.ts: `npm test -- docs/test.ts` while request timeouts in the same file require `npm test -- docs/network.test.ts`.',
    'request timeouts in the same file require `npm test -- docs/network.test.ts` while Cache misses in docs/test.ts: `npm test -- docs/test.ts`.',
  ])('does not borrow a target and successful selector across free prose: %s',quote=>{
    const f=retainedLocalFixture();try{
      const first='npm test -- docs/test.ts',second='npm test -- docs/network.test.ts';
      replaceLocalRun(f,quote,[first,second],f.observation.checks,[f.file]);
      expect(experienceReference(f.store,f.publish('request timeouts',quote),f.project)).toMatchObject({eligible:false,state:'pending'});
    }finally{f.store.close();}
  });

  it('binds independently complete prose-separated relations to their own checks',()=>{
    const f=retainedLocalFixture();try{
      const first='npm test -- docs/test.ts',second='npm test -- docs/network.test.ts';
      const prose=`Cache misses in docs/test.ts: \`${first}\` while request timeouts in docs/test.ts require \`${second}\`.`;
      const quote=relations({problem:'Cache misses',files:[f.file.path],checks:[first]},{problem:'request timeouts',files:[f.file.path],checks:[second]});
      const checks=[f.observation.checks[0]!,{...f.observation.checks[0]!,id:stableId('local-check',second),command:second,testFile:'docs/network.test.ts'}];
      replaceLocalRun(f,`${quote}\n${prose}`,[first,second],checks,[f.file,{...f.file,path:'docs/network.test.ts'}]);
      for(const [problem,command] of [['Cache misses',first],['request timeouts',second]]){
        expect(experienceReference(f.store,f.publish(problem,quote),f.project)).toMatchObject({eligible:true,reference:{observed:[{checks:[{command}]}]}});
        expect(experienceReference(f.store,f.publish(problem,prose),f.project)).toMatchObject({eligible:false,state:'pending'});
      }
    }finally{f.store.close();}
  });

  it('does not assign a later failure from the other prose-separated relation',()=>{
    const f=retainedLocalFixture();try{
      const first='npm test -- docs/test.ts',second='npm test -- docs/network.test.ts',quote=relations({problem:'request timeouts',files:[f.file.path],checks:[first]});
      replaceLocalRun(f,quote,[first,second],f.observation.checks,[f.file]);
      const card=f.publish('request timeouts',quote);
      const mixed='Cache misses in docs/test.ts: `npm test -- docs/test.ts` while request timeouts in the same file require `npm test -- docs/network.test.ts`.';
      const later=seedAdditional(f,'fix4-prose-later','failure','2026-11-04T13:00:00Z',true,'d'.repeat(40),mixed);
      expect(experienceReference(f.store,card,f.project)).toMatchObject({eligible:true,reference:{currentApplicability:{status:'unknown',evidenceIds:[]}}});
      expect(linkAvailableExperienceEvidence(f.store,later.observation.id)).toBe(0);
    }finally{f.store.close();}
  });
});

describe('fix4 card withdrawal authority',()=>{
  it.each(['permanent','ephemeral'] as const)('does not revive %s A after explicit withdrawal, reactivation, reopen and fresh B',retention=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g6-fix4-withdraw-')),path=join(root,'store.sqlite');
    const f=retainedLocalFixture(false,'',path,retention);let reopened:Store|undefined;
    try{
      const source={...f.source,id:'fix4-independent-card',externalId:'fix4-independent-card',retention:'permanent' as const};f.store.save('sources',source);
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',card.id)!,old=f.store.experienceActions('experience.evidence-link',{scope:f.project,cardId:card.id})[0]!;
      expect(experienceReference(f.store,normalized,f.project)).toMatchObject({eligible:true,reference:{observationIds:[f.observation.id]}});
      f.store.save('cards',{...normalized,status:'withdrawn'});
      f.store.save('cards',{...f.store.get('cards',card.id)!,status:'active',experience:{...normalized.experience!,codeVersion:'unknown'}});
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      expect(f.store.get('actions',old.id)?.status).not.toBe('completed');
      expect(experienceReference(f.store,f.store.get('cards',card.id)!,f.project)).toMatchObject({eligible:false});
      f.store.close();reopened=new Store(path);
      expect(linkAvailableExperienceEvidence(reopened,f.observation.id)).toBe(0);
      expect(experienceReference(reopened,reopened.get('cards',card.id)!,f.project)).toMatchObject({eligible:false});
      const fresh=seedAdditional({...f,store:reopened},'fix4-new-b','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(reopened,fresh.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(reopened,reopened.get('cards',card.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[fresh.observation.id]}});
      expect(linkAvailableExperienceEvidence(reopened,f.observation.id)).toBe(0);
    }finally{reopened?.close();f.store.close();rmSync(root,{recursive:true,force:true});}
  });
});

describe('fix4 withdrawal lifecycle boundaries',()=>{
  it('keeps sanitized origin metadata without blocking a fresh observation after card reactivation',()=>{
    const f=retainedLocalFixture();try{
      const source={...f.source,id:'fix4-origin-card',externalId:'fix4-origin-card'};f.store.save('sources',source);
      const card=publishKnowledge(f.store,source,{cards:[{title:'cache misses',body:'cache misses',quote:f.quote,aliases:['cache'],verification:'reported',kind:'experience',experience:{schemaVersion:1,problem:'cache misses',symptomAliases:['cache'],solution:'Clear the cache',files:[f.file.path],productId:f.project.id,codeVersion:'unknown',environment:'unknown',invalidationConditions:['changes']}}]})[0]!;
      const normalized=f.store.get('cards',card.id)!,old=f.store.experienceActions('experience.evidence-link',{scope:f.project,cardId:card.id})[0]!;
      invalidateSource(f.store,f.source.id,'withdrawn');
      expect(f.store.get('actions',old.id)?.payload).toHaveProperty('normalizationOrigin');
      f.store.save('cards',{...normalized,status:'withdrawn'});
      f.store.save('cards',{...f.store.get('cards',card.id)!,status:'active',experience:{...normalized.experience!,codeVersion:'unknown'}});
      const fresh=seedAdditional(f,'fix4-after-sanitized-origin','success','2026-11-04T13:00:00Z');
      expect(linkAvailableExperienceEvidence(f.store,fresh.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,f.store.get('cards',card.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[fresh.observation.id]}});
      expect(f.store.get('actions',old.id)?.payload).toHaveProperty('normalizationOrigin');
      expect(f.store.get('actions',old.id)?.status).not.toBe('completed');
    }finally{f.store.close();}
  });

  it('rolls back card withdrawal and association retirement together',()=>{
    const f=retainedLocalFixture();try{
      const card=f.publish(),old=f.store.experienceActions('experience.evidence-link',{scope:f.project,cardId:card.id})[0]!;
      expect(()=>f.store.transaction(()=>{
        f.store.save('cards',{...card,status:'withdrawn'});
        expect(f.store.get('actions',old.id)?.status).not.toBe('completed');
        throw new Error('rollback withdrawal');
      })).toThrow('rollback withdrawal');
      expect(f.store.get('actions',old.id)?.status).toBe('completed');
      expect(experienceReference(f.store,f.store.get('cards',card.id)!,f.project)).toMatchObject({eligible:true});
    }finally{f.store.close();}
  });

  it.each(['descriptor','version'] as const)('requires fresh evidence after withdrawal and a changed %s',change=>{
    const f=retainedLocalFixture();try{
      const card=f.publish('cache misses',f.quote,'unknown'),normalized=f.store.get('cards',card.id)!;
      f.store.save('cards',{...normalized,status:'withdrawn'});
      const revision=change==='version'?'d'.repeat(40):'unknown';
      f.store.save('cards',{...f.store.get('cards',card.id)!,status:'active',experience:{...normalized.experience!,codeVersion:revision,...(change==='descriptor'?{solution:'A changed solution'}:{})}});
      expect(linkAvailableExperienceEvidence(f.store,f.observation.id)).toBe(0);
      expect(experienceReference(f.store,f.store.get('cards',card.id)!,f.project)).toMatchObject({eligible:false});
      const fresh=seedAdditional(f,`fix4-changed-${change}`,'success','2026-11-04T13:00:00Z',true,change==='version'?revision:f.observation.snapshot.revision);
      expect(linkAvailableExperienceEvidence(f.store,fresh.observation.id)).toBeGreaterThan(0);
      expect(experienceReference(f.store,f.store.get('cards',card.id)!,f.project)).toMatchObject({eligible:true,reference:{observationIds:[fresh.observation.id]}});
    }finally{f.store.close();}
  });
});

describe('fix4 unquoted selector boundaries',()=>{
  it('does not borrow a later passing selector across prose after an unquoted command',()=>{
    const f=retainedLocalFixture();try{
      const first='npm run cache-check',second='npm test -- docs/network.test.ts';
      const quote=`Cache misses in docs/test.ts: ${first} while request timeouts in the same file require \`${second}\`.`;
      const passed={...f.observation.checks[0]!,id:stableId('local-check',second),command:second,testFile:'docs/network.test.ts'};
      replaceLocalRun(f,quote,[first,second],[passed],[f.file,{...f.file,path:'docs/network.test.ts'}]);
      expect(experienceReference(f.store,f.publish('Cache misses',quote),f.project)).toMatchObject({eligible:false,state:'pending'});
    }finally{f.store.close();}
  });

  it('does not turn a longer unquoted command prefix into an exact selector when separating relations',()=>{
    const f=retainedLocalFixture();try{
      const first='npm run cache-check',second='npm test -- docs/network.test.ts';
      const quote=`cache misses in docs/test.ts: ${first} --mode=stress while request timeouts in docs/test.ts require \`${second}\`.`;
      const cache={...f.observation.checks[0]!,id:stableId('local-check',first),command:first};
      replaceLocalRun(f,quote,[first,second],[cache],[f.file]);
      expect(experienceReference(f.store,f.publish('cache misses',quote),f.project)).toMatchObject({eligible:false,state:'pending'});
    }finally{f.store.close();}
  });
});
