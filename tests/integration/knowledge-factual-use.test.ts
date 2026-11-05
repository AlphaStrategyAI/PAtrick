import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/app.js';
import { prepareFactualContext, Workbench } from '../../src/orchestrator.js';
import { invalidateSource } from '../../src/intake.js';
import { Store } from '../../src/store.js';
import { factualEligibility, knowledgeReference } from '../../src/knowledge-use.js';
import { ingestStructuredKnowledge } from '../../src/knowledge.js';
import { structuredClaimBody } from '../../src/knowledge-contract.js';
import { repositoryKnowledgeFixture, H, time } from '../fixtures/repository-knowledge.js';
import { digest, roles, stableId, type AppConfig, type Project, type Task, type WorkerAdapter, type WorkerInput } from '../../src/domain.js';

const project: Project = { id:'p', projectId:'p', domain:'personal', name:'P', description:'', repository:'owner/repo', repositoryProvider:'github', prdPath:'docs/PRD.md', allowedPaths:['docs/'], trustedChecks:['validate'], trustedAppIds:[15368], ownerId:'owner', autoMerge:false, budgetUsd:10, createdAt:'' };

describe('actual decision factual use', () => {
  it('proceeds on the current task requirement with no reader and freezes its labeled grounds', async () => {
    const store = new Store(':memory:');
    const seen: WorkerInput[] = [];
    const config: AppConfig = { mode:'test', host:'127.0.0.1', port:0, dataDir:'.', vaultDir:'.', ownerId:'owner', authToken:'test', sessionSecret:'test', projects:[project], workers:{}, scanIntervalMs:1000, runnerPolicies:[{ runner:'grok', roles:[...roles], domains:['personal'], provider:'fixture', model:'fixture', admitted:true, costPerRunUsd:.01, independentReview:false }] };
    const worker: WorkerAdapter = { name:'grok', async run(input) {
      seen.push(structuredClone(input));
      const citation={ sourceId:input.source.id, revision:input.source.revision, quote:'retain this draft until the next successful export', locator:input.source.locator };
      const output=input.role==='knowledge_extract'?{ cards:[] }:input.role==='case_extract'?{ observations:[] }:{ action:'proceed', summary:'Update the requirement', rationale:'A proposed approach', citations:[citation], ruleIds:[], grounds:{ statements:[{ citation, purpose:'requirement', binding:'task-request' }], facts:[], unresolved:[] } };
      return { output, costUsd:.01, provider:'fixture', model:'fixture' };
    } };
    const engine = new Workbench({ store, config, workers:[worker], writer:{ async baseline(){ return 'baseline'; }, async deliver(){ throw new Error('not used'); } }, research:{ async research(){ throw new Error('not used'); } } });
    try {
      const task=engine.ingest({ projectId:'p', externalId:'task', title:'Draft', content:'Please retain this draft until the next successful export.' })!;
      for(let i=0;i<12 && store.get('tasks',task.id)?.stage!=='plan';i++) await engine.tick();
      const decided=store.get('tasks',task.id)!;
      expect(decided.stage,JSON.stringify(decided)).toBe('plan');
      const input=seen.find(value=>value.role==='decide')!;
      expect(input.facts).toEqual([]); expect(input.factualContext).toBeUndefined();
      const snapshot=store.get('actions',decided.decisionSnapshotId!)!.payload.snapshot as any;
      expect(snapshot.decision.grounds.statements[0]).toMatchObject({ purpose:'requirement', binding:'task-request' });
      expect(snapshot.factualUse).toMatchObject({ facts:[], interpretationLabel:'assistant-inference' });
    } finally { await engine.shutdown(); store.close(); }
  });
  it.each(['historical','current'] as const)('commits actual %s check facts from the frozen host input', async temporal=>{
    const f=repositoryKnowledgeFixture('gitlab');
    f.project.budgetUsd=10;f.store.save('projects',f.project);f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:'.',vaultDir:'.',ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[f.project],workers:{},scanIntervalMs:1000,runnerPolicies:[{runner:'grok',roles:[...roles],domains:['personal'],provider:'fixture',model:'fixture',admitted:true,costPerRunUsd:.01,independentReview:false}]};
    let seen:WorkerInput|undefined;
    const worker:WorkerAdapter={name:'grok',async run(input){seen=structuredClone(input);const fact=input.facts.find(fact=>fact.claim.kind==='ci-result'&&fact.temporal===temporal)!;const citation={sourceId:input.source.id,revision:input.source.revision,quote:'Requested check',locator:input.source.locator};return {output:{action:'proceed',summary:'Consider the check',rationale:'Revenue and draft safety remain an assistant interpretation.',citations:[citation],ruleIds:[],grounds:{statements:[],facts:[fact.ref],unresolved:[]}},costUsd:.01,provider:'fixture',model:'fixture'};}};
    const engine=new Workbench({store:f.store,config,workers:[worker],repositoryKnowledgeReader:f.reader,writer:{async baseline(){return 'baseline';},async deliver(){throw Error('not used');}},research:{async research(){throw Error('not used');}}});
    try{
      expect(await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal)).toBe('processed');
      const task:Task={id:'fact-task',projectId:f.project.id,domain:f.project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Requested check',description:'Requested check',status:'deciding',version:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',runAfter:'2026-01-01T00:00:00.000Z',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};
      f.store.save('tasks',task);await engine.tick();
      const updated=f.store.get('tasks',task.id)!;expect(updated.stage,JSON.stringify(updated)).toBe('plan');
      const snapshot=f.store.get('actions',updated.decisionSnapshotId!)!.payload.snapshot as any;
      expect(snapshot.factualUse).toMatchObject({interpretationLabel:'assistant-inference',facts:[{temporal,claim:{kind:'ci-result',subject:{headSha:H,runId:'52',jobId:'71'},value:{conclusion:'success'}},eventAt:[time]}]});
      expect(snapshot.factualUse.facts[0].text).not.toContain('Revenue');
      expect(snapshot.factualUse.facts[0].observedAt[0]).toBeTruthy();
      expect(seen?.factualContext?.observedAt).toBeTruthy();
    }finally{await engine.shutdown();f.close();}
  });
  it('G7-FIX1 freezes fresh repeated-read time through decision, render, context removal and supersession backup',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const dir=mkdtempSync(join(tmpdir(),'patrick-g7-fresh-')),db=join(dir,'db'),store=new Store(db);
    const template=repositoryKnowledgeFixture('gitlab'),p=structuredClone(template.project);template.close();p.budgetUsd=10;
    const f=repositoryKnowledgeFixture('gitlab',{store,project:p});f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
    const parent={...f.source,id:'permanent-parent',externalId:'permanent-parent',content:'Permanent ancestor',revision:'parent-r1'};store.save('sources',parent);
    f.source.parentSources=[{id:parent.id,revision:parent.revision}];store.save('sources',f.source);
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:dir,vaultDir:dir,ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[p],workers:{},scanIntervalMs:1000,runnerPolicies:[{runner:'grok',roles:[...roles],domains:['personal'],provider:'fixture',model:'fixture',admitted:true,costPerRunUsd:.01,independentReview:false}]};
    const research={queries:(['zh','en'] as const).map(language=>({language,query:'checks',searchedAt:'2026-01-01T00:00:00Z',sources:[{language,url:`https://${language}.example.test/source`,canonicalUrl:`https://${language}.example.test/source`,title:'Source',publishedAt:'2026-01-01',accessedAt:'2026-01-01',excerpt:'Tradeoff',primary:true,conditions:'checks'}]})),summary:'Tradeoffs',gaps:[]};
    const option=(label:string)=>({label,description:label,rationale:'proposed reasoning',tradeoff:'predicted cost',evidenceUrls:research.queries.flatMap(q=>q.sources.map(s=>s.url))});
    const seen:WorkerInput[]=[];
    const worker:WorkerAdapter={name:'grok',async run(input){
      seen.push(structuredClone(input));const fact=input.facts.find(value=>value.claim.kind==='ci-result'&&value.temporal==='current')!;
      const citation={sourceId:input.source.id,revision:input.source.revision,quote:'Requested check',locator:input.source.locator};
      return {output:{action:'ask',summary:'Review check',rationale:'Proposed analysis',expectedOutcome:'Predicted result',citations:[citation],ruleIds:[],grounds:{statements:[],facts:[fact.ref],unresolved:[]},question:{title:'Which option?',context:'Choose',A:option('Keep'),B:option('Change')}},costUsd:.01,provider:'fixture',model:'fixture'};
    }};
    const engine=new Workbench({store,config,workers:[worker],repositoryKnowledgeReader:f.reader,writer:{async baseline(){return 'baseline';},async deliver(){throw Error('unused');}},research:{async research(){return research;}}});
    try{
      await ingestStructuredKnowledge(store,f.reader,f.source.id,new AbortController().signal);
      const task:Task={id:'fresh-snapshot',projectId:p.id,domain:p.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Requested check',description:'Requested check',status:'deciding',version:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',runAfter:'2026-01-01T00:00:00.000Z',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};
      store.save('tasks',task);const retainedContext=await prepareFactualContext(store,f.reader,task,new AbortController().signal);expect(retainedContext).toBeDefined();
      const retainedCard=store.list('cards').find(value=>value.claim?.claim.kind==='ci-result')!;
      const retainedRequest={temporal:'current' as const,contextId:retainedContext!.id};
      expect(factualEligibility(store,retainedCard,p,retainedRequest,retainedContext).eligible).toBe(true);
      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      for(let i=0;i<5&&store.get('tasks',task.id)?.status!=='awaiting_answer';i++)await engine.tick();
      const question=store.list('questions').find(q=>q.status==='open')!;expect(question).toBeDefined();
      const decided=store.get('tasks',task.id)!,snapshot=store.get('actions',decided.decisionSnapshotId!)!.payload.snapshot as any;
      const fact=snapshot.factualUse.facts[0],last=seen.filter(input=>input.role==='decide').at(-1)!;
      const workerCard=last.cards.find(value=>value.claim?.claim.kind==='ci-result')!;
      expect(workerCard.reportedStatement).toEqual({text:'Requested check',status:'reported'});
      expect(workerCard.description).toMatchObject({status:'host-observation',text:expect.stringContaining('reported success')});
      expect(workerCard.body).toBe(workerCard.description!.text);expect(workerCard.body).not.toContain('Requested check');
      expect(workerCard.reportedAuthor).toEqual({id:'owner',authenticated:false});
      expect(last.factualContext?.observedAt).toBe('2026-01-01T00:01:00.000Z');
      expect(fact).toMatchObject({currentReadAt:'2026-01-01T00:01:00.000Z',observedAt:['2026-01-01T00:00:00.000Z'],eventAt:[time]});
      const card=store.get('cards',fact.ref.cardId)!;
      const historical=factualEligibility(store,card,p,{temporal:'historical'});expect(historical.eligible).toBe(true);
      if(historical.eligible)expect(historical.fact.currentReadAt).toBeUndefined();
      const app=createApp({store,config,engine});
      const questionHtml=await (await app.request(`/tasks/${task.id}?project=p`)).text();
      expect(questionHtml).toContain('助手分析');expect(questionHtml).toContain('预计代价（助手预测）');expect(questionHtml).toContain('proposed reasoning');expect(questionHtml).toContain('predicted cost');
      engine.answer({questionId:question.id,questionVersion:question.version,taskVersion:question.taskVersion,choice:'C',text:'Proceed carefully',actorId:'owner',eventId:'fresh-answer'});
      store.delete('actions',last.factualContext!.id);
      expect(factualEligibility(store,card,p,fact.ref.request,last.factualContext).eligible).toBe(false);
      let html=await (await app.request('/standards?project=p')).text();
      expect(html).toContain('当前读取时间：2026-01-01T00:01:00.000Z');expect(html).toContain('原观察时间：2026-01-01T00:00:00.000Z');
      const c=store.list('cases')[0]!,legacy=structuredClone(c);delete (legacy.decisionSnapshot!.factualUse!.facts[0] as any).currentReadAt;store.save('cases',legacy);
      html=await (await app.request('/standards?project=p')).text();expect(html).toContain('当前读取时间：未知');expect(html).toContain('原观察时间：2026-01-01T00:00:00.000Z');
      store.save('cases',c);
      store.transaction(()=>invalidateSource(store,parent.id,'superseded'));
      expect(store.get('sources',f.source.id)?.status).toBe('superseded');
      expect(store.get('actions',decided.decisionSnapshotId!)?.payload.snapshot).toEqual(snapshot);
      const contexts=store.list('actions').filter(a=>a.kind==='knowledge.factual-context');expect(contexts.length).toBeGreaterThan(0);
      for(const context of contexts)expect(context.payload).toMatchObject({retracted:true,phase:'invalid'});
      const backup=join(dir,'backup');await store.backup(backup);await engine.shutdown();store.close();
      for(const path of [backup,db]){const restored=new Store(path);try{
        expect(restored.get('actions',decided.decisionSnapshotId!)?.payload.snapshot).toEqual(snapshot);
        const retained=restored.get('actions',retainedContext!.id);
        expect(retained).toBeDefined();
        expect(retained).toMatchObject({id:retainedContext!.id,taskId:task.id,kind:'knowledge.factual-context',status:'completed',payload:{retracted:true,phase:'invalid',errorCode:'source_invalidated'}});
        expect(retained!.payload).toEqual(contexts.find(a=>a.id===retainedContext!.id)!.payload);
        expect(retained!.payload).toEqual({schemaVersion:1,phase:'invalid',errorCode:'source_invalidated',retracted:true,sourceIds:[parent.id],primarySourceId:f.source.id,taskVersion:task.version,contextHash:digest(retainedContext!),sourceRefs:[{id:parent.id,revisionHash:digest(parent.revision)},{id:f.source.id,revisionHash:digest(f.source.revision)}],auditHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
        expect(JSON.stringify(retained!.payload)).not.toContain('Requested check');
        expect(JSON.stringify(retained!.payload)).not.toContain('observations');
        expect(JSON.stringify(retained!.payload)).not.toContain('locator');
        expect(factualEligibility(restored,retainedCard,p,retainedRequest,retainedContext).eligible).toBe(false);
        expect(factualEligibility(restored,card,p,fact.ref.request,last.factualContext).eligible).toBe(false);
      }finally{restored.close();}}
    }finally{await engine.shutdown();store.close();rmSync(dir,{recursive:true,force:true});vi.useRealTimers();}
  });

  it('G7-FIX1 I3 labels the actual prior decision sent from decide to plan',async()=>{
    const store=new Store(':memory:'),seen:WorkerInput[]=[];
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:'.',vaultDir:'.',ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[project],workers:{},scanIntervalMs:1000,runnerPolicies:[{runner:'grok',roles:[...roles],domains:['personal'],provider:'fixture',model:'fixture',admitted:true,costPerRunUsd:.01,independentReview:false}]};
    const worker:WorkerAdapter={name:'grok',async run(input){
      seen.push(structuredClone(input));
      const citation={sourceId:input.source.id,revision:input.source.revision,quote:'requirement',locator:input.source.locator};
      const output=input.role==='knowledge_extract'?{cards:[]}:input.role==='case_extract'?{observations:[]}:input.role==='decide'?{action:'proceed',summary:'Proposed summary',rationale:'Proposed analysis',expectedOutcome:'Predicted result',citations:[citation],ruleIds:[],grounds:{statements:[{citation,purpose:'requirement',binding:'task-request'}],facts:[],unresolved:[]}}:{taskVersion:input.task.version,sourceRevision:input.source.revision,baselineSha:'baseline',summary:'Plan',paths:['docs/PRD.md'],steps:['Write'],tests:['test'],stopConditions:['Stop']};
      return {output,costUsd:.01,provider:'fixture',model:'fixture'};
    }};
    const engine=new Workbench({store,config,workers:[worker],writer:{async baseline(){return 'baseline';},async deliver(){throw Error('not used');}},research:{async research(){throw Error('not used');}}});
    try {
      const task=engine.ingest({projectId:'p',externalId:'labels',title:'Labels',content:'A requirement'})!;
      for(let i=0;i<12&&!seen.some(input=>input.role==='plan');i++)await engine.tick();
      const plan=seen.find(input=>input.role==='plan')!;
      expect(plan.task.decision).toMatchObject({summary:'Proposed summary',rationale:'Proposed analysis',expectedOutcome:'Predicted result'});
      expect(plan.decisionInterpretation).toEqual({summary:'assistant-inference',rationale:'assistant-inference',expectedOutcome:'assistant-prediction'});
      const app=createApp({store,config,engine}),html=await (await app.request(`/tasks/${task.id}?project=p`)).text();
      expect(html).toContain('助手初判');expect(html).toContain('助手分析');expect(html).toContain('助手预测');
      expect(html).toContain('Proposed summary');expect(html).toContain('Proposed analysis');expect(html).toContain('Predicted result');expect(html).toContain('引用原文');
      const after=store.get('tasks',task.id)!,legacy={...after.decision!};delete legacy.grounds;
      store.save('tasks',{...after,status:'planning',stage:'plan',decision:legacy});
      const count=seen.length;await engine.tick();const later=seen.slice(count).find(input=>input.role==='plan')!;
      expect(later.task.decision?.grounds).toBeUndefined();
      expect(later.decisionInterpretation).toEqual({summary:'assistant-inference',rationale:'assistant-inference',expectedOutcome:'assistant-prediction'});
    } finally {await engine.shutdown();store.close();}
  });

  it('rejects a fabricated fact reference during actual decision commit',async()=>{
    const store=new Store(':memory:');
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:'.',vaultDir:'.',ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[project],workers:{},scanIntervalMs:1000,runnerPolicies:[{runner:'grok',roles:[...roles],domains:['personal'],provider:'fixture',model:'fixture',admitted:true,costPerRunUsd:.01,independentReview:false}]};
    const worker:WorkerAdapter={name:'grok',async run(input){const citation={sourceId:input.source.id,revision:input.source.revision,quote:'requirement',locator:input.source.locator};return {output:input.role==='knowledge_extract'?{cards:[]}:input.role==='case_extract'?{observations:[]}:{action:'proceed',summary:'Claim',rationale:'Interpretation',citations:[citation],ruleIds:[],grounds:{statements:[],facts:[{cardId:'invented',claimHash:'0'.repeat(64),request:{temporal:'historical'}}],unresolved:[]}},costUsd:.01,provider:'fixture',model:'fixture'};}};
    const engine=new Workbench({store,config,workers:[worker],writer:{async baseline(){return 'base';},async deliver(){throw Error('not used');}},research:{async research(){throw Error('not used');}}});
    try{const task=engine.ingest({projectId:'p',externalId:'fabricated',title:'Test',content:'A requirement'})!;for(let i=0;i<8&&store.get('tasks',task.id)?.status!=='blocked';i++)await engine.tick();expect(store.get('tasks',task.id)?.status).toBe('blocked');expect(store.list('actions').filter(a=>a.kind==='decision.snapshot')).toHaveLength(0);}finally{await engine.shutdown();store.close();}
  });

  it('uses the actual accepted owner answer as a scoped requirement, while labeling the loss report separately',async()=>{
    const store=new Store(':memory:');
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:'.',vaultDir:'.',ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[project],workers:{},scanIntervalMs:1000,runnerPolicies:[{runner:'grok',roles:[...roles],domains:['personal'],provider:'fixture',model:'fixture',admitted:true,costPerRunUsd:.01,independentReview:false}]};
    const option=(label:string)=>({label,description:label,rationale:'tradeoff',tradeoff:'cost',evidenceUrls:['https://zh.example.test/source','https://en.example.test/source']});
    const worker:WorkerAdapter={name:'grok',async run(input){
      const original={sourceId:input.source.id,revision:input.source.revision,quote:'someone lost a draft',locator:input.source.locator};
      const answer=input.rules.find(rule=>rule.kind==='principle')?.citations[0];
      const decision=answer?{action:'proceed',summary:'Apply the owner directive',rationale:'Proposed implementation',citations:[answer,original],ruleIds:[],grounds:{statements:[{citation:answer,purpose:'requirement',binding:'accepted-owner-answer'},{citation:original,purpose:'author-statement',binding:'source-statement'}],facts:[],unresolved:[]}}:{action:'ask',summary:'Choose retention',rationale:'Tradeoff',citations:[original],ruleIds:[],grounds:{statements:[{citation:original,purpose:'author-statement',binding:'source-statement'}],facts:[],unresolved:[]},question:{title:'Retention?',context:'Choose',A:option('Keep'),B:option('Delete')}};
      return {output:input.role==='knowledge_extract'?{cards:[]}:input.role==='case_extract'?{observations:[]}:decision,costUsd:.01,provider:'fixture',model:'fixture'};
    }};
    const research={queries:(['zh','en'] as const).map(language=>({language,query:'draft recovery',searchedAt:'2026-01-01T00:00:00Z',sources:[{language,url:`https://${language}.example.test/source`,canonicalUrl:`https://${language}.example.test/source`,title:'Source',publishedAt:'2026-01-01',accessedAt:'2026-01-02',excerpt:'Retention options',primary:true,conditions:'draft'}]})),summary:'Tradeoffs',gaps:[]};
    const engine=new Workbench({store,config,workers:[worker],writer:{async baseline(){return 'base';},async deliver(){throw Error('not used');}},research:{async research(){return research;}}});
    try{
      const task=engine.ingest({projectId:'p',externalId:'owner-answer',title:'Draft',content:'The source says someone lost a draft.'})!;
      for(let i=0;i<12&&store.get('tasks',task.id)?.status!=='awaiting_answer';i++)await engine.tick();
      const q=store.list('questions').find(question=>question.status==='open')!;expect(q,JSON.stringify(store.get('tasks',task.id))).toBeDefined();
      engine.answer({questionId:q.id,taskVersion:q.taskVersion,questionVersion:q.version,actorId:'owner',eventId:'answer',choice:'C',text:'retain this product draft until the next successful export'});
      const ownerSource=store.get('sources',stableId('owner-answer',q.id))!;
      const ownerCard={id:'owner-answer-card',projectId:project.id,domain:project.domain,sourceId:ownerSource.id,sourceRevision:ownerSource.revision,title:'Owner answer',body:ownerSource.content,quote:ownerSource.content,locator:ownerSource.locator,kind:'fact' as const,verification:'reported' as const,status:'active' as const,aliases:[],createdAt:''};store.save('cards',ownerCard);
      expect(knowledgeReference(store,ownerCard,project)?.reportedAuthor).toEqual({id:'owner',authenticated:true});
      const event=store.get('cursors',stableId('answer-event',project.id,project.domain,'answer'))!;store.delete('cursors',event.id);
      expect(knowledgeReference(store,ownerCard,project)?.reportedAuthor).toEqual({id:'owner',authenticated:false});store.save('cursors',event);
      await engine.tick();const decided=store.get('tasks',task.id)!;expect(decided.stage,JSON.stringify(decided)).toBe('plan');
      const snapshot=store.get('actions',decided.decisionSnapshotId!)!.payload.snapshot as any;
      expect(snapshot.factualUse.facts).toEqual([]);expect(snapshot.factualUse.statements.map((s:any)=>s.binding)).toEqual(['accepted-owner-answer','source-statement']);
      expect(snapshot.factualUse.interpretationLabel).toBe('assistant-inference');
    }finally{await engine.shutdown();store.close();}
  });

  it('preempts a stalled current read for another ready task and ignores the late handoff',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');f.project.budgetUsd=10;f.store.save('projects',f.project);f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:'.',vaultDir:'.',ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[f.project],workers:{},scanIntervalMs:1000,runnerPolicies:[{runner:'grok',roles:[...roles],domains:['personal'],provider:'fixture',model:'fixture',admitted:true,costPerRunUsd:.01,independentReview:false}]};
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const reader={async read(...args:Parameters<typeof f.reader.read>){const result=await f.reader.read(...args);if(args[2].current){enter();await gate;}return result;}};
    const worked:string[]=[];const worker:WorkerAdapter={name:'grok',async run(input){worked.push(input.task.id);return {output:{cards:[]},costUsd:.01,provider:'fixture',model:'fixture'};}};
    const engine=new Workbench({store:f.store,config,workers:[worker],repositoryKnowledgeReader:reader,writer:{async baseline(){return 'base';},async deliver(){throw Error('not used');}},research:{async research(){throw Error('not used');}}});let first:Promise<void>|undefined,second:Promise<void>|undefined;
    try{
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);
      const task:Task={id:'slow-current',projectId:f.project.id,domain:f.project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',runAfter:'2020-01-01T00:00:00Z',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};f.store.save('tasks',task);
      first=engine.tick();await entered;
      const other=engine.ingest({projectId:f.project.id,externalId:'other',title:'Other',content:'ordinary work'})!;
      second=engine.tick();for(let i=0;i<400;i++)await Promise.resolve();
      expect(worked).toContain(other.id);expect(f.store.list('actions').filter(a=>a.kind==='knowledge.factual-context')).toHaveLength(0);
      const before=JSON.stringify(f.store.list('actions'));release();await first;await second;first=undefined;second=undefined;
      for(let i=0;i<100;i++)await Promise.resolve();expect(JSON.stringify(f.store.list('actions'))).toBe(before);
    }finally{release();if(first)await first;if(second)await second;await engine.shutdown();f.close();}
  });

  it.each(['source','policy','task'] as const)('rejects a decision if its frozen %s changes during worker execution',async changed=>{
    const store=new Store(':memory:');
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:'.',vaultDir:'.',ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[project],workers:{},scanIntervalMs:1000,runnerPolicies:[{runner:'grok',roles:[...roles],domains:['personal'],provider:'fixture',model:'fixture',admitted:true,costPerRunUsd:.01,independentReview:false}]};
    const worker:WorkerAdapter={name:'grok',async run(input){
      if(input.role==='decide'){
        if(changed==='source')store.save('sources',{...input.source,content:input.source.content+' altered'});
        if(changed==='policy')store.save('projects',{...input.project,trustedAppIds:[]});
        if(changed==='task')store.save('tasks',{...store.get('tasks',input.task.id)!,title:'Changed title'});
      }
      const citation={sourceId:input.source.id,revision:input.source.revision,quote:'requirement',locator:input.source.locator};
      return {output:input.role==='knowledge_extract'?{cards:[]}:input.role==='case_extract'?{observations:[]}:{action:'proceed',summary:'Apply',rationale:'Interpretation',citations:[citation],ruleIds:[],grounds:{statements:[{citation,purpose:'requirement',binding:'task-request'}],facts:[],unresolved:[]}},costUsd:.01,provider:'fixture',model:'fixture'};
    }};
    const engine=new Workbench({store,config,workers:[worker],writer:{async baseline(){return 'base';},async deliver(){throw Error('not used');}},research:{async research(){throw Error('not used');}}});
    try{const task=engine.ingest({projectId:'p',externalId:`changed-${changed}`,title:'Task',content:'A requirement'})!;for(let i=0;i<8&&store.get('tasks',task.id)?.stage!=='plan'&&store.get('tasks',task.id)?.status!=='blocked';i++)await engine.tick();if(changed==='source'){expect(store.get('tasks',task.id)?.stage).toBe('decide');expect(store.list('attempts').at(-1)?.status).toBe('stale');}else expect(store.get('tasks',task.id)?.status).toBe('blocked');expect(store.list('actions').filter(a=>a.kind==='decision.snapshot')).toHaveLength(0);}finally{await engine.shutdown();store.close();}
  });

  it('does not turn an arbitrary source authorId into an accepted owner answer',async()=>{
    const store=new Store(':memory:');
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:'.',vaultDir:'.',ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[project],workers:{},scanIntervalMs:1000,runnerPolicies:[{runner:'grok',roles:[...roles],domains:['personal'],provider:'fixture',model:'fixture',admitted:true,costPerRunUsd:.01,independentReview:false}]};
    const worker:WorkerAdapter={name:'grok',async run(input){const citation={sourceId:input.source.id,revision:input.source.revision,quote:'someone lost a draft',locator:input.source.locator};return {output:input.role==='knowledge_extract'?{cards:[]}:input.role==='case_extract'?{observations:[]}:{action:'proceed',summary:'Claim',rationale:'Interpretation',citations:[citation],ruleIds:[],grounds:{statements:[{citation,purpose:'requirement',binding:'accepted-owner-answer'}],facts:[],unresolved:[]}},costUsd:.01,provider:'fixture',model:'fixture'};}};
    const engine=new Workbench({store,config,workers:[worker],writer:{async baseline(){return 'base';},async deliver(){throw Error('not used');}},research:{async research(){throw Error('not used');}}});
    try{const task=engine.ingest({projectId:'p',externalId:'claimed-owner',title:'Report',content:'someone lost a draft',authorId:'owner'})!;for(let i=0;i<8&&store.get('tasks',task.id)?.status!=='blocked';i++)await engine.tick();expect(store.get('tasks',task.id)?.status).toBe('blocked');expect(store.list('actions').filter(a=>a.kind==='decision.snapshot')).toHaveLength(0);}finally{await engine.shutdown();store.close();}
  });

  it('keeps four interrupted current reads owned through shutdown and admits another task without invented context',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');f.project.budgetUsd=10;f.store.save('projects',f.project);f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:'.',vaultDir:'.',ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[f.project],workers:{},scanIntervalMs:1000,runnerPolicies:[{runner:'grok',roles:[...roles],domains:['personal'],provider:'fixture',model:'fixture',admitted:true,costPerRunUsd:.01,independentReview:false}]};
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),signals:Array<()=>void>=[],entered=Array.from({length:4},()=>new Promise<void>(resolve=>{signals.push(resolve);}));let active=0,maximum=0,reads=0;
    const reader={async read(...args:Parameters<typeof f.reader.read>){active++;maximum=Math.max(maximum,active);try{const value=await f.reader.read(...args);signals[reads++]?.();await gate;return value;}finally{active--;}}};
    const worked:WorkerInput[]=[];const worker:WorkerAdapter={name:'grok',async run(input){worked.push(structuredClone(input));return {output:{action:'archive',summary:'Defer',rationale:'No current readback',citations:[],ruleIds:[],grounds:{statements:[],facts:[],unresolved:[]}},costUsd:.01,provider:'fixture',model:'fixture'};}};
    const engine=new Workbench({store:f.store,config,workers:[worker],repositoryKnowledgeReader:reader,writer:{async baseline(){return 'base';},async deliver(){throw Error('not used');}},research:{async research(){throw Error('not used');}}});
    const pending:Promise<void>[]=[];
    try{
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);
      const add=(n:number):Task=>{const task:Task={id:`capacity-${n}`,projectId:f.project.id,domain:f.project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',runAfter:`2020-01-01T00:00:0${n}Z`,attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};f.store.save('tasks',task);return task;};
      let previous=add(0);pending.push(engine.tick());await entered[0];
      for(let i=1;i<4;i++){const current=add(i);pending.push(engine.tick());await entered[i];await pending[i-1];engine.cancel(previous.id);previous=current;}
      const fifth=add(4);pending.push(engine.tick());await pending[3];engine.cancel(previous.id);await pending[4];
      expect(reads).toBe(4);expect(maximum).toBe(4);expect(worked.find(input=>input.task.id===fifth.id)?.factualContext).toBeUndefined();
      expect(f.store.list('actions').filter(action=>action.kind==='knowledge.factual-context')).toHaveLength(0);
      const before=JSON.stringify(f.store.list('actions'));let stopped=false;const ending=engine.shutdown().then(()=>{stopped=true;});for(let i=0;i<100;i++)await Promise.resolve();expect(stopped).toBe(false);
      release();await ending;expect(stopped).toBe(true);expect(JSON.stringify(f.store.list('actions'))).toBe(before);
    }finally{release();await Promise.allSettled(pending);await engine.shutdown();f.close();}
  });

  it('uses the same labeled historical projection for authenticated lookup, state and browsing',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');f.project.budgetUsd=10;f.store.save('projects',f.project);f.routes['/merge_requests/17'].sha=H;
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:'.',vaultDir:'.',ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[f.project],workers:{},scanIntervalMs:1000,runnerPolicies:[]};
    const engine=new Workbench({store:f.store,config,workers:[],writer:{async baseline(){return 'base';},async deliver(){throw Error('not used');}},research:{async research(){throw Error('not used');}}});
    try{
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);const app=createApp({store:f.store,config,engine});
      const response=await app.request('/api/lookup?project=p&domain=personal&q=validate&browse=true&contextId=invented');expect(response.status).toBe(200);const result=await response.json() as any;
      const card=result.cards.find((value:any)=>value.claim?.claim.kind==='ci-result');expect(card).toMatchObject({reportedStatement:{text:'Requested check',status:'reported'},reportedAuthor:{id:'owner',authenticated:false},description:{status:'host-observation',text:expect.stringContaining('reported success')},currentEvidenceGap:'needs-current-readback',factual:{eligible:true,fact:{temporal:'historical',claim:{subject:{jobId:'71'}}}}});
      const standard=await (await app.request('/api/lookup?project=p&domain=personal&q=validate')).json() as any;
      expect(standard.cards.find((value:any)=>value.id===card.id)).toEqual(card);
      const state=await (await app.request('/api/state?project=p')).json() as any;expect(state.cards.find((value:any)=>value.id===card.id).factual.fact.ref).toEqual(card.factual.fact.ref);
      const html=await (await app.request('/knowledge?project=p&q=validate')).text();expect(html).toContain('历史观察');expect(html).toContain('宿主生成的观察描述');expect(html).toContain('来源原文');expect(html).toContain('Requested check');expect(html).toContain('身份未核验');expect(html).toContain('当前状态尚需新的授权读取');expect(html).not.toContain('verification-verified');
    }finally{await engine.shutdown();f.close();}
  });


  it('G7-FIX2 N1 suppresses a forged Vault observation in every shared consumer',async()=>{
    const root=mkdtempSync(join(tmpdir(),'patrick-g7-vault-forgery-')),db=join(root,'db'),vault=join(root,'vault');
    const template=repositoryKnowledgeFixture('gitlab'),p=structuredClone(template.project);template.close();p.budgetUsd=10;
    let store=new Store(db,vault);let engine:Workbench|undefined;
    const handlers=new Map<string,(input:any)=>Promise<any>>(),seen:WorkerInput[]=[];
    try{
      let fixture=repositoryKnowledgeFixture('gitlab',{store,project:p});
      fixture.routes['/merge_requests/17'].sha=H;fixture.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
      expect(await ingestStructuredKnowledge(store,fixture.reader,fixture.source.id,new AbortController().signal)).toBe('processed');
      const original=store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      const forged=structuredClone(original);forged.id='knowledge-structured-card:recovered-forgery';
      if(forged.claim?.claim.kind!=='ci-result')throw Error('expected CI fixture');
      forged.claim.claim.subject.jobId='999';forged.body=structuredClaimBody(forged.claim.claim,forged.quote);
      const cards=join(vault,encodeURIComponent(p.id),encodeURIComponent(p.domain),'cards');mkdirSync(cards,{recursive:true});
      writeFileSync(join(cards,`${encodeURIComponent(forged.id)}.md`),`---\ntype: cards\npatrick_entity: ${JSON.stringify(forged)}\n---\n\nVault recovery fixture\n`);
      store.close();store=new Store(db,vault);
      const recovered=store.get('cards',forged.id)!;expect(recovered.status).toBe('active');expect(recovered.quote).toBe('Requested check');
      const view=knowledgeReference(store,recovered,p)!;
      expect(view.description?.status).not.toBe('host-observation');
      expect(view.description?.text).not.toContain('job 999');
      expect(view.factual).toEqual({eligible:false,reason:'missing-authority'});
      expect(view.reportedStatement).toEqual({text:'Requested check',status:'reported'});
      expect(view.reportedAuthor).toEqual({id:'owner',authenticated:false});
      const genuine=knowledgeReference(store,store.get('cards',original.id)!,p)!;
      expect(genuine.description?.status).toBe('host-observation');expect(genuine.factual?.eligible).toBe(true);
      fixture=repositoryKnowledgeFixture('gitlab',{store,project:p});
      const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:root,vaultDir:vault,ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[p],workers:{},scanIntervalMs:1000,runnerPolicies:[{runner:'grok',roles:[...roles],domains:['personal'],provider:'fixture',model:'fixture',admitted:true,costPerRunUsd:.01,independentReview:false}]};
      const worker:WorkerAdapter={name:'grok',async run(input){seen.push(structuredClone(input));return {output:{action:'archive',summary:'Defer',rationale:'No supported fact',citations:[],ruleIds:[],grounds:{statements:[],facts:[],unresolved:[]}},costUsd:.01,provider:'fixture',model:'fixture'};}};
      engine=new Workbench({store,config,workers:[worker],writer:{async baseline(){return 'base';},async deliver(){throw Error('unused');}},research:{async research(){throw Error('unused');}}});
      const task:Task={id:'forged-projection',projectId:p.id,domain:p.domain,sourceId:fixture.source.id,sourceRevision:fixture.source.revision,title:'validate',description:'Requested check',status:'deciding',version:1,createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',runAfter:'2020-01-01T00:00:00Z',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};
      store.save('tasks',task);await engine.tick();
      expect(seen.find(input=>input.role==='decide')!.cards.find(card=>card.id===forged.id)).toEqual(view);
      expect(seen.find(input=>input.role==='decide')!.facts.some(fact=>fact.ref.cardId===forged.id)).toBe(false);
      const app=createApp({store,config,engine});
      for(const query of ['','&browse=true']){
        const response=await app.request(`/api/lookup?project=p&domain=personal&q=999${query}`);expect(response.status).toBe(200);
        expect((await response.json() as any).cards.find((card:any)=>card.id===forged.id)).toEqual(view);
      }
      const state=await (await app.request('/api/state?project=p')).json() as any;expect(state.cards.find((card:any)=>card.id===forged.id)).toEqual(view);
      const html=await (await app.request('/knowledge?project=p&q=999')).text();
      expect(html).not.toContain('job 999');expect(html).not.toContain('宿主生成的观察描述');expect(html).toContain('助手推断');expect(html).toContain('Unverified repository observation');expect(html).toContain('来源原文');expect(html).toContain('Requested check');expect(html).toContain('身份未核验');
      vi.doMock('@modelcontextprotocol/sdk/server/mcp.js',()=>({McpServer:class{registerTool(name:string,_options:unknown,handler:(input:any)=>Promise<any>){handlers.set(name,handler);}async connect(){}}}));
      vi.doMock('@modelcontextprotocol/sdk/server/stdio.js',()=>({StdioServerTransport:class{}}));
      vi.stubEnv('PATRICK_URL','http://127.0.0.1:4317');vi.stubEnv('PATRICK_MCP_PROJECT',p.id);vi.stubEnv('PATRICK_MCP_DOMAIN',p.domain);vi.stubEnv('PATRICK_TOKEN','');
      vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>app.request(String(input),init));
      await import('../../src/mcp.js');
      const response=await handlers.get('lookup')!({query:'999'}),result=JSON.parse(response.content[0].text);
      expect(result.cards.find((card:any)=>card.id===forged.id)).toEqual(view);
    }finally{
      vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');vi.unstubAllGlobals();vi.unstubAllEnvs();vi.resetModules();
      if(engine)await engine.shutdown();store.close();rmSync(root,{recursive:true,force:true});
    }
  });

  it('G7-FIX1 preserves the same separated attribution through the actual MCP lookup handler',async()=>{
    const f=repositoryKnowledgeFixture('gitlab'),handlers=new Map<string,(input:any)=>Promise<any>>();
    const config:AppConfig={mode:'test',host:'127.0.0.1',port:0,dataDir:'.',vaultDir:'.',ownerId:'owner',authToken:'test',sessionSecret:'test',projects:[f.project],workers:{},scanIntervalMs:1000,runnerPolicies:[]};
    const engine=new Workbench({store:f.store,config,workers:[],writer:{async baseline(){return 'base';},async deliver(){throw Error('unused');}},research:{async research(){throw Error('unused');}}});
    try{
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);
      const app=createApp({store:f.store,config,engine});
      vi.doMock('@modelcontextprotocol/sdk/server/mcp.js',()=>({McpServer:class{registerTool(name:string,_options:unknown,handler:(input:any)=>Promise<any>){handlers.set(name,handler);}async connect(){}}}));
      vi.doMock('@modelcontextprotocol/sdk/server/stdio.js',()=>({StdioServerTransport:class{}}));
      vi.stubEnv('PATRICK_URL','http://127.0.0.1:4317');vi.stubEnv('PATRICK_MCP_PROJECT',f.project.id);vi.stubEnv('PATRICK_MCP_DOMAIN',f.project.domain);vi.stubEnv('PATRICK_TOKEN','');
      vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>app.request(String(input),init));
      await import('../../src/mcp.js');
      const response=await handlers.get('lookup')!({query:'validate'}),result=JSON.parse(response.content[0].text);
      const card=result.cards.find((value:any)=>value.claim?.claim.kind==='ci-result');
      expect(card).toMatchObject({reportedStatement:{text:'Requested check',status:'reported'},reportedAuthor:{id:'owner',authenticated:false},description:{status:'host-observation',text:expect.stringContaining('reported success')},factual:{eligible:true,fact:{temporal:'historical'}}});
      expect(card.reportedStatement.text).not.toContain('success');
    }finally{vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');vi.unstubAllGlobals();vi.unstubAllEnvs();vi.resetModules();await engine.shutdown();f.close();}
  });

});
