import type { Scope } from './domain.js';
import type { Store } from './store.js';

export function weeklyReport(store:Store,scope:Scope,at=new Date()) {
  const since=new Date(at.getTime()-7*86400000).toISOString(),within=(v:{projectId:string;domain:string;createdAt:string})=>v.projectId===scope.projectId&&v.domain===scope.domain&&v.createdAt>=since&&v.createdAt<=at.toISOString();
  const cases=store.list('cases').filter(within).filter(c=>c.status==='active'&&store.get('sources',c.sourceId)?.status==='active'),tasks=store.list('tasks').filter(within),attempts=store.list('attempts').filter(a=>a.projectId===scope.projectId&&a.domain===scope.domain&&a.startedAt>=since),events=store.list('events').filter(within);
  const focus=cases.sort((a,b)=>Number(!!b.outcome)-Number(!!a.outcome)||b.createdAt.localeCompare(a.createdAt))[0];
  const rules=focus?store.list('rules').filter(rule=>rule.projectId===scope.projectId&&rule.domain===scope.domain&&rule.status==='active'&&rule.caseIds.includes(focus.id)):[];
  return {since,until:at.toISOString(),sampleSize:cases.length,focus:focus?{case:focus,rules,outcome:focus.outcome??null}:null,metrics:{acceptedTasks:tasks.length,deliveredTasks:tasks.filter(t=>t.status==='delivered').length,waitingForOwner:tasks.filter(t=>t.status==='awaiting_answer').length,blockedTasks:tasks.filter(t=>t.status==='blocked'||t.status==='retrying').length,workerSwitches:events.filter(e=>e.type==='worker.switched').length,reservedCostUsd:attempts.reduce((sum,a)=>sum+a.costUsd,0),maintenanceMinutes:null,missedQuestions:null,unnecessaryQuestions:null},measurementNote:'Costs are conservatively reserved per attempt, not a provider invoice. Maintenance time and missed/unnecessary questions are unknown until independently measured; no values are inferred.'};
}
