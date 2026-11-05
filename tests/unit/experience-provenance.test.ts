import { expect, it } from 'vitest';
import * as workers from '../../src/integrations/workers.js';
import { recordLocalTests } from '../../src/experience-observations.js';
import { assertPlanBinding, testsRecorded } from '../../src/execution-contract.js';
import { makeBillingFixture } from '../fixtures/billing.js';
import { executionPlanSchema } from '../../src/domain.js';

it('does not accept shaped or copied results as private execution provenance',()=>{
 const result={output:{tests:[{command:'true',passed:true,output:'model'}]},costUsd:0,provider:'fake',model:'fake',hostTests:{runId:'forged'}};
 expect((workers as any).takeHostTestRun?.(result)).toBeUndefined();
 expect(typeof (workers as any).takeHostTestRun).toBe('function');
});

it('cannot record freely shaped or copied hostTests through the canonical writer',()=>{
 const f=makeBillingFixture();try{
  expect(recordLocalTests(f.store,'fake-attempt',f.input,{output:{},costUsd:0,provider:'fake',model:'fake',hostTests:{runId:'claimed'}} as any,{})).toBeUndefined();
  expect(f.store.list('actions').filter(a=>a.kind==='experience.test-observation')).toEqual([]);
 }finally{f.dispose();}
});

it('keeps optional test declarations safe/unique/authorized without granting materialization',()=>{
 const f=makeBillingFixture();try{
  const plan={taskVersion:1,sourceRevision:f.source.revision,baselineSha:'base',summary:'test',paths:[f.project.prdPath],steps:['write'],tests:['true'],stopConditions:['stop']};
  expect(executionPlanSchema.parse(plan).testFiles).toBeUndefined();
  for(const testFiles of [['../secret'],['docs/test.js','docs/test.js'],Array.from({length:129},(_,i)=>'docs/'+i)])expect(executionPlanSchema.safeParse({...plan,testFiles}).success).toBe(false);
  expect(()=>assertPlanBinding({...f.task,plan:{...plan,testFiles:['foreign/test.js']}},f.project)).toThrow();
  expect(()=>assertPlanBinding({...f.task,plan:{...plan,testFiles:['docs/not-materialized.js']}},f.project)).not.toThrow();
  expect(f.input.baselineFiles).toBeUndefined();
 }finally{f.dispose();}
});

it('preserves exact command occurrence and nonempty actual output meaning',()=>{
 expect(testsRecorded(['true'],[{command:'true',passed:false,output:'exit 23'}])).toBe(true);
 expect(testsRecorded(['true'],[{command:'true',passed:true,output:''}])).toBe(false);
 expect(testsRecorded(['true'],[{command:'true',passed:true,output:'exit 0'},{command:'true',passed:true,output:'exit 0'}])).toBe(false);
});
