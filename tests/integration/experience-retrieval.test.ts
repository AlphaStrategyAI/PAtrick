import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BillingAuthority } from '../../src/billing.js';
import { createApp } from '../../src/app.js';
import { demoResearch, demoWriter } from '../../src/demo.js';
import { ingestSource } from '../../src/intake.js';
import { Workbench } from '../../src/orchestrator.js';
import { tokenize, type WorkerAdapter, type WorkerInput } from '../../src/domain.js';
import { ingestStructuredExperience } from '../../src/integrations/experience-ci.js';
import { repositoryKnowledgeFixture, H, reportPath } from '../fixtures/repository-knowledge.js';
import { makeBillingFixture } from '../fixtures/billing.js';

it('finds two independently admitted histories by their problem and explicit alias', async () => {
  const billingFixture=makeBillingFixture(),store=billingFixture.store;
  const project={...billingFixture.project,repository:'owner/repo',repositoryProvider:'gitlab' as const,trustedChecks:['validate'],trustedAppIds:[731]};
  store.save('projects',project);billingFixture.config.projects=[project];billingFixture.config.ownerId=project.ownerId;
  const seed=repositoryKnowledgeFixture('gitlab',{store,project});
  try {
    const histories=[
      {id:'configuration',problem:'配置文件找不到',alias:'启动报错找不到配置',file:'docs/config.test.ts',command:'test configuration lookup',solution:'检查配置文件路径'},
      {id:'pagination',problem:'分页重复记录',alias:'翻页后出现重复数据',file:'docs/pagination.test.ts',command:'test pagination cursor',solution:'修正分页游标'},
    ];
    for(const [index,history] of histories.entries()){
      const fixture=repositoryKnowledgeFixture('gitlab',{store,project,path:history.file,command:history.command});
      const runId=index?'53':'52',jobId=index?'72':'71';
      if(index){
        fixture.routes['/pipelines/53']={...fixture.routes['/pipelines/52'],id:53,web_url:'https://gitlab.test/owner/repo/-/pipelines/53'};
        fixture.routes['/jobs/72']={...fixture.routes['/jobs/71'],id:72,pipeline:{id:53,project_id:42,sha:H},web_url:'https://gitlab.test/owner/repo/-/jobs/72'};
        fixture.routes['/pipelines/53/jobs']=[{id:72,name:'validate',pipeline:{id:53,project_id:42,sha:H},commit:{id:H}}];
        fixture.routes[`/jobs/72/artifacts/${reportPath}`]={...fixture.report,runId,jobId,checks:fixture.report.checks.map(check=>({...check,id:'gitlab-job:72'}))};
      }
      const content=JSON.stringify({schemaVersion:1,quote:`Reported ${history.id}`,details:{schemaVersion:1,problem:history.problem,symptomAliases:[history.alias],solution:history.solution,files:[history.file],productId:project.id,codeVersion:H,environment:'reported',invalidationConditions:['changed']},repository:project.repository,headSha:H,runId,jobId,checkIds:['validate'],testReportPath:reportPath});
      ingestSource(store,{projects:[project]},{projectId:project.id,externalId:history.id,title:history.problem,content,purpose:'reference'});
      const source=store.list('sources').find(s=>s.externalId===history.id)!;
      const admitted=await ingestStructuredExperience(store,fixture.reader,source.id,new AbortController().signal);
      expect(admitted,JSON.stringify({id:history.id,requests:fixture.requests.map(r=>r.url.pathname),jobs:store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest'&&a.payload.sourceId===source.id)})).toBe(true);
      fixture.close();
    }
    for(const history of histories){
      const problem=store.searchCards(history.problem,project).find(c=>c.kind==='experience');
      const alias=store.searchCards(history.alias,project).find(c=>c.kind==='experience');
      expect(problem?.id).toBeTruthy();expect(alias?.id).toBe(problem?.id);
      expect(alias?.experienceReference?.reportedSolution.text).toBe(history.solution);
      expect(alias?.experienceReference?.observed[0]?.checks[0]).toMatchObject({command:history.command,testFile:history.file,result:'success'});
    }
    const first=histories[0]!,eligible=store.searchCards(first.alias,project).find(c=>c.kind==='experience')!;
    const pendingIds:string[]=[];
    for(let index=0;index<35;index++){
      const content=JSON.stringify({schemaVersion:1,quote:`Pending report ${index}`,details:{schemaVersion:1,problem:first.alias,symptomAliases:[first.alias],solution:`Unverified ${index}`,files:[`docs/pending-${index}.ts`],productId:project.id,codeVersion:H,environment:'unverified tool/model',invalidationConditions:['changed']},repository:project.repository,headSha:H,runId:'52',jobId:'71',checkIds:['validate'],testReportPath:reportPath});
      ingestSource(store,{projects:[project]},{projectId:project.id,externalId:`pending-${index}`,title:first.alias,content,purpose:'reference'});
      const source=store.list('sources').find(s=>s.externalId===`pending-${index}`)!;
      expect(await ingestStructuredExperience(store,undefined,source.id,new AbortController().signal)).toBe(false);
      pendingIds.push(store.list('cards').find(card=>card.sourceId===source.id&&card.kind==='experience')!.id);
    }
    const query=[...new Set(tokenize(first.alias).split(' '))].map(term=>`"${term}"`).join(' OR ');
    const db=(store as unknown as {db:import('better-sqlite3').Database}).db;
    const ranked=db.prepare('SELECT id FROM cards_fts WHERE cards_fts MATCH ? AND project_id = ? AND domain = ? ORDER BY bm25(cards_fts), id LIMIT 100').all(query,project.id,project.domain) as {id:string}[];
    const position=ranked.findIndex(row=>row.id===eligible.id);expect(position).toBeGreaterThan(30);
    expect(ranked.slice(0,position).filter(row=>pendingIds.includes(row.id)).length).toBeGreaterThan(30);
    expect(store.searchCards(first.alias,project,1).map(card=>card.id)).toEqual([eligible.id]);
    const browse=store.searchCards(first.alias,project,100,{usage:'browse'});
    const firstPending=browse.find(card=>card.id===pendingIds[0]);
    expect(firstPending).toMatchObject({id:pendingIds[0],description:{status:'reported-summary'},experienceState:{state:'pending'},experience:{solution:'Unverified 0'}});
    expect(browse.filter(card=>pendingIds.includes(card.id)).every(card=>card.experienceState?.state==='pending')).toBe(true);
    const temporaryHistory={id:'temporary-history',problem:'临时缓存无法恢复',alias:'临时状态恢复失败',file:'docs/temporary-history.test.ts',command:'test temporary history',solution:'检查临时状态'};
    const temporaryFixture=repositoryKnowledgeFixture('gitlab',{store,project,path:temporaryHistory.file,command:temporaryHistory.command});
    temporaryFixture.routes['/pipelines/54']={...temporaryFixture.routes['/pipelines/52'],id:54,web_url:'https://gitlab.test/owner/repo/-/pipelines/54'};
    temporaryFixture.routes['/jobs/73']={...temporaryFixture.routes['/jobs/71'],id:73,pipeline:{id:54,project_id:42,sha:H},web_url:'https://gitlab.test/owner/repo/-/jobs/73'};
    temporaryFixture.routes['/pipelines/54/jobs']=[{id:73,name:'validate',pipeline:{id:54,project_id:42,sha:H},commit:{id:H}}];
    temporaryFixture.routes[`/jobs/73/artifacts/${reportPath}`]={...temporaryFixture.report,runId:'54',jobId:'73',checks:temporaryFixture.report.checks.map(check=>({...check,id:'gitlab-job:73'}))};
    const temporaryContent=JSON.stringify({schemaVersion:1,quote:'TEMPORARY_SEARCH_PRIVATE_SENTINEL',details:{schemaVersion:1,problem:temporaryHistory.problem,symptomAliases:[temporaryHistory.alias],solution:temporaryHistory.solution,files:[temporaryHistory.file],productId:project.id,codeVersion:H,environment:'temporary',invalidationConditions:['changed']},repository:project.repository,headSha:H,runId:'54',jobId:'73',checkIds:['validate'],testReportPath:reportPath});
    ingestSource(store,{projects:[project]},{projectId:project.id,externalId:temporaryHistory.id,title:temporaryHistory.problem,content:temporaryContent,retention:'ephemeral',purpose:'reference'});
    const temporarySource=store.list('sources').find(source=>source.externalId===temporaryHistory.id)!;
    expect(await ingestStructuredExperience(store,temporaryFixture.reader,temporarySource.id,new AbortController().signal)).toBe(true);temporaryFixture.close();
    const temporaryCard=store.list('cards').find(card=>card.sourceId===temporarySource.id&&card.kind==='experience')!;
    expect(store.searchCards(temporaryHistory.problem,project).some(card=>card.id===temporaryCard.id)).toBe(true);
    expect(store.searchCards(temporaryHistory.alias,project).find(card=>card.id===temporaryCard.id)?.experienceReference?.reportedSolution.text).toBe(temporaryHistory.solution);
    expect(JSON.stringify(db.prepare('SELECT terms FROM cards_fts').all())).not.toContain(tokenize(temporaryHistory.alias));
    const genuine=store.get('cards',eligible.id)!;
    store.save('cards',{...genuine,id:'forged-copy',verification:'verified'});
    store.save('cards',{...genuine,id:'expired-copy',expiresAt:'2000-01-01T00:00:00Z'});
    expect(store.searchCards(first.alias,project,100).some(card=>['forged-copy','expired-copy'].includes(card.id))).toBe(false);
    expect(store.searchCards(first.alias,project,100,{usage:'browse'}).find(card=>card.id==='forged-copy')?.experienceState?.state).toBe('pending');
    expect(store.searchCards(first.alias,{projectId:'wrong',domain:project.domain})).toEqual([]);
    expect(store.searchCards(first.alias,{projectId:project.id,domain:'wrong'})).toEqual([]);
    const config=billingFixture.config;config.host='owner-only.invalid';config.authToken='synthetic-local-test-token';
    const seen:WorkerInput[]=[];
    const worker:WorkerAdapter={name:'codex',async run(input){seen.push(structuredClone(input));return {output:{cards:[]},costUsd:0,provider:billingFixture.included.provider,model:billingFixture.included.model};}};
    const billing=new BillingAuthority(store,config,billingFixture.currentProvider,{proofRoot:billingFixture.proofRoot,now:billingFixture.now});
    const engine=new Workbench({store,config,workers:[worker],billing,writer:demoWriter,research:demoResearch});
    const app=createApp({store,config,engine}),listener=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
    const childDir=mkdtempSync(join(tmpdir(),'g8-mcp-client-'));let client:Client|undefined;
    try{
      if(!listener.listening)await once(listener,'listening');
      const base=`http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
      const unauthenticated=await fetch(`${base}/api/lookup?project=${project.id}&domain=${project.domain}&q=x`);expect(unauthenticated.status).toBe(401);
      const transport=new StdioClientTransport({command:process.execPath,args:['--import',createRequire(import.meta.url).resolve('tsx'),fileURLToPath(new URL('../../src/mcp.ts',import.meta.url))],cwd:childDir,env:{PATH:process.env.PATH??'',PATRICK_URL:base,PATRICK_TOKEN:config.authToken,PATRICK_MCP_PROJECT:project.id,PATRICK_MCP_DOMAIN:project.domain},stderr:'pipe'});
      client=new Client({name:'g8-integration-client',version:'1.0.0'});await client.connect(transport);
      for(const history of [...histories,temporaryHistory]){
        const expected=store.searchCards(history.alias,project).find(c=>c.kind==='experience')!;
        for(const query of [history.problem,history.alias]){
          const url=`${base}/api/lookup?project=${encodeURIComponent(project.id)}&domain=${encodeURIComponent(project.domain)}&q=${encodeURIComponent(query)}`;
          const response=await fetch(url,{headers:{Authorization:`Bearer ${config.authToken}`}});expect(response.status).toBe(200);
          const http=await response.json() as {cards:{id:string}[]};expect(http.cards.some(card=>card.id===expected.id)).toBe(true);
          const result=await client.callTool({name:'lookup',arguments:{query}}) as {isError?:boolean;content:{type:string;text:string}[]};
          expect(result.isError).not.toBe(true);const mcp=JSON.parse(result.content[0]!.text) as {cards:{id:string}[]};expect(mcp.cards.some(card=>card.id===expected.id)).toBe(true);
        }
        const task=engine.ingest({projectId:project.id,externalId:`next-${history.id}`,title:history.alias,content:history.alias,purpose:'task'})!;
        await engine.tick(task.id);
        const input=seen.find(value=>value.task.id===task.id);expect(input?.cards.some(card=>card.id===expected.id)).toBe(true);
        expect(store.get('tasks',task.id)?.spentUsd).toBe(0);
      }
      const originalCard=store.get('cards',eligible.id)!;
      store.save('cards',{...originalCard,experience:{...originalCard.experience!,solution:'Edited without a new link'}});
      expect(store.searchCards(first.alias,project).some(card=>card.id===eligible.id)).toBe(false);
      store.save('cards',originalCard);
      const originalSource=store.get('sources',eligible.sourceId)!;store.save('sources',{...originalSource,content:`${originalSource.content} changed`});
      expect(store.searchCards(first.alias,project).some(card=>card.id===eligible.id)).toBe(false);
      engine.withdraw(eligible.sourceId);
      const withdrawn=store.get('cards',eligible.id)!;
      expect(withdrawn).toMatchObject({status:'withdrawn',title:'[withdrawn]',body:'',quote:'',aliases:[]});expect(withdrawn.experience).toBeUndefined();
      expect(db.prepare('SELECT id FROM cards_fts WHERE id = ?').get(eligible.id)).toBeUndefined();
      for(const marker of [first.solution,first.file,first.command])expect(JSON.stringify(['sources','cards','actions','tasks'].flatMap(table=>store.list(table as 'sources')))).not.toContain(marker);
      const after=await fetch(`${base}/api/lookup?project=${project.id}&domain=${project.domain}&q=${encodeURIComponent(first.alias)}`,{headers:{Authorization:`Bearer ${config.authToken}`}});
      expect(JSON.stringify(await after.json())).not.toContain(eligible.id);
      const mcpAfter=await client.callTool({name:'lookup',arguments:{query:first.alias}});expect(JSON.stringify(mcpAfter)).not.toContain(eligible.id);
      const page=await fetch(`${base}/knowledge?project=${project.id}`,{headers:{Authorization:`Bearer ${config.authToken}`}});expect(await page.text()).not.toContain(first.solution);
      const next=engine.ingest({projectId:project.id,externalId:'after-withdrawal',title:first.alias,content:first.alias,purpose:'task'})!;await engine.tick(next.id);
      expect(seen.find(input=>input.task.id===next.id)?.cards.some(card=>card.id===eligible.id)).toBe(false);
      expect(store.searchCards(histories[1]!.alias,project).some(card=>card.kind==='experience')).toBe(true);
      store.save('cards',{...temporaryCard,expiresAt:'2000-01-01T00:00:00Z'});
      expect(store.searchCards(temporaryHistory.alias,project).some(card=>card.id===temporaryCard.id)).toBe(false);
      engine.withdraw(temporarySource.id);expect(store.searchCards(temporaryHistory.alias,project)).toEqual([]);
    }finally{
      await client?.close();if(listener.listening)await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));await engine.shutdown();rmSync(childDir,{recursive:true,force:true});
    }
  } finally {seed.close();billingFixture.dispose();}
});
