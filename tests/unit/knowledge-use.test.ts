import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';
import { invalidateSource, withdrawSource } from '../../src/intake.js';
import { decisionSchema, digest, type KnowledgeCard, type Task } from '../../src/domain.js';
import { atomicClaimText } from '../../src/knowledge-contract.js';
import { acceptRepositoryReadback, linkKnowledgeEvidence } from '../../src/knowledge-evidence.js';
import { factualContextAuditDigest, knowledgeActionDependencies, readHostObservation } from '../../src/knowledge-records.js';
import { ingestStructuredKnowledge, type StructuredCurrentReceipt } from '../../src/knowledge.js';
import { prepareFactualContext } from '../../src/orchestrator.js';
import { factualEligibility, expandFactRefs, knowledgeReference } from '../../src/knowledge-use.js';
import { repositoryKnowledgeFixture, H, H2, time, reportPath } from '../fixtures/repository-knowledge.js';

describe('canonical factual use', () => {
  it('G7-FIX1 I2 separates the source quote from generated provider wording', async () => {
    const f=repositoryKnowledgeFixture('gitlab');
    try {
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);
      const card=f.store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      const view=knowledgeReference(f.store,card,f.project)!;
      expect(view.reportedStatement).toEqual({text:'Requested check',status:'reported'});
      expect(view.reportedAuthor).toEqual({id:'owner',authenticated:false});
      expect(view.description).toMatchObject({status:'host-observation',text:expect.stringContaining('reported success')});
      expect(view.body).toBe(view.description!.text);expect(view.body).not.toContain('Requested check');
      expect(f.store.get('cards',card.id)?.body).toBe(card.body);
      expect(view.reportedStatement!.text).not.toContain('success');
      for(const verification of ['reported','inference'] as const){
        const ordinary={...card,id:`ordinary-${verification}`,kind:'knowledge' as const,claim:undefined,body:'Model-generated summary',verification};
        f.store.save('cards',ordinary);const projected=knowledgeReference(f.store,ordinary,f.project)!;
        expect(projected.reportedStatement).toEqual({text:'Requested check',status:'reported'});
        expect(projected.description).toEqual({text:'Model-generated summary',status:verification==='reported'?'reported-summary':'inference'});
      }
      const invalid={...card,id:'invalid-quote',quote:'Absent from the source'};f.store.save('cards',invalid);
      expect(knowledgeReference(f.store,invalid,f.project)?.reportedStatement).toBeUndefined();
      expect(knowledgeReference(f.store,invalid,f.project)?.reportedAuthor).toBeUndefined();
      expect(knowledgeReference(f.store,invalid,f.project)?.quote).toBe('');
      const badLocator={...card,id:'bad-locator',locator:'unrelated'};f.store.save('cards',badLocator);
      expect(knowledgeReference(f.store,badLocator,f.project)?.reportedStatement).toBeUndefined();
      const malformed={...card,id:'knowledge-structured-card:malformed',claim:{schemaVersion:1,claim:{kind:'ci-result'},quote:'Requested check',interpretation:'reported'}} as unknown as KnowledgeCard;
      f.store.save('cards',malformed);expect(()=>knowledgeReference(f.store,malformed,f.project)).not.toThrow();
    } finally {f.close();}
  });
  it('keeps pending structured locators useful without attributing observations',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');
    try{
      expect(await ingestStructuredKnowledge(f.store,undefined,f.source.id,new AbortController().signal)).toBe('pending');
      const pending=f.store.list('cards').find(card=>card.pendingClaim)!;expect(pending).toBeDefined();
      const view=knowledgeReference(f.store,pending,f.project)!;
      expect(view.description).toEqual({text:'Repository locator supplied by the source; its state requires authenticated readback.',status:'reported-summary'});
      expect(view.reportedStatement).toEqual({text:'Requested check',status:'reported'});
      expect(view.factual).toEqual({eligible:false,reason:'unverified'});
    }finally{f.close();}
  });
  it('G7-FIX1 I4 tombstones completed contexts when a source is superseded', async () => {
    const f=repositoryKnowledgeFixture('gitlab');
    try {
      f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
      const task:Task={id:'superseded-context',projectId:f.project.id,domain:f.project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};
      f.store.save('tasks',task);await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);
      const card=f.store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      const context=await prepareFactualContext(f.store,f.reader,task,new AbortController().signal);
      expect(context).toBeDefined();
      f.store.transaction(()=>invalidateSource(f.store,f.source.id,'superseded'));
      expect(f.store.get('actions',context!.id)?.payload).toEqual({
        schemaVersion:1,phase:'invalid',errorCode:'source_invalidated',retracted:true,sourceIds:[f.source.id],
        primarySourceId:f.source.id,taskVersion:task.version,contextHash:digest(context!),
        sourceRefs:[{id:f.source.id,revisionHash:digest(f.source.revision)}],auditHash:expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(factualEligibility(f.store,card,f.project,{temporal:'current',contextId:context!.id},context).eligible).toBe(false);
    } finally {f.close();}
  });
  it('expands an admitted historical check into a bounded fact with its actual times', async () => {
    const f = repositoryKnowledgeFixture();
    try {
      f.routes['/pulls/17'].head.sha = H;
      expect(await ingestStructuredKnowledge(f.store, f.reader, f.source.id, new AbortController().signal)).toBe('processed');
      const card = f.store.list('cards').find(c => c.claim?.claim.kind === 'ci-result')!;
      expect(card).toBeDefined();
      expect(card.body).toContain('job 71');expect(card.body).toContain(card.quote);
      expect(knowledgeReference(f.store,card,f.project)?.reportedAuthor).toEqual({id:'owner',authenticated:false});
      const gate = factualEligibility(f.store, card, f.project, { temporal: 'historical' });
      expect(gate.eligible).toBe(true);
      if (!gate.eligible) return;
      expect(gate.fact).toMatchObject({ claim: { kind: 'ci-result', subject: { headSha: H, runId: '52', jobId: '71' }, value: { conclusion: 'success' } }, temporal: 'historical', eventAt: [time] });
      expect(gate.fact.observedAt[0]).toBeTruthy();
      expect(expandFactRefs(f.store, [{ cardId: card.id, claimHash: digest(card.claim!.claim), request: { temporal: 'historical' } }], f.project)).toEqual([gate.fact]);
      expect(() => expandFactRefs(f.store, [{ cardId: card.id, claimHash: '0'.repeat(64), request: { temporal: 'historical' } }], f.project)).toThrow();
      expect(factualEligibility(f.store, card, f.project, { temporal: 'current', contextId: 'invented' })).toEqual({ eligible: false, reason: 'needs-current-readback' });
    } finally { f.close(); }
  });
  it('refresh receipts include only the actually selected current job, preserving the original historical row time', async () => {
    const f = repositoryKnowledgeFixture('gitlab');
    try {
      f.routes['/merge_requests/17'].sha = H;
      f.routes['/merge_requests/17/pipelines'] = [{id:52,sha:H}];
      f.routes['/jobs/72'] = {...f.routes['/jobs/71'], id:72};
      const historical = f.routes['/pipelines/52/jobs'][0];
      f.routes['/pipelines/52/jobs'].push({...historical,id:72});
      f.setOverride((path,_value,url)=>path==='/pipelines/52/jobs' && url.searchParams.get('include_retried')==='false'
        ? new Response(JSON.stringify([{...historical,id:72}]),{headers:{'content-type':'application/json'}}) : undefined);
      expect(await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal)).toBe('processed');
      const old = f.store.list('actions').find(a=>a.kind==='knowledge.host-observation' && (a.payload.observation as any).claim.kind==='ci-result')!;
      const oldAt=(old.payload.observation as any).observedAt;
      const receipts:StructuredCurrentReceipt[]=[];
      const result = await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal,{refresh:'current',onCurrentReceipt:receipt=>{receipts.push(receipt);}});
      expect(result).toBe('processed');expect(receipts).toHaveLength(1);
      expect(receipts[0]!.observedAt).toBeTruthy();
      const selected=receipts[0]!.observations.map(item=>f.store.get('actions',item.id)!.payload.observation as any);
      expect(selected.filter(o=>o.claim.kind==='ci-result').map(o=>o.claim.subject.jobId)).toEqual(['72']);
      expect(selected.some(o=>o.claim.kind==='change-head')).toBe(true);
      expect((f.store.get('actions',old.id)!.payload.observation as any).observedAt).toBe(oldAt);
    } finally { f.close(); }
  });
  it('creates current authority only from an authenticated selected read bound to the task', async () => {
    const f=repositoryKnowledgeFixture('gitlab');
    try {
      f.routes['/merge_requests/17'].sha=H;
      f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
      const task:Task={id:'context-task',projectId:f.project.id,domain:f.project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'Check',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};
      f.store.save('tasks',task);
      expect(await prepareFactualContext(f.store,undefined,task,new AbortController().signal)).toBeUndefined();
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.factual-context')).toHaveLength(0);
      expect(await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal)).toBe('processed');
      const card=f.store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      const context=await prepareFactualContext(f.store,f.reader,task,new AbortController().signal);
      expect(context).toBeDefined();
      const request={temporal:'current' as const,contextId:context!.id};
      expect(factualEligibility(f.store,card,f.project,request,context).eligible).toBe(true);
      expect(factualEligibility(f.store,card,f.project,request,{...context!,observedAt:'2000-01-01T00:00:00.000Z'})).toEqual({eligible:false,reason:'needs-current-readback'});
      f.store.save('tasks',{...task,version:2});
      expect(factualEligibility(f.store,card,f.project,request,context)).toEqual({eligible:false,reason:'needs-current-readback'});
    } finally { f.close(); }
  });
  it('does not relabel H1 or a historical same-head job when the fresh selection is absent at H2',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');
    try{
      f.routes['/merge_requests/17'].sha=H;
      const task:Task={id:'moved',projectId:f.project.id,domain:f.project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};f.store.save('tasks',task);
      expect(await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal)).toBe('processed');
      const change=f.store.list('cards').find(c=>c.claim?.claim.kind==='change-head')!,job=f.store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      f.routes['/merge_requests/17'].sha=H2;f.routes['/merge_requests/17/pipelines']=[];
      const context=await prepareFactualContext(f.store,f.reader,task,new AbortController().signal);expect(context).toBeDefined();
      for(const card of [change,job]){
        const historical=factualEligibility(f.store,card,f.project,{temporal:'historical'});expect(historical.eligible).toBe(true);
        const view=knowledgeReference(f.store,card,f.project,{request:{temporal:'current',contextId:context!.id},context})!;
        expect(view.description?.status).toBe('host-observation');expect(view.currentEvidenceGap).toBe('needs-current-readback');
        if(historical.eligible)expect(view.factual).toEqual(historical);
        expect(factualEligibility(f.store,card,f.project,{temporal:'current',contextId:context!.id},context)).toEqual({eligible:false,reason:'needs-current-readback'});
      }
    }finally{f.close();}
  });
  it('keeps a same-head historical job historical when current selection is ambiguous or unavailable',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');
    try{
      f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
      const task:Task={id:'ambiguous',projectId:f.project.id,domain:f.project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};f.store.save('tasks',task);
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);const card=f.store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      const historical=f.routes['/pipelines/52/jobs'][0];f.setOverride((path,_value,url)=>path==='/pipelines/52/jobs'&&url.searchParams.get('include_retried')==='false'?new Response(JSON.stringify([historical,{...historical,id:72}]),{headers:{'content-type':'application/json'}}):undefined);
      const context=await prepareFactualContext(f.store,f.reader,task,new AbortController().signal);expect(context).toBeDefined();
      expect(factualEligibility(f.store,card,f.project,{temporal:'historical'}).eligible).toBe(true);
      expect(factualEligibility(f.store,card,f.project,{temporal:'current',contextId:context!.id},context)).toEqual({eligible:false,reason:'needs-current-readback'});
      const before=f.store.list('actions').filter(a=>a.kind==='knowledge.factual-context').length;
      f.setOverride(path=>path===''?new Response('',{status:503}):undefined);
      expect(await prepareFactualContext(f.store,f.reader,task,new AbortController().signal)).toBeUndefined();
      expect(f.store.list('actions').filter(a=>a.kind==='knowledge.factual-context')).toHaveLength(before);
      expect(factualEligibility(f.store,card,f.project,{temporal:'historical'}).eligible).toBe(true);
    }finally{f.close();}
  });
  it('preserves canonical timestamps across identical refreshes while carrying the new read time separately',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const f=repositoryKnowledgeFixture('gitlab');
    try{
      f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
      const task:Task={id:'repeated',projectId:f.project.id,domain:f.project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};f.store.save('tasks',task);
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);
      const first=await prepareFactualContext(f.store,f.reader,task,new AbortController().signal);expect(first).toBeDefined();
      const retained=(f.store.get('actions',first!.observations[0]!.id)!.payload.observation as any).observedAt;
      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      const second=await prepareFactualContext(f.store,f.reader,task,new AbortController().signal);expect(second).toBeDefined();
      expect(second!.observations).toEqual(first!.observations);expect(second!.observedAt).not.toBe(first!.observedAt);
      const card=f.store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      const gate=factualEligibility(f.store,card,f.project,{temporal:'current',contextId:second!.id},second);
      expect(gate.eligible).toBe(true);
      if(gate.eligible)expect(gate.fact).toMatchObject({currentReadAt:'2026-01-01T00:01:00.000Z',observedAt:['2026-01-01T00:00:00.000Z']});
      expect((f.store.get('actions',first!.observations[0]!.id)!.payload.observation as any).observedAt).toBe(retained);
    }finally{f.close();vi.useRealTimers();}
  });
  it('denies copied or obsolete contexts and retracts the private context on withdrawal',async()=>{
    const f=repositoryKnowledgeFixture('gitlab');
    try{
      f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
      const task:Task={id:'revoke',projectId:f.project.id,domain:f.project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};f.store.save('tasks',task);
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);const card=f.store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      const context=await prepareFactualContext(f.store,f.reader,task,new AbortController().signal),request={temporal:'current' as const,contextId:context!.id};expect(context).toBeDefined();
      expect(factualEligibility(f.store,card,f.project,request,{...context!,id:'invented'}).eligible).toBe(false);
      f.store.save('projects',{...f.project,trustedChecks:[]});expect(factualEligibility(f.store,card,f.project,request,context).eligible).toBe(false);f.store.save('projects',f.project);
      withdrawSource(f.store,f.source.id);expect(f.store.get('actions',context!.id)?.payload).toMatchObject({retracted:true});expect(factualEligibility(f.store,card,f.project,request,context).eligible).toBe(false);
    }finally{f.close();}
  });
  it('keeps a context with ephemeral ancestry out of reopened storage',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g7-context-')),store=new Store(join(dir,'db'));
    const template=repositoryKnowledgeFixture('gitlab'),project=structuredClone(template.project);template.close();
    const f=repositoryKnowledgeFixture('gitlab',{store,project});
    try{
      const parent={...f.source,id:'temporary-parent',externalId:'temporary-parent',content:'temporary parent',retention:'ephemeral' as const};store.save('sources',parent);f.source.parentSources=[{id:parent.id,revision:parent.revision}];store.save('sources',f.source);
      f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
      const task:Task={id:'private',projectId:project.id,domain:project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};store.save('tasks',task);
      await ingestStructuredKnowledge(store,f.reader,f.source.id,new AbortController().signal);const context=await prepareFactualContext(store,f.reader,task,new AbortController().signal);expect(context).toBeDefined();expect(store.get('actions',context!.id)).toBeDefined();
      const card=store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      store.transaction(()=>invalidateSource(store,parent.id,'superseded'));
      expect(store.get('actions',context!.id)?.payload).toMatchObject({retracted:true,phase:'invalid'});
      expect(store.get('actions',context!.id)?.payload.context).toBeUndefined();
      expect(factualEligibility(store,card,project,{temporal:'current',contextId:context!.id},context).eligible).toBe(false);
      await store.backup(join(dir,'backup.db'));const backup=new Store(join(dir,'backup.db'));try{expect(backup.get('actions',context!.id)).toBeUndefined();}finally{backup.close();}
      store.close();const reopened=new Store(join(dir,'db'));try{expect(reopened.get('actions',context!.id)).toBeUndefined();}finally{reopened.close();}
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });

  it.each(['direct','dag'] as const)('keeps a sanitized context with %s temporary ancestry out of backup and restart',async mode=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g7-audit-temp-')),db=join(dir,'db'),store=new Store(db);
    const template=repositoryKnowledgeFixture('gitlab'),project=structuredClone(template.project);template.close();
    const f=repositoryKnowledgeFixture('gitlab',{store,project});
    try{
      let invalidated=f.source.id;
      if(mode==='direct'){f.source.retention='ephemeral';store.save('sources',f.source);}
      else{
        const ancestor={...f.source,id:'temp-ancestor',externalId:'temp-ancestor',retention:'ephemeral' as const,content:'PRIVATE TEMPORARY ANCESTOR'};
        const left={...f.source,id:'left-parent',externalId:'left-parent',parentSources:[{id:ancestor.id,revision:ancestor.revision}]};
        const right={...f.source,id:'right-parent',externalId:'right-parent',parentSources:[{id:ancestor.id,revision:ancestor.revision}]};
        store.save('sources',ancestor);store.save('sources',left);store.save('sources',right);
        f.source.parentSources=[{id:left.id,revision:left.revision},{id:right.id,revision:right.revision}];store.save('sources',f.source);invalidated=ancestor.id;
      }
      f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
      const task:Task={id:`private-${mode}`,projectId:project.id,domain:project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};
      store.save('tasks',task);await ingestStructuredKnowledge(store,f.reader,f.source.id,new AbortController().signal);
      const context=await prepareFactualContext(store,f.reader,task,new AbortController().signal);expect(context).toBeDefined();
      store.transaction(()=>invalidateSource(store,invalidated,'superseded'));
      const action=store.get('actions',context!.id);expect(action).toMatchObject({id:context!.id,payload:{retracted:true,phase:'invalid'}});
      store.save('actions',action!);
      const backupPath=join(dir,'backup');await store.backup(backupPath);store.close();
      for(const path of [backupPath,db]){const reopened=new Store(path);try{expect(reopened.get('actions',context!.id)).toBeUndefined();}finally{reopened.close();}}
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });

  it('keeps a dependency-valid but changed audit transition non-durable',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g7-audit-transition-')),db=join(dir,'db'),store=new Store(db);
    const template=repositoryKnowledgeFixture('gitlab'),project=structuredClone(template.project);template.close();
    const f=repositoryKnowledgeFixture('gitlab',{store,project});
    try{
      const parent={...f.source,id:'audit-transition-parent',externalId:'audit-transition-parent',revision:'parent-r1'};
      store.save('sources',parent);f.source.parentSources=[{id:parent.id,revision:parent.revision}];store.save('sources',f.source);
      f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
      const task:Task={id:'transition-audit',projectId:project.id,domain:project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};
      store.save('tasks',task);await ingestStructuredKnowledge(store,f.reader,f.source.id,new AbortController().signal);
      const context=await prepareFactualContext(store,f.reader,task,new AbortController().signal);expect(context).toBeDefined();
      store.transaction(()=>invalidateSource(store,parent.id,'superseded'));
      const action=store.get('actions',context!.id)!;expect(action.payload).toMatchObject({retracted:true,phase:'invalid'});
      const forged=structuredClone(action),payload=forged.payload as any;
      payload.contextHash=digest('changed safe identity');payload.auditHash=factualContextAuditDigest(forged,payload);
      expect(knowledgeActionDependencies(forged,store).unresolved).toBe(false);
      store.save('actions',forged);
      const backupPath=join(dir,'backup');await store.backup(backupPath);store.close();
      for(const path of [backupPath,db]){const reopened=new Store(path);try{expect(reopened.get('actions',context!.id)).toBeUndefined();}finally{reopened.close();}}
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });

  it.each(['extra-content','unknown-source','cross-scope','wrong-revision','missing-parent','wrong-task'] as const)('keeps a malformed %s context tombstone non-durable',async mode=>{
    const dir=mkdtempSync(join(tmpdir(),'patrick-g7-audit-invalid-')),db=join(dir,'db'),store=new Store(db);
    const template=repositoryKnowledgeFixture('gitlab'),project=structuredClone(template.project);template.close();
    const f=repositoryKnowledgeFixture('gitlab',{store,project});
    try{
      const grandparent={...f.source,id:'audit-grandparent',externalId:'audit-grandparent',revision:'grandparent-r1',content:'Grandparent'};
      const parent={...f.source,id:'audit-parent',externalId:'audit-parent',revision:'parent-r1',content:'Parent',parentSources:[{id:grandparent.id,revision:grandparent.revision}]};
      store.save('sources',grandparent);store.save('sources',parent);f.source.parentSources=[{id:parent.id,revision:parent.revision}];store.save('sources',f.source);
      f.routes['/merge_requests/17'].sha=H;f.routes['/merge_requests/17/pipelines']=[{id:52,sha:H}];
      const task:Task={id:'invalid-audit',projectId:project.id,domain:project.domain,sourceId:f.source.id,sourceRevision:f.source.revision,title:'Check',description:'',status:'deciding',version:1,createdAt:'',updatedAt:'',runAfter:'',attempts:0,repairCount:0,budgetUsd:10,spentUsd:0,stage:'decide'};
      store.save('tasks',task);await ingestStructuredKnowledge(store,f.reader,f.source.id,new AbortController().signal);
      const context=await prepareFactualContext(store,f.reader,task,new AbortController().signal);expect(context).toBeDefined();
      store.transaction(()=>invalidateSource(store,parent.id,'superseded'));
      const action=store.get('actions',context!.id)!;expect(action.payload).toMatchObject({retracted:true,phase:'invalid'});
      const forged=structuredClone(action),payload=forged.payload as any;
      if(mode==='extra-content')payload.privateFacts='PRIVATE FACT OR QUOTE';
      if(mode==='unknown-source')payload.sourceRefs.push({id:'unknown-source',revisionHash:digest('r')});
      if(mode==='cross-scope'){
        const foreign={...f.source,id:'foreign-source',projectId:'other-project',domain:'other-domain',parentSources:undefined};
        store.save('sources',foreign);payload.sourceRefs.push({id:foreign.id,revisionHash:digest(foreign.revision)});
      }
      if(mode==='wrong-revision')payload.sourceRefs[0].revisionHash=digest('wrong-revision');
      if(mode==='missing-parent')payload.sourceRefs=payload.sourceRefs.filter((ref:any)=>ref.id!==grandparent.id);
      if(mode==='wrong-task')forged.taskId='unknown-task';
      payload.auditHash=factualContextAuditDigest(forged,payload);
      expect(knowledgeActionDependencies(forged,store).unresolved).toBe(true);
      store.save('actions',forged);
      const backupPath=join(dir,'backup');await store.backup(backupPath);store.close();
      for(const path of [backupPath,db]){const reopened=new Store(path);try{expect(reopened.get('actions',context!.id)).toBeUndefined();}finally{reopened.close();}}
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });

  it('finds factual links through the scoped operation rather than scanning every action for each card',async()=>{
    const f=repositoryKnowledgeFixture();
    try{
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);
      const card=f.store.list('cards').find(value=>value.claim?.claim.kind==='ci-result')!;
      const original=f.store.list.bind(f.store),spy=vi.spyOn(f.store,'list').mockImplementation(((table:string)=>{if(table==='actions')throw Error('broad action scan');return original(table as 'cards');}) as typeof f.store.list);
      try{expect(factualEligibility(f.store,card,f.project,{temporal:'historical'}).eligible).toBe(true);}finally{spy.mockRestore();}
    }finally{f.close();}
  });
  it('restores scoped factual discovery after a nested transaction rollback',async()=>{
    const f=repositoryKnowledgeFixture();
    try{
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);const card=f.store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      f.store.transaction(()=>{
        expect(factualEligibility(f.store,card,f.project,{temporal:'historical'}).eligible).toBe(true);
        const link=f.store.knowledgeEvidenceActions(f.project,card.id)[0]!;
        expect(()=>f.store.transaction(()=>{f.store.delete('actions',link.id);expect(factualEligibility(f.store,card,f.project,{temporal:'historical'}).eligible).toBe(false);throw Error('rollback');})).toThrow('rollback');
        expect(factualEligibility(f.store,card,f.project,{temporal:'historical'}).eligible).toBe(true);
      });
    }finally{f.close();}
  });
  it('revalidates independent test evidence and retains a sufficient alternative after withdrawal',async()=>{
    const a=repositoryKnowledgeFixture('gitlab');
    try{
      a.project.trustedAppIds=[731,732,733];a.store.save('projects',a.project);
      const make=(run:number,job:number,producer:number)=>{
        const f=repositoryKnowledgeFixture('gitlab',{store:a.store,project:a.project});f.source={...f.source,id:`source-${job}`};
        const envelope=JSON.parse(f.source.content);envelope.checks=[{runId:String(run),jobId:String(job),checkName:'validate'}];f.source.content=JSON.stringify(envelope);f.request.checks=envelope.checks;f.request.testReportPath=reportPath;f.store.save('sources',f.source);
        f.routes[`/pipelines/${run}`]={...f.routes['/pipelines/52'],id:run,user:{id:producer}};
        f.routes[`/jobs/${job}`]={...f.routes['/jobs/71'],id:job,pipeline:{id:run,project_id:42,sha:H}};
        f.routes[`/pipelines/${run}/jobs`]=[{...f.routes['/pipelines/52/jobs'][0],id:job,pipeline:{id:run,project_id:42,sha:H}}];
        f.report.runId=String(run);f.report.jobId=String(job);f.report.checks[0]!.id=`gitlab-job:${job}`;f.routes[`/jobs/${job}/artifacts/${reportPath}`]=f.report;
        return f;
      };
      const b=make(53,72,732),c=make(54,73,733);a.request.testReportPath=reportPath;
      const observations=[];
      for(const f of [a,b,c]){const readback=await f.reader.read(f.project,f.source,f.request,new AbortController().signal);const ids=acceptRepositoryReadback(a.store,f.source.id,readback);observations.push(ids.map(id=>readHostObservation(a.store,id,a.project)!).find(o=>o.claim.kind==='test-result')!);}
      expect(observations.map(o=>o.claim)).toEqual([observations[0]!.claim,observations[0]!.claim,observations[0]!.claim]);
      const claim=observations[0]!.claim,card:KnowledgeCard={id:'atomic-test',projectId:a.project.id,domain:a.project.domain,sourceId:a.source.id,sourceRevision:a.source.revision,title:'Observed test',body:atomicClaimText(claim),quote:'Requested check',locator:a.source.locator,kind:'fact',verification:'reported',status:'active',aliases:[],createdAt:'',claim:{schemaVersion:1,claim,quote:'Requested check',interpretation:'reported'}};a.store.save('cards',card);
      linkKnowledgeEvidence(a.store,card.id,[observations[0]!.id,observations[1]!.id]);linkKnowledgeEvidence(a.store,card.id,[observations[0]!.id,observations[2]!.id]);
      expect(factualEligibility(a.store,card,a.project,{temporal:'historical'})).toMatchObject({eligible:true,fact:{basis:'independent-corroboration'}});
      withdrawSource(a.store,b.source.id);expect(factualEligibility(a.store,card,a.project,{temporal:'historical'})).toMatchObject({eligible:true,fact:{basis:'independent-corroboration'}});
      withdrawSource(a.store,c.source.id);expect(factualEligibility(a.store,card,a.project,{temporal:'historical'}).eligible).toBe(false);
    }finally{a.close();}
  });
  it('invalidates an expired or edited candidate without transferring its old link',async()=>{
    const f=repositoryKnowledgeFixture();
    try{
      await ingestStructuredKnowledge(f.store,f.reader,f.source.id,new AbortController().signal);const card=f.store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
      f.store.save('cards',{...card,expiresAt:'2000-01-01T00:00:00Z'});expect(factualEligibility(f.store,card,f.project,{temporal:'historical'})).toMatchObject({eligible:false});
      f.store.save('cards',{...card,body:card.body+' unrelated revenue prose'});expect(factualEligibility(f.store,card,f.project,{temporal:'historical'})).toMatchObject({eligible:false});
    }finally{f.close();}
  });
  it('requires strict grounds on new decisions and rejects asserted factual prose', () => {
    const base = { action: 'proceed', summary: 'Update', rationale: 'An interpretation', citations: [], ruleIds: [] };
    expect(decisionSchema.safeParse(base).success).toBe(false);
    expect(decisionSchema.safeParse({ ...base, grounds: { statements: [], facts: [{ text: 'Revenue increased' }], unresolved: [] } }).success).toBe(false);
    expect(decisionSchema.safeParse({ ...base, grounds: { statements: [], facts: [], unresolved: [] } }).success).toBe(true);
    expect(decisionSchema.safeParse({ ...base, facts:[{text:'invented'}], grounds:{statements:[],facts:[],unresolved:[]} }).success).toBe(false);
    expect(decisionSchema.safeParse({ ...base, factualContext:{id:'invented'}, grounds:{statements:[],facts:[],unresolved:[]} }).success).toBe(false);
  });
});
