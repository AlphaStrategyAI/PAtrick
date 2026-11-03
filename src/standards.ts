import { DomainError, caseOutputSchema, digest, now, stableId, type DecisionCase, type Question, type QuestionAnswer, type Rule, type SourceRevision, type Task } from './domain.js';
import { Store } from './store.js';

export function publishObservations(store: Store, source: SourceRevision, output: unknown): Rule[] {
  const result = caseOutputSchema.parse(output); const current = store.get('sources', source.id);
  if (current?.status !== 'active' || current.revision !== source.revision) throw new DomainError('Case extraction refers to an obsolete source.', 'stale_source', 409);
  return result.observations.map(candidate => {
    if (!source.content.includes(candidate.quote)) throw new DomainError('An observation quote is absent from the source.', 'invalid_quote');
    const rule: Rule = { id: stableId('observation', source.id, source.revision, candidate.title, candidate.quote), projectId: source.projectId, domain: source.domain, title: candidate.title, statement: candidate.statement, conditions: candidate.conditions, exceptions: candidate.exceptions, version: 1, kind: 'observation', status: 'active', caseIds: [], citations: [{ sourceId: source.id, revision: source.revision, quote: candidate.quote, locator: source.locator }], createdAt: now(), reviewAt: new Date(Date.now() + 30 * 86400_000).toISOString() };
    if (!store.get('rules', rule.id)) store.save('rules', rule);
    return rule;
  });
}

export function frozenAnswer(question: Question, answer: QuestionAnswer): string {
  if (answer.choice === 'C') return answer.text ?? '';
  const s = question.options[answer.choice];
  return `${answer.choice} · ${s.label}\n${s.description}\nRationale: ${s.rationale}\nTradeoff: ${s.tradeoff}\nEvidence: ${s.evidenceUrls.join(', ')}${answer.text ? `\nOwner comment: ${answer.text}` : ''}`;
}

/** Only the authenticated answer path can call this; model extraction never creates principles. */
export function recordOwnerDecision(store: Store, task: Task, question: Question, answer: QuestionAnswer): DecisionCase {
  const source = store.get('sources', task.sourceId);
  if (!source || source.status !== 'active') throw new DomainError('The question source is no longer active.', 'stale_source', 409);
  const words = frozenAnswer(question, answer); const at = now();
  const answerSource: SourceRevision = { id: stableId('owner-answer', question.id), projectId: task.projectId, domain: task.domain, kind: 'conversation', externalId: `answer:${question.id}`, revision: digest(words), title: `Owner decision: ${question.title}`, content: words, locator: `question:${question.id}@${question.version}`, authorId: answer.actorId, retention: source.retention, status: 'active', createdAt: at };
  store.save('sources', answerSource);
  const caseId = stableId('decision-case', question.id); const ruleId = stableId('explicit-rule', question.id);
  const decisionCase: DecisionCase = { id: caseId, projectId: task.projectId, domain: task.domain, taskId: task.id, questionId: question.id, decisionId: stableId('decision', task.id, question.taskVersion), actorId: answer.actorId, choice: answer.choice, originalWords: words, rationale: answer.text && answer.choice !== 'C' ? answer.text : 'Owner rationale not separately stated.', alternatives: [question.options.A.description, question.options.B.description], ruleIds: [ruleId], sourceId: answerSource.id, status: 'active', createdAt: at };
  store.save('cases', decisionCase);
  const rule: Rule = { id: ruleId, projectId: task.projectId, domain: task.domain, title: question.title, statement: words, conditions: `Applies only to task ${task.id}, question ${question.id}, project ${task.projectId}, domain ${task.domain}; no broader preference is inferred.`, exceptions: 'Reconfirm after source changes or outside this decision.', version: 1, kind: 'principle', status: 'active', caseIds: [caseId], citations: [{ sourceId: answerSource.id, revision: answerSource.revision, quote: words, locator: answerSource.locator }, { sourceId: source.id, revision: source.revision, quote: source.content.slice(0, 200) || '[source metadata]', locator: source.locator }], createdAt: at, reviewAt: new Date(Date.now() + 30 * 86400_000).toISOString() };
  store.save('rules', rule);
  return decisionCase;
}

export function applicableRules(store: Store, task: Task): Rule[] {
  return store.list('rules').filter(rule => {
    if (rule.projectId !== task.projectId || rule.domain !== task.domain || rule.status !== 'active' || Date.parse(rule.reviewAt) <= Date.now()) return false;
    if (!rule.citations.length || rule.citations.some(citation => {
      const source = store.get('sources', citation.sourceId);
      return source?.status !== 'active' || source.revision !== citation.revision || source.projectId !== task.projectId || source.domain !== task.domain;
    })) return false;
    return rule.kind !== 'principle' || rule.caseIds.some(id => { const c = store.get('cases', id); return c?.status === 'active' && c.taskId === task.id; });
  });
}
