import { expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { Workbench } from '../../src/orchestrator.js';
import { readConfig } from '../../src/config.js';
import { configureDemo, demoResearch, demoWriter } from '../../src/demo.js';
import { now, type WorkerInput } from '../../src/domain.js';
it('retrieves a newer relevant card after more than thirty unrelated cards without crossing scope',async()=>{
  const store=new Store(':memory:'),config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);const project=config.projects[0]!;let decisionInput:WorkerInput|undefined;
  const engine=new Workbench({store,config,writer:demoWriter,research:demoResearch,workers:[{name:'grok',async run(input){if(input.role==='decide')decisionInput=input;return {output:input.role==='knowledge_extract'?{cards:[]}:input.role==='case_extract'?{observations:[]}:{action:'archive',summary:'Await more evidence',rationale:'This is a retrieval probe',citations:[],ruleIds:[]},model:'grok-demo',provider:'xai',costUsd:0.005};}}]});
  try{
    for(let i=0;i<37;i++){
      const id=`s${i}`,foreign=i===36,scope={projectId:foreign?'other':project.id,domain:foreign?'company':project.domain},text=i>=35?'草稿恢复约束':'unrelated previous material';
      store.save('sources',{id,...scope,kind:'manual',externalId:id,revision:'v1',title:text,content:text,locator:id,authorId:'owner',retention:'permanent',status:'active',createdAt:now()});
      store.save('cards',{id:`c${i}`,...scope,sourceId:id,sourceRevision:'v1',title:text,body:text,quote:text,locator:id,kind:'fact',verification:'reported',status:'active',aliases:[],createdAt:now()});
    }
    engine.ingest({projectId:project.id,externalId:'retrieval-task',title:'草稿恢复约束',content:'核对已有草稿恢复约束。'});await engine.runUntilIdle();
    expect(decisionInput?.cards.some(card=>card.id==='c35')).toBe(true);expect(decisionInput?.cards.some(card=>card.id==='c36')).toBe(false);expect(decisionInput?.cards.length).toBeLessThanOrEqual(30);
  }finally{store.close();}
});
