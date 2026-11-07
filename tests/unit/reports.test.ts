import { expect,it } from 'vitest';
import type { DecisionCase, DecisionSnapshot, Rule, SourceRevision } from '../../src/domain.js';
import { Store } from '../../src/store.js';
import { weeklyReport } from '../../src/reports.js';
it('uses current scoped cases and leaves unmeasured performance unknown',()=>{
  const store=new Store(':memory:');try{
    const report=weeklyReport(store,{projectId:'p',domain:'personal'},new Date('2026-11-03T00:00:00Z'));expect(report.focus).toBeNull();expect(report.sampleSize).toBe(0);expect(report.metrics.maintenanceMinutes).toBeNull();expect(report.metrics.incorrectCitations).toBe(0);
    store.save('sources',{id:'s',projectId:'other',domain:'company',kind:'manual',externalId:'x',revision:'v',title:'Private',content:'Private',locator:'private',authorId:'o',retention:'permanent',status:'active',createdAt:'2026-11-02T00:00:00Z'});
    store.save('cases',{id:'c',projectId:'other',domain:'company',taskId:'t',questionId:'q',decisionId:'d',actorId:'o',choice:'C',originalWords:'Private',rationale:'',alternatives:[],ruleIds:[],sourceId:'s',status:'active',createdAt:'2026-11-02T00:00:00Z'});
    expect(JSON.stringify(weeklyReport(store,{projectId:'p',domain:'personal'},new Date('2026-11-03T00:00:00Z')))).not.toContain('Private');
  }finally{store.close();}
});

it('shows a later recorded exception as the condition the original rules left out',()=>{
  const store=new Store(':memory:');
  const at='2026-11-02T00:00:00.000Z';
  const source:SourceRevision={id:'s',projectId:'p',domain:'personal',kind:'manual',externalId:'idea',revision:'v',title:'草稿恢复',content:'导出失败后应恢复草稿。',locator:'productIdeas/草稿.md',authorId:'owner',retention:'permanent',status:'active',createdAt:at};
  const used:Rule={id:'old',projectId:'p',domain:'personal',title:'当时的保留规则',statement:'先保留可恢复的草稿。',conditions:'仅本产品这一次导出',exceptions:'没有额外例外',version:1,kind:'principle',status:'active',caseIds:['c'],citations:[],createdAt:at,reviewAt:'2026-12-01T00:00:00.000Z'};
  const snapshot:DecisionSnapshot={schemaVersion:1,id:'snap',projectId:'p',domain:'personal',taskId:'t',taskVersion:1,attemptId:'a',inputHash:'h',sourceId:'s',sourceRevision:'v',goal:{title:'草稿恢复',description:'确定保留范围'},decision:{action:'ask',summary:'需要选择',rationale:'范围冲突',citations:[],ruleIds:['old'],expectedOutcome:null},rules:[used],sourceRefs:[{id:'s',revision:'v'}],expectedOutcome:null,recordedAt:at};
  const item:DecisionCase={id:'c',projectId:'p',domain:'personal',taskId:'t',questionId:'q',decisionId:'snap',actorId:'owner',choice:'C',originalWords:'仅本产品保留到下次成功导出。',rationale:'Owner rationale not separately stated.',alternatives:[],ruleIds:['now'],sourceId:'s',status:'active',createdAt:at,outcome:'草稿已按合并回执保留。',decisionSnapshot:snapshot};
  const current:Rule={...used,id:'now',title:'这次的保留规则',conditions:'仅本产品，直到下次成功导出',exceptions:'敏感草稿需单独确认',caseIds:['c']};
  try{
    store.save('sources',source);store.save('cases',item);store.save('rules',current);
    const lesson=weeklyReport(store,{projectId:'p',domain:'personal'},new Date('2026-11-03T00:00:00Z')).focus?.lesson;
    expect(lesson?.usedRules).toEqual([{title:'当时的保留规则',version:1,conditions:'仅本产品这一次导出'}]);
    expect(lesson?.result).toBe('草稿已按合并回执保留。');
    expect(lesson?.overlooked).toEqual(['敏感草稿需单独确认']);
    expect(lesson?.next).toBe('仅本产品，直到下次成功导出');
    expect(lesson?.disagreement).toEqual({ alignment: 'different', reason: 'unresolved', effect: 'recorded' });
  }finally{store.close();}
});
