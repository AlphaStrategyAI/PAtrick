import type { DecisionCase, Rule, Scope } from './domain.js';
import { classifyOwnerChoice, latestMonthlyComparison, recordedMaintenanceMinutes, slowestRecordedMaintenance, sourceExpansionPaused } from './evaluation.js';
import type { Store } from './store.js';

function weeklyLesson(store: Store, item: DecisionCase, rules: Rule[]) {
  const used = item.decisionSnapshot?.rules ?? [];
  const recorded = new Set(used.map(rule => rule.exceptions.trim()).filter(Boolean));
  const overlooked = [...new Set(rules.filter(rule => rule.kind === 'principle').map(rule => rule.exceptions.trim()).filter(text => text && !recorded.has(text)))];
  const next = (overlooked.length ? rules : used).map(rule => rule.conditions.trim()).find(Boolean) ?? (overlooked.length ? '按这次决定写明的范围判断。' : '当时没有写明额外范围，下次仍只沿用这次决定本身。');
  const result = item.outcomes?.at(-1)?.summary ?? item.outcome ?? null;
  const earlierSourceTexts = item.decisionSnapshot ? store.list('sources').filter(source => source.projectId === item.projectId && source.domain === item.domain && source.status === 'active' && source.id !== item.sourceId && source.createdAt <= item.createdAt).map(source => source.content) : [];
  return { usedRules: used.map(rule => ({ title: rule.title, version: rule.version, conditions: rule.conditions })), result, overlooked, next, disagreement: { ...classifyOwnerChoice({ choice: item.choice, words: item.originalWords, citedQuotes: item.decisionSnapshot?.decision.citations.map(citation => citation.quote) ?? [], earlierSourceTexts, exceptions: used.map(rule => rule.exceptions), hasSnapshot: !!item.decisionSnapshot }), effect: result ? 'recorded' as const : 'observing' as const } };
}

export function weeklyReport(store:Store,scope:Scope,at=new Date()) {
  const since=new Date(at.getTime()-7*86400000).toISOString(),until=at.toISOString(),within=(v:{projectId:string;domain:string;createdAt:string})=>v.projectId===scope.projectId&&v.domain===scope.domain&&v.createdAt>=since&&v.createdAt<=until;
  const cases=store.list('cases').filter(within).filter(c=>c.status==='active'&&store.get('sources',c.sourceId)?.status==='active'),tasks=store.list('tasks').filter(within).filter(task=>task.kind!=='reference_knowledge'),attempts=store.list('attempts').filter(a=>a.projectId===scope.projectId&&a.domain===scope.domain&&a.startedAt>=since),events=store.list('events').filter(within);
  const focus=cases.sort((a,b)=>Number(!!b.outcome)-Number(!!a.outcome)||b.createdAt.localeCompare(a.createdAt))[0];
  const rules=focus?store.list('rules').filter(rule=>rule.projectId===scope.projectId&&rule.domain===scope.domain&&rule.status==='active'&&rule.caseIds.includes(focus.id)):[];
  return {since,until,sampleSize:cases.length,focus:focus?{case:focus,rules,outcome:focus.outcome??null,lesson:weeklyLesson(store,focus,rules)}:null,monthly:latestMonthlyComparison(store,scope),metrics:{acceptedTasks:tasks.length,deliveredTasks:tasks.filter(t=>t.status==='delivered').length,waitingForOwner:tasks.filter(t=>t.status==='awaiting_answer').length,blockedTasks:tasks.filter(t=>t.status==='blocked'||t.status==='retrying').length,workerSwitches:events.filter(e=>e.type==='worker.switched').length,reservedCostUsd:attempts.reduce((sum,a)=>sum+a.costUsd,0),maintenanceMinutes:recordedMaintenanceMinutes(store,scope,since,until),slowestRecordedMaintenance:slowestRecordedMaintenance(store,scope,since,until),sourceExpansionPaused:sourceExpansionPaused(store,scope,at),incorrectCitations:events.filter(event=>event.type==='citation.rejected').length,missedQuestions:null,unnecessaryQuestions:null},measurementNote:'Costs are conservatively reserved per attempt, not a provider invoice. Maintenance minutes sum recorded sessions in this window and stay null when none were recorded. Incorrect citations count host rejections of quotes absent from the authorized source. Missed and unnecessary questions are not inferred. A new GitHub source pauses only after two consecutive measured weeks each exceed 60 minutes.'};
}
