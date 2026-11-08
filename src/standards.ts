import type { FactualUseView } from './knowledge-contract.js';
import { DomainError, caseOutputSchema, digest, now, stableId, type AppConfig, type Decision, type DecisionCase, type DecisionSnapshot, type DeliveryReceipt, type Question, type QuestionAnswer, type Rule, type SourceRevision, type Task, type WorkerInput } from './domain.js';
import { Store } from './store.js';
import { applicableOriginalPrinciple, captureOwnerCaseVersion, refreshCasesForSnapshot } from './cases.js';

export function publishObservations(store: Store, source: SourceRevision, output: unknown): Rule[] {
  const result = caseOutputSchema.parse(output); const current = store.get('sources', source.id);
  if (current?.status !== 'active' || current.revision !== source.revision) throw new DomainError('Case extraction refers to an obsolete source.', 'stale_source', 409);
  const observations = result.observations.map(candidate => saveCaseCandidate(store, source, candidate, 'observation'));
  const external = (result.externalReferences ?? []).map(candidate => saveCaseCandidate(store, source, candidate, 'external'));
  return [...observations, ...external];
}
function saveCaseCandidate(store: Store, source: SourceRevision, candidate: { title: string; statement: string; quote: string; conditions: string; exceptions: string }, kind: 'observation' | 'external'): Rule {
  if (!source.content.includes(candidate.quote)) throw new DomainError(kind === 'external' ? 'An external reference quote is absent from the source.' : 'An observation quote is absent from the source.', 'invalid_quote');
  const rule: Rule = { id: stableId(kind === 'external' ? 'external-reference' : 'observation', source.id, source.revision, candidate.title, candidate.quote), projectId: source.projectId, domain: source.domain, title: candidate.title, statement: candidate.statement, conditions: candidate.conditions, exceptions: candidate.exceptions, version: 1, kind, status: 'active', caseIds: [], citations: [{ sourceId: source.id, revision: source.revision, quote: candidate.quote, locator: source.locator }], createdAt: now(), reviewAt: new Date(Date.now() + 30 * 86400_000).toISOString() };
  if (!store.get('rules', rule.id)) store.save('rules', rule);
  return store.get('rules', rule.id) ?? rule;
}

export function frozenAnswer(question: Question, answer: QuestionAnswer): string {
  if (answer.choice === 'C') return answer.text ?? '';
  const s = question.options[answer.choice];
  return `${answer.choice} · ${s.label}\n${s.description}\nRationale: ${s.rationale}\nTradeoff: ${s.tradeoff}\nEvidence: ${s.evidenceUrls.join(', ')}${answer.text ? `\nOwner comment: ${answer.text}` : ''}`;
}

/** Keep the successful attempt's inputs, rather than resolving mutable rule IDs later. */
export function recordDecisionSnapshot(store: Store, task: Task, input: WorkerInput, decision: Decision, factualUse?: FactualUseView): DecisionSnapshot {
  const attempt = store.list('attempts').filter(a => a.taskId === task.id && a.taskVersion === task.version && a.role === 'decide' && a.status === 'succeeded').at(-1);
  if (!attempt || attempt.inputHash !== digest(input)) throw new DomainError('The judgment has no matching successful frozen attempt.', 'invalid_decision_snapshot', 409);
  const rules = [...new Set(decision.ruleIds)].map(id => {
    const frozen = input.rules.find(rule => rule.id === id), current = store.get('rules', id);
    if (!frozen || !current || digest(frozen) !== digest(current)) throw new DomainError('A used rule changed during judgment. Re-evaluate the current rules.', 'stale_rule', 409);
    return structuredClone(frozen);
  });
  const sourceRefs = [...new Map([{ id: input.source.id, revision: input.source.revision }, ...decision.citations.map(c => ({ id: c.sourceId, revision: c.revision })), ...rules.flatMap(r => r.citations.map(c => ({ id: c.sourceId, revision: c.revision }))), ...(factualUse?.facts.flatMap(f=>f.sourceRefs)??[])].map(ref => [ref.id, ref])).values()];
  const id = stableId('decision-snapshot', task.id, task.version, attempt.id);
  const existing = store.get('actions', id);
  if (existing) {
    const snapshot = existing.payload.snapshot as DecisionSnapshot | undefined;
    if (!snapshot || digest(snapshot.decision) !== digest(decision) || snapshot.inputHash !== attempt.inputHash) throw new DomainError('The judgment snapshot identifier is already occupied.', 'snapshot_conflict', 409);
    return structuredClone(snapshot);
  }
  const recordedAt = now(), reviewIntervalDays = input.project.reviewIntervalDays ?? 7;
  if (!Number.isInteger(reviewIntervalDays) || reviewIntervalDays < 1 || reviewIntervalDays > 365) throw new DomainError('Invalid project review interval.');
  const snapshot: DecisionSnapshot = { schemaVersion: 1, id, projectId: task.projectId, domain: task.domain, taskId: task.id, taskVersion: task.version, attemptId: attempt.id, inputHash: attempt.inputHash, sourceId: input.source.id, sourceRevision: input.source.revision, goal: { title: task.title, description: task.description }, decision: structuredClone(decision), ...(factualUse?{factualUse:structuredClone(factualUse)}:{}), rules, sourceRefs, expectedOutcome: decision.expectedOutcome ?? null, ...(input.research ? { research: structuredClone(input.research) } : {}), recordedAt, reviewIntervalDays, reviewAt: new Date(Date.parse(recordedAt) + reviewIntervalDays * 86400_000).toISOString() };
  store.save('actions', { id, projectId: task.projectId, domain: task.domain, taskId: task.id, kind: 'decision.snapshot', status: 'completed', payload: { snapshot }, updatedAt: snapshot.recordedAt });
  return snapshot;
}

export function appendCaseOutcome(store: Store, task: Task, receipt: DeliveryReceipt, summary: string, config?: AppConfig): void {
  for (const c of store.list('cases')) if (c.taskId === task.id && c.status === 'active') {
    const id = stableId('case-outcome', c.id, receipt.id);
    if (c.outcomes?.some(outcome => outcome.id === id)) continue;
    store.save('cases', { ...c, outcome: summary, outcomes: [...(c.outcomes ?? []), { id, receiptId: receipt.id, recordedAt: now(), summary }] });
    if (config) try { captureOwnerCaseVersion(store, config, c.id); } catch (error) { if (!(error instanceof DomainError)) throw error; }
  }
  if (config && task.decisionSnapshotId) refreshCasesForSnapshot(store, config, task.decisionSnapshotId);
}

/** Only the authenticated answer path can call this; model extraction never creates principles. */
export function recordOwnerDecision(store: Store, task: Task, question: Question, answer: QuestionAnswer): DecisionCase {
  const source = store.get('sources', task.sourceId);
  if (!source || source.status !== 'active') throw new DomainError('The question source is no longer active.', 'stale_source', 409);
  const words = frozenAnswer(question, answer); const at = now();
  const snapshotAction = question.decisionSnapshotId ? store.get('actions', question.decisionSnapshotId) : undefined;
  const snapshot = snapshotAction?.payload.snapshot as DecisionSnapshot | undefined;
  if (question.decisionSnapshotId && (!snapshot || snapshotAction?.kind !== 'decision.snapshot' || snapshot.taskId !== task.id || snapshot.taskVersion !== question.taskVersion || snapshot.projectId !== task.projectId || snapshot.domain !== task.domain || snapshot.sourceId !== task.sourceId || snapshot.sourceRevision !== task.sourceRevision)) throw new DomainError('The frozen question judgment is unavailable or out of scope.', 'invalid_decision_snapshot', 409);
  const answerSource: SourceRevision = { id: stableId('owner-answer', question.id), projectId: task.projectId, domain: task.domain, kind: 'conversation', externalId: `answer:${question.id}`, revision: digest(words), title: `Owner decision: ${question.title}`, content: words, locator: `question:${question.id}@${question.version}`, authorId: answer.actorId, retention: store.sourceRequiresTemporaryRetention(source)?'ephemeral':source.retention, status: 'active', createdAt: at };
  store.save('sources', answerSource);
  const caseId = stableId('decision-case', question.id); const ruleId = stableId('explicit-rule', question.id);
  const decisionCase: DecisionCase = { id: caseId, projectId: task.projectId, domain: task.domain, taskId: task.id, questionId: question.id, decisionId: snapshot?.id ?? stableId('decision', task.id, question.taskVersion), actorId: answer.actorId, choice: answer.choice, originalWords: words, rationale: answer.text && answer.choice !== 'C' ? answer.text : 'Owner rationale not separately stated.', alternatives: [question.options.A.description, question.options.B.description], ruleIds: [ruleId], sourceId: answerSource.id, status: 'active', createdAt: at, ...(snapshot ? { decisionSnapshot: structuredClone(snapshot) } : {}) };
  store.save('cases', decisionCase);
  const rule: Rule = { id: ruleId, projectId: task.projectId, domain: task.domain, title: question.title, statement: words, conditions: `Applies only to task ${task.id}, question ${question.id}, project ${task.projectId}, domain ${task.domain}; no broader preference is inferred.`, exceptions: 'Reconfirm after source changes or outside this decision.', version: 1, kind: 'principle', status: 'active', caseIds: [caseId], citations: [{ sourceId: answerSource.id, revision: answerSource.revision, quote: words, locator: answerSource.locator }, { sourceId: source.id, revision: source.revision, quote: source.content.slice(0, 200) || '[source metadata]', locator: source.locator }], createdAt: at, reviewAt: new Date(Date.now() + 30 * 86400_000).toISOString() };
  store.save('rules', rule);
  return decisionCase;
}

function admittedObservation(store: Store, rule: Rule): boolean {
  const saved = store.list('actions').filter(action => action.kind === 'decision.monthly-comparison' && action.projectId === rule.projectId && action.domain === rule.domain).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.payload.comparison as { trial?: string; candidateId?: string | null; reverted?: boolean } | undefined;
  return saved?.trial === 'single-product' && saved.candidateId === rule.id && !saved.reverted;
}

export function applicableRules(store: Store, task: Task, config?: import('./domain.js').AppConfig): Rule[] {
  const taskSource=store.get('sources',task.sourceId),temporaryTask=!!taskSource&&store.sourceRequiresTemporaryRetention(taskSource);
  return store.list('rules').filter(rule => {
    if (rule.projectId !== task.projectId || rule.domain !== task.domain || rule.status !== 'active' || Date.parse(rule.reviewAt) <= Date.now()) return false;
    if (!rule.citations.length || rule.citations.some(citation => {
      const source = store.get('sources', citation.sourceId);
      return source?.status !== 'active' || source.revision !== citation.revision || source.projectId !== task.projectId || source.domain !== task.domain || !temporaryTask && store.sourceRequiresTemporaryRetention(source);
    })) return false;
    if (rule.kind === 'observation') {
      const temporaryRule = rule.citations.some(citation => {
        const source = store.get('sources', citation.sourceId);
        return !!source && store.sourceRequiresTemporaryRetention(source);
      });
      return temporaryRule ? temporaryTask : admittedObservation(store, rule);
    }
    return rule.kind === 'principle' && (rule.caseIds.some(id => { const c = store.get('cases', id); return c?.status === 'active' && c.taskId === task.id; }) || !!config && applicableOriginalPrinciple(store, config, rule, task));
  });
}

/** A cited industry or expert method can be compared. It is never an owner principle. */
export function comparableExternalRules(store: Store, scope: { projectId: string; domain: string }, temporaryTask = false): Rule[] {
  return store.list('rules').filter(rule => {
    if (rule.kind !== 'external' || rule.projectId !== scope.projectId || rule.domain !== scope.domain || rule.status !== 'active' || Date.parse(rule.reviewAt) <= Date.now()) return false;
    if (!rule.citations.length) return false;
    return rule.citations.every(citation => {
      const source = store.get('sources', citation.sourceId);
      return !!source && source.status === 'active' && source.revision === citation.revision && source.projectId === rule.projectId && source.domain === rule.domain && source.content.includes(citation.quote) && (!store.sourceRequiresTemporaryRetention(source) || temporaryTask);
    });
  }).sort((a, b) => a.id.localeCompare(b.id));
}
export function externalComparisonNote(rules: Rule[]): string {
  const statements = [...new Set(rules.map(rule => rule.statement.trim()).filter(Boolean))];
  return statements.length ? `可对照的外部方法：${statements.join('；')}。这不是你的原则。` : '';
}
