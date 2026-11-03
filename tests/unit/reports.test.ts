import { expect,it } from 'vitest';
import { Store } from '../../src/store.js';
import { weeklyReport } from '../../src/reports.js';
it('uses current scoped cases and leaves unmeasured performance unknown',()=>{
  const store=new Store(':memory:');try{
    const report=weeklyReport(store,{projectId:'p',domain:'personal'},new Date('2026-11-03T00:00:00Z'));expect(report.focus).toBeNull();expect(report.sampleSize).toBe(0);expect(report.metrics.maintenanceMinutes).toBeNull();
    store.save('sources',{id:'s',projectId:'other',domain:'company',kind:'manual',externalId:'x',revision:'v',title:'Private',content:'Private',locator:'private',authorId:'o',retention:'permanent',status:'active',createdAt:'2026-11-02T00:00:00Z'});
    store.save('cases',{id:'c',projectId:'other',domain:'company',taskId:'t',questionId:'q',decisionId:'d',actorId:'o',choice:'C',originalWords:'Private',rationale:'',alternatives:[],ruleIds:[],sourceId:'s',status:'active',createdAt:'2026-11-02T00:00:00Z'});
    expect(JSON.stringify(weeklyReport(store,{projectId:'p',domain:'personal'},new Date('2026-11-03T00:00:00Z')))).not.toContain('Private');
  }finally{store.close();}
});
