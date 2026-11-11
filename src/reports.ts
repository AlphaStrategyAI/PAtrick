import type { DecisionCase, Rule, Scope } from './domain.js';
import { classifyOwnerChoice, latestMonthlyComparison, recordedMaintenanceMinutes, slowestRecordedMaintenance, sourceExpansionPaused } from './evaluation.js';
import type { Store } from './store.js';

function choiceComparison(store: Store, item: DecisionCase) {
  const earlierSourceTexts = item.decisionSnapshot ? store.list('sources').filter(source => source.projectId === item.projectId && source.domain === item.domain && source.status === 'active' && source.id !== item.sourceId && source.createdAt <= item.createdAt).map(source => source.content) : [];
  return classifyOwnerChoice({ choice: item.choice, words: item.originalWords, citedQuotes: item.decisionSnapshot?.decision.citations.map(citation => citation.quote) ?? [], earlierSourceTexts, exceptions: (item.decisionSnapshot?.rules ?? []).map(rule => rule.exceptions), hasSnapshot: !!item.decisionSnapshot });
}

function weeklyLesson(store: Store, item: DecisionCase, rules: Rule[]) {
  const used = item.decisionSnapshot?.rules ?? [];
  const recorded = new Set(used.map(rule => rule.exceptions.trim()).filter(Boolean));
  const overlooked = [...new Set(rules.filter(rule => rule.kind === 'principle').map(rule => rule.exceptions.trim()).filter(text => text && !recorded.has(text)))];
  const next = (overlooked.length ? rules : used).map(rule => rule.conditions.trim()).find(Boolean) ?? (overlooked.length ? '按这次决定写明的范围判断。' : '当时没有写明额外范围，下次仍只沿用这次决定本身。');
  const result = item.outcomes?.at(-1)?.summary ?? item.outcome ?? null;
  return { usedRules: used.map(rule => ({ title: rule.title, version: rule.version, conditions: rule.conditions })), result, overlooked, next, disagreement: { ...choiceComparison(store, item), effect: result ? 'recorded' as const : 'observing' as const } };
}

/** One recorded disagreement. A matched suggestion is not promoted into a counterexample. */
function weeklyCounterexample(store: Store, cases: DecisionCase[]) {
  const ranked = cases.flatMap(item => {
    const comparison = choiceComparison(store, item);
    if (comparison.alignment !== 'different') return [];
    const result = item.outcomes?.at(-1)?.summary ?? item.outcome ?? null;
    return [{ caseId: item.id, reason: comparison.reason, words: item.originalWords, result, createdAt: item.createdAt }];
  }).sort((a, b) => Number(!!b.result) - Number(!!a.result) || b.createdAt.localeCompare(a.createdAt));
  const chosen = ranked[0];
  return chosen ? { caseId: chosen.caseId, reason: chosen.reason, words: chosen.words, result: chosen.result } : null;
}

export function weeklyReport(store:Store,scope:Scope,at=new Date()) {
  const since=new Date(at.getTime()-7*86400000).toISOString(),until=at.toISOString(),within=(v:{projectId:string;domain:string;createdAt:string})=>v.projectId===scope.projectId&&v.domain===scope.domain&&v.createdAt>=since&&v.createdAt<=until;
  const cases=store.list('cases').filter(within).filter(c=>c.status==='active'&&store.get('sources',c.sourceId)?.status==='active'),tasks=store.list('tasks').filter(within).filter(task=>task.kind!=='reference_knowledge'),attempts=store.list('attempts').filter(a=>a.projectId===scope.projectId&&a.domain===scope.domain&&a.startedAt>=since),events=store.list('events').filter(within);
  const focus=cases.sort((a,b)=>Number(!!b.outcome)-Number(!!a.outcome)||b.createdAt.localeCompare(a.createdAt))[0];
  const rules=focus?store.list('rules').filter(rule=>rule.projectId===scope.projectId&&rule.domain===scope.domain&&rule.status==='active'&&rule.caseIds.includes(focus.id)):[];
  const snapshotted=cases.filter(item=>item.decisionSnapshot);
  const answered=store.list('questions').filter(question=>question.projectId===scope.projectId&&question.domain===scope.domain&&question.status==='answered'&&!!question.answeredAt&&question.answeredAt>=since&&question.answeredAt<=until);
  const missedQuestions=snapshotted.length?snapshotted.filter(item=>choiceComparison(store,item).reason==='missed_fact').length:null;
  const unnecessaryQuestions=answered.length?answered.filter(question=>question.answer?.choice==='A'&&question.answer.text.trim()===question.options.A.description.trim()).length:null;
  return {since,until,sampleSize:cases.length,focus:focus?{case:focus,rules,outcome:focus.outcome??null,lesson:weeklyLesson(store,focus,rules)}:null,counterexample:weeklyCounterexample(store,cases),monthly:latestMonthlyComparison(store,scope),metrics:{acceptedTasks:tasks.length,deliveredTasks:tasks.filter(t=>t.status==='delivered').length,waitingForOwner:tasks.filter(t=>t.status==='awaiting_answer').length,blockedTasks:tasks.filter(t=>t.status==='blocked'||t.status==='retrying').length,workerSwitches:events.filter(e=>e.type==='worker.switched').length,reservedCostUsd:attempts.reduce((sum,a)=>sum+a.costUsd,0),maintenanceMinutes:recordedMaintenanceMinutes(store,scope,since,until),slowestRecordedMaintenance:slowestRecordedMaintenance(store,scope,since,until),sourceExpansionPaused:sourceExpansionPaused(store,scope,at),incorrectCitations:events.filter(event=>event.type==='citation.rejected').length,missedCaptures:events.filter(event=>event.type==='source.missed').length,missedQuestions,unnecessaryQuestions},measurementNote:'Costs are conservatively reserved per attempt, not a provider invoice. Maintenance minutes sum recorded sessions in this window and stay null when none were recorded. Incorrect citations count host rejections of quotes absent from the authorized source. Missed captures count file changes a later scan found after the watcher had not reported them; the first scan is not a miss. Missed questions count snapshotted decisions whose owner words include an earlier source sentence the decision did not cite, and stay null when the week has no snapshot. Unnecessary questions count answered questions whose choice is the frozen suggestion A with no added words, and stay null when the week has no answered question. The counterexample is one recorded disagreement, preferring one with an observed result; a matched suggestion is not used. A new GitHub source pauses only after two consecutive measured weeks each exceed 60 minutes.'};
}
