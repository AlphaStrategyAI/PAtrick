import { DomainError, digest, now, stableId, type AppConfig, type DecisionSnapshot, type Question, type Rule, type Scope, type SourceRevision } from './domain.js';
import { publicError } from './readiness.js';
import { caseMentionSchema, type CanonicalCaseVersion, type CaseMention, type CaseRef, type OriginalOwnerDecision, type OwnerOriginRef, type RuleHistory, type SourceRef } from './case-contract.js';
import { historicalSnapshot } from './intake.js';
import { knowledgeSourceRefs } from './knowledge-records.js';
import type { Store } from './store.js';

type SemanticCase = Omit<CanonicalCaseVersion, 'version' | 'hash' | 'recordedAt'>;
type FragmentBinding = { sourceId: string; revision: string; locator: string; start: number; end: number };
const sameScope = (a: Scope, b: Scope) => a.projectId === b.projectId && a.domain === b.domain;
function caseHash(value: CanonicalCaseVersion | SemanticCase): string {
  const { version: _version, hash: _hash, recordedAt: _recordedAt, ...body } = value as CanonicalCaseVersion;
  return digest(body);
}
function currentRefs(store: Store, scope: Scope, requested: SourceRef[]): SourceRef[] {
  const all = new Map<string, SourceRef>();
  for (const ref of requested) {
    const source = store.get('sources', ref.id), refs = knowledgeSourceRefs(store, ref.id, scope);
    if (!source || source.status !== 'active' || source.revision !== ref.revision || !refs || !source.content || store.get('cursors', stableId('source-hash', source.id))?.value && store.get('cursors', stableId('source-hash', source.id))!.value !== digest(source.content)) throw new DomainError('Case source is unavailable or obsolete.', 'stale_source', 409);
    for (const item of refs) all.set(item.id, item);
  }
  return [...all.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function retainedSnapshot(store: Store, id: string, scope: Scope): DecisionSnapshot | undefined {
  const action = store.get('actions', id), snapshot = action && historicalSnapshot(store, action, scope), attempt = snapshot && store.get('attempts', snapshot.attemptId);
  if (!snapshot || !snapshot.decision || !Array.isArray(snapshot.decision.citations) || !Array.isArray(snapshot.rules) || !Array.isArray(snapshot.sourceRefs) || typeof snapshot.decision.summary !== 'string' || typeof snapshot.decision.rationale !== 'string' || !Number.isFinite(Date.parse(snapshot.recordedAt)) || !attempt || attempt.status !== 'succeeded' || attempt.role !== 'decide' || attempt.taskId !== snapshot.taskId || attempt.taskVersion !== snapshot.taskVersion || attempt.inputHash !== snapshot.inputHash || !sameScope(attempt, scope)) return;
  return snapshot;
}
function frozenSnapshot(snapshot: DecisionSnapshot): NonNullable<CanonicalCaseVersion['frozenJudgment']> {
  return { id: snapshot.id, taskVersion: snapshot.taskVersion, inputHash: snapshot.inputHash, decision: structuredClone(snapshot.decision), rules: structuredClone(snapshot.rules), expectedOutcome: snapshot.expectedOutcome, recordedAt: snapshot.recordedAt };
}
function questionMatchesSnapshot(question: Question, snapshot: DecisionSnapshot): boolean {
  const body = snapshot.decision.question;
  return snapshot.decision.action === 'ask' && !!body && question.id === stableId('question', question.taskId, question.taskVersion, question.version) && snapshot.taskId === question.taskId && snapshot.taskVersion === question.taskVersion && question.title === body.title && question.context === body.context && digest(question.options) === digest({ A: body.A, B: body.B }) && !!snapshot.research && digest(question.research) === digest(snapshot.research);
}
function validFrozenAnswer(question: Question): boolean {
  const answer = question.answer;
  if (!answer || !answer.text.trim()) return false;
  if (answer.choice === 'C') return true;
  const selected = question.options[answer.choice];
  const base = `${answer.choice} · ${selected.label}\n${selected.description}\nRationale: ${selected.rationale}\nTradeoff: ${selected.tradeoff}\nEvidence: ${selected.evidenceUrls.join(', ')}`;
  return answer.text === base || answer.text.startsWith(`${base}\nOwner comment: `);
}
function snapshotObservations(store: Store, snapshot: DecisionSnapshot, at: Date): { refs: CanonicalCaseVersion['observationRefs']; sources: SourceRef[] } {
  const refs: CanonicalCaseVersion['observationRefs'] = [], sources: SourceRef[] = [];
  for (const action of store.list('actions')) {
    if (!sameScope(action, snapshot) || action.taskId !== snapshot.taskId || action.status !== 'completed') continue;
    if (action.kind === 'decision.evidence') {
      const e = action.payload.evidence as { id: string; snapshotId: string; taskId: string; actorId: string; kind: string; sourceId: string; sourceRevision: string; quote: string; observedAt: string; recordedAt: string; attribution: { citations: { sourceId: string; revision: string; quote: string; locator: string }[] } } | undefined;
      const project = store.get('projects', snapshot.projectId), source = e && store.get('sources', e.sourceId);
      if (!e || !project || e.snapshotId !== snapshot.id || e.taskId !== snapshot.taskId || e.actorId !== project.ownerId || e.id !== action.id || e.id !== stableId('decision-evidence', snapshot.id, e.kind, e.sourceId, e.sourceRevision, digest(e.quote)) || !source || !sameScope(source, snapshot) || source.revision !== e.sourceRevision || !source.content.includes(e.quote) || !e.quote.trim() || !e.attribution || !Array.isArray(e.attribution.citations) || !Number.isFinite(Date.parse(e.observedAt)) || !Number.isFinite(Date.parse(e.recordedAt)) || Date.parse(e.observedAt) > +at || Date.parse(e.recordedAt) > +at || Date.parse(e.observedAt) < Date.parse(snapshot.recordedAt)) continue;
      if (e.attribution.citations.some(c => { const s = store.get('sources', c.sourceId); return !s || !sameScope(s, snapshot) || s.revision !== c.revision || s.locator !== c.locator || !c.quote.trim() || !s.content.includes(c.quote); })) continue;
      const evidenceSources = [{ id: e.sourceId, revision: e.sourceRevision }, ...e.attribution.citations.map(c => ({ id: c.sourceId, revision: c.revision }))];
      try { currentRefs(store, snapshot, evidenceSources); } catch (error) { if (!(error instanceof DomainError) || error.code !== 'stale_source') throw error; continue; }
      const { recordedAt: _recordedAt, ...semantic } = e;
      refs.push({ kind: 'outcome-evidence', id: e.id, hash: digest(semantic) }); sources.push(...evidenceSources);
    } else if (action.kind === 'decision.tests') {
      const value = action.payload.testObservation as { snapshotId: string; taskVersion: number; attemptId: string; inputHash: string; stage: 'execute' | 'check'; tests: { passed: boolean }[]; recordedAt: string } | undefined;
      const attempt = value && store.get('attempts', value.attemptId);
      if (!value || value.snapshotId !== snapshot.id || !attempt || !sameScope(attempt, snapshot) || attempt.status !== 'succeeded' || attempt.taskId !== snapshot.taskId || attempt.taskVersion !== value.taskVersion || attempt.role !== value.stage || attempt.inputHash !== value.inputHash || action.id !== stableId('planned-test-observation', snapshot.id, value.taskVersion, value.attemptId, value.stage) || !Array.isArray(value.tests) || !value.tests.length || value.tests.some(test => test.passed !== false) || !Number.isFinite(Date.parse(value.recordedAt)) || Date.parse(value.recordedAt) > +at) continue;
      const { recordedAt: _recordedAt, ...semantic } = value;
      refs.push({ kind: 'planned-test', id: action.id, hash: digest(semantic) });
    }
  }
  refs.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { refs, sources };
}
function relatedQuestionSnapshots(store: Store, question: Question, original: DecisionSnapshot | undefined): DecisionSnapshot[] {
  const result = original ? [original] : [];
  const actions = store.list('actions'), positions = new Map(actions.map((action, index) => [action.id, index]));
  for (const action of actions) {
    if (action.kind !== 'decision.snapshot' || action.taskId !== question.taskId || !sameScope(action, question) || action.id === original?.id) continue;
    const snapshot = retainedSnapshot(store, action.id, question);
    if (!snapshot || snapshot.taskVersion <= question.taskVersion || snapshot.decision.action === 'ask') continue;
    const crossedQuestion = store.list('questions').some(q => {
      if (q.taskId !== question.taskId || !sameScope(q, question) || q.taskVersion <= question.taskVersion || q.taskVersion > snapshot.taskVersion) return false;
      if (q.taskVersion < snapshot.taskVersion) return true;
      const boundary = q.decisionSnapshotId ? positions.get(q.decisionSnapshotId) : undefined, current = positions.get(snapshot.id);
      return boundary === undefined || current === undefined || current >= boundary;
    });
    if (!crossedQuestion) result.push(snapshot);
  }
  return result;
}
function questionObservations(store: Store, question: Question, original: DecisionSnapshot | undefined, at: Date): { refs: CanonicalCaseVersion['observationRefs']; sources: SourceRef[] } {
  const refs: CanonicalCaseVersion['observationRefs'] = [], sources: SourceRef[] = [];
  for (const snapshot of relatedQuestionSnapshots(store, question, original)) {
    const observed = snapshotObservations(store, snapshot, at);
    if (observed.refs.length) { refs.push(...observed.refs); sources.push(...snapshot.sourceRefs, ...observed.sources); }
  }
  refs.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { refs, sources };
}
function noQuestionObservations(store: Store, original: DecisionSnapshot, at: Date): { refs: CanonicalCaseVersion['observationRefs']; sources: SourceRef[] } {
  const refs: CanonicalCaseVersion['observationRefs'] = [], sources: SourceRef[] = [];
  for (const action of store.list('actions')) {
    if (action.kind !== 'decision.snapshot' || action.taskId !== original.taskId || !sameScope(action, original)) continue;
    const snapshot = retainedSnapshot(store, action.id, original);
    if (!snapshot || snapshot.taskVersion < original.taskVersion) continue;
    const observed = snapshotObservations(store, snapshot, at);
    if (observed.refs.length) { refs.push(...observed.refs); sources.push(...snapshot.sourceRefs, ...observed.sources); }
  }
  const task = store.get('tasks', original.taskId), receipt = task?.receiptId && store.get('receipts', task.receiptId);
  if (receipt && sameScope(receipt, original) && receipt.taskId === original.taskId && Number.isFinite(Date.parse(receipt.verifiedAt)) && Date.parse(receipt.verifiedAt) <= +at) refs.push({ kind: 'receipt', id: receipt.id, hash: digest(receipt) });
  refs.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { refs, sources };
}
function saveVersion(store: Store, body: SemanticCase, at: Date, fragment?: FragmentBinding): CaseRef {
  const hash = caseHash(body), prior = store.list('actions').filter(a => a.kind === 'decision.case-version' && sameScope(a, body)).flatMap(a => {
    const v = a.payload.case as CanonicalCaseVersion | undefined;
    if (v && v.id === body.id && v.hash === caseHash(v)) return [{ version: v.version, hash: v.hash }];
    const p = a.payload;
    return p.retracted === true && p.caseId === body.id && Number.isSafeInteger(p.version) && typeof p.hash === 'string' && /^[a-f0-9]{64}$/.test(p.hash) ? [{ version: p.version as number, hash: p.hash }] : [];
  }).sort((a, b) => b.version - a.version);
  if (prior[0]?.hash === hash) return { id: body.id, version: prior[0].version, hash };
  const version = (prior[0]?.version ?? 0) + 1;
  const value: CanonicalCaseVersion = { ...body, version, hash, recordedAt: at.toISOString() };
  store.save('actions', { id: stableId('decision.case-version', body.id, version, hash), projectId: body.projectId, domain: body.domain, ...(body.taskId ? { taskId: body.taskId } : {}), kind: 'decision.case-version', status: 'completed', payload: { case: value, sourceRefs: value.sourceRefs, ...(fragment ? { fragment } : {}) }, updatedAt: value.recordedAt });
  return { id: body.id, version, hash };
}
function verifiedFragment(source: SourceRevision, quote: string, locator: string): FragmentBinding | undefined {
  let start: number, end: number;
  if (locator === source.locator) {
    start = source.content.indexOf(quote);
    if (start < 0) throw new DomainError('A case quote must occur in the authorized source.', 'invalid_quote', 400);
    // A repeated quote without a position cannot identify one original fragment.
    if (source.content.indexOf(quote, start + 1) !== -1) return;
    end = start + quote.length;
  } else {
    const prefix = `${source.locator}#chars=`, suffix = locator.startsWith(prefix) ? locator.slice(prefix.length) : '';
    const match = suffix.match(/^(0|[1-9]\d*)-(0|[1-9]\d*)$/);
    if (!match) throw new DomainError('A case locator must identify the authorized source and exact span.', 'invalid_quote', 400);
    start = Number(match[1]); end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > source.content.length || source.content.slice(start, end) !== quote) throw new DomainError('A case locator does not match the quoted source span.', 'invalid_quote', 400);
  }
  return { sourceId: source.id, revision: source.revision, locator: source.locator, start, end };
}

/** Conservative interpretation of a whole native body; ambiguous language stays a source report. */
export function clearNativeDecision(text: string): { scopeQuote: string } | undefined {
  const body = text.trim(), match = body.match(/^我决定((?:仅|只)本产品)(\S.+)$/u);
  if (!match || /[\r\n?？"'“”‘’「」『』《》吗嘛呢]/u.test(body) || /(?:如果|假如|是否|能否|可否|行不行|好不好|要不要|能不能|可不可以|不确定|也许|或许|可能|考虑|暂定|例如|转述)/u.test(body)) return;
  return { scopeQuote: match[1]! };
}

const nativeRevisionMarker = /^我决定((?:仅|只)本产品)(改主意|例外|记下冲突)，(\S.+)$/u;
/** A revision is only explicit when the native sentence itself names it. Caller fields cannot supply one. */
export function explicitNativeRevision(text: string): { scopeQuote: string; relation: 'owner-change' | 'bounded-exception' | 'conflict' } | undefined {
  if (!clearNativeDecision(text)) return;
  const match = text.trim().match(nativeRevisionMarker);
  if (!match) return;
  const relation = match[2] === '改主意' ? 'owner-change' : match[2] === '例外' ? 'bounded-exception' : 'conflict';
  return { scopeQuote: match[1]!, relation };
}
export function looksLikeNativeRevision(text: string): boolean {
  return /^我决定(?:仅|只)本产品(?:改主意|例外|记下冲突)/u.test(text.trim());
}
function recordedRuleHistory(store: Store, ref: CaseRef): RuleHistory | undefined {
  const action = store.list('actions').find(item => {
    const history = item.payload.history as RuleHistory | undefined;
    return item.kind === 'decision.rule-version' && item.status === 'completed' && history?.ruleId === ref.id && history.version === ref.version && history.ruleHash === ref.hash;
  });
  return action?.payload.history as RuleHistory | undefined;
}
function ruleMatchesRecord(store: Store, ref: CaseRef, status: Rule['status']): boolean {
  const rule = store.get('rules', ref.id);
  return !!rule && !!recordedRuleHistory(store, ref) && rule.version === ref.version && rule.status === status && digest({ ...rule, status: 'active' }) === ref.hash;
}
function relationHolds(store: Store, rule: Rule, history: RuleHistory): boolean {
  if (history.relation === 'initial') return history.version === 1 && !history.previous;
  if (history.relation === 'revision') return !!history.previous && history.previous.id === rule.id && history.previous.version === rule.version - 1 && digest(priorRuleAudit(store, rule, rule.id, rule.version - 1) ?? {}) === digest(history.previous);
  if (history.relation === 'owner-change') return !!history.previous && history.version === rule.version && rule.supersedes === history.previous.id && ruleMatchesRecord(store, history.previous, 'superseded');
  if (history.relation === 'bounded-exception') return !!history.previous && history.version === rule.version && history.application.exceptionOf === history.previous.id && ruleMatchesRecord(store, history.previous, 'active');
  return false;
}
function standingPrinciples(store: Store, config: AppConfig, scope: Scope): Rule[] {
  return store.list('rules').filter(rule => {
    if (rule.kind !== 'principle' || rule.status !== 'active' || !sameScope(rule, scope)) return false;
    const history = store.list('actions').find(item => item.kind === 'decision.rule-version' && (item.payload.history as RuleHistory | undefined)?.ruleId === rule.id && (item.payload.history as RuleHistory).ruleHash === digest(rule))?.payload.history as RuleHistory | undefined;
    return (history?.relation === 'initial' || history?.relation === 'revision' || history?.relation === 'owner-change') && applicableOriginalPrinciple(store, config, rule, { ...scope, id: `baseline:${rule.id}` });
  });
}
function pauseExceptions(store: Store, scope: Scope, baselineId: string, status: 'superseded' | 'suspended'): void {
  for (const rule of store.list('rules')) {
    if (rule.status !== 'active' || !sameScope(rule, scope)) continue;
    const history = store.list('actions').find(item => item.kind === 'decision.rule-version' && (item.payload.history as RuleHistory | undefined)?.ruleId === rule.id)?.payload.history as RuleHistory | undefined;
    if (history?.application.exceptionOf === baselineId) store.save('rules', { ...rule, status });
  }
}
function rejudgeOpenTasks(store: Store, scope: Scope, code: 'owner_changed' | 'rules_conflict', marker: string): void {
  const id = stableId('rule-rejudge', scope.projectId, scope.domain, code, marker);
  if (store.get('actions', id)) return;
  const at = now();
  const finished = new Set(['delivered', 'completed', 'archived', 'cancelled']);
  const stages = new Set(['decide', 'research', 'plan', 'execute', 'check', 'delivery', 'feedback']);
  const taskIds: string[] = [];
  for (const task of store.list('tasks')) {
    if (!sameScope(task, scope) || finished.has(task.status) || task.receiptId || !stages.has(task.stage)) continue;
    for (const question of store.list('questions')) if (question.taskId === task.id && question.status === 'open') store.save('questions', { ...question, status: 'stale' });
    store.save('tasks', { ...task, version: task.version + 1, status: 'deciding', stage: 'decide', updatedAt: at, runAfter: at, repairCount: 0, decision: undefined, decisionSnapshotId: undefined, plan: undefined, artifact: undefined, review: undefined, feedback: undefined, questionId: undefined, baselineFiles: undefined, blockedFrom: undefined, error: code });
    store.save('events', { id: stableId('rule-rejudge-event', task.id, id), projectId: scope.projectId, domain: scope.domain, taskId: task.id, type: code === 'owner_changed' ? 'owner.changed' : 'rules.conflict', message: publicError(code)!, createdAt: at, data: {} });
    taskIds.push(task.id);
  }
  store.save('actions', { id, projectId: scope.projectId, domain: scope.domain, kind: 'decision.rule-rejudge', status: 'completed', payload: { code, taskIds }, updatedAt: at });
}

type OriginBinding = { schemaVersion: 1; provider: 'feishu'; tenant: string; chatId: string; messageId: string; nativeRevision: string; ownerId: string; principal: string; nativeTime: number; receiveId: string; receivedAt: string; nativeBodyHash: string; businessBodyHash: string; source: SourceRef; sourceRefs: SourceRef[] } & Scope;
function verifiedOrigin(store: Store, config: AppConfig, ref: OwnerOriginRef): { binding: OriginBinding; source: NonNullable<ReturnType<Store['get']>> } | undefined {
  const row = store.get('actions', ref.id), binding = row?.payload.binding as OriginBinding | undefined;
  if (!row || row.kind !== 'decision.owner-origin' || row.status !== 'completed' || !binding || !binding.source || !Array.isArray(binding.sourceRefs) || !Array.isArray(row.payload.sourceRefs) || binding.schemaVersion !== 1 || binding.provider !== 'feishu' || !sameScope(row, binding) || ref.hash !== digest(binding) || row.payload.hash !== ref.hash || row.id !== stableId('decision.owner-origin', binding.tenant, binding.chatId, binding.messageId, binding.nativeRevision, binding.source.id) || digest(row.payload.sourceRefs) !== digest(binding.sourceRefs)) return;
  const f = config.feishu, project = store.get('projects', binding.projectId), source = store.get('sources', binding.source.id), receipt = store.get('actions', binding.receiveId);
  if (!f || !project || project.ownerId !== config.ownerId || binding.ownerId !== config.ownerId || binding.principal !== f.ownerOpenId || binding.tenant !== f.appId || binding.chatId !== f.chatId || !Number.isFinite(binding.nativeTime) || !Number.isFinite(Date.parse(binding.receivedAt)) || !sameScope(project, binding) || !source || !sameScope(source, binding) || source.kind !== 'feishu' || source.externalId !== `${binding.chatId}:${binding.messageId}` || source.authorId !== binding.ownerId || source.revision !== binding.source.revision || source.revision !== binding.nativeRevision || digest(source.content) !== binding.businessBodyHash || !clearNativeDecision(source.content) || !receipt || receipt.kind !== 'feishu_receive' || receipt.status !== 'completed' || !sameScope(receipt, binding) || receipt.id !== stableId('feishu-receive', binding.chatId, binding.messageId, binding.nativeRevision) || receipt.payload.messageId !== binding.messageId || receipt.payload.chatId !== binding.chatId || receipt.payload.revision !== binding.nativeRevision || receipt.payload.ownerId !== binding.ownerId || receipt.payload.principal !== binding.principal || receipt.payload.nativeTime !== binding.nativeTime || receipt.payload.nativeBodyHash !== binding.nativeBodyHash || receipt.payload.directOriginal !== true || !Array.isArray(receipt.payload.sourceIds) || !receipt.payload.sourceIds.includes(source.id)) return;
  try {
    const cursor = store.get('cursors', stableId('feishu-message', binding.chatId, binding.messageId)), value = cursor && JSON.parse(cursor.value) as { revision?: string; time?: number; sourceIds?: string[]; withdrawn?: boolean };
    if (!value || value.withdrawn || value.revision !== binding.nativeRevision || value.time !== binding.nativeTime || !Array.isArray(value.sourceIds) || !value.sourceIds.includes(source.id)) return;
  } catch { return; }
  try { if (digest(currentRefs(store, binding, [binding.source])) !== digest(binding.sourceRefs)) return; } catch { return; }
  return { binding, source };
}

export function authenticatedOriginalDecisionOrigins(store: Store, config: AppConfig, source: SourceRef): OwnerOriginRef[] {
  return store.list('actions').flatMap(action => {
    if (action.kind !== 'decision.owner-origin' || typeof action.payload.hash !== 'string') return [];
    const ref = { id: action.id, hash: action.payload.hash }, value = verifiedOrigin(store, config, ref);
    return value && value.binding.source.id === source.id && value.binding.source.revision === source.revision ? [ref] : [];
  });
}

function priorRuleAudit(store: Store, scope: Scope, ruleId: string, version: number): CaseRef | undefined {
  const row = store.list('actions').find(action => {
    const p = action.payload;
    return action.kind === 'decision.rule-version' && action.status === 'completed' && sameScope(action, scope) && p.retracted === true && p.ruleId === ruleId && p.version === version && typeof p.hash === 'string' && /^[a-f0-9]{64}$/.test(p.hash) && typeof p.caseHash === 'string' && /^[a-f0-9]{64}$/.test(p.caseHash) && action.id === stableId('decision.rule-version', ruleId, version, p.caseHash);
  });
  return row ? { id: ruleId, version, hash: row.payload.hash as string } : undefined;
}

/** This operation consumes only a retained producer binding; strings alone cannot issue it. */
export function admitOriginalOwnerDecision(store: Store, config: AppConfig, origin: OwnerOriginRef, declaration: OriginalOwnerDecision, at = new Date()): CaseRef {
  return store.transaction(() => {
    const verified = verifiedOrigin(store, config, origin);
    if (!verified) throw new DomainError('Native owner origin is unavailable.', 'invalid_owner_origin', 403);
    const { binding } = verified, source = store.get('sources', binding.source.id)!, clear = clearNativeDecision(source.content), scope = declaration.declaredScope;
    if (!clear || declaration.source.id !== source.id || declaration.source.revision !== source.revision || declaration.quote !== source.content || declaration.scopeQuote !== clear.scopeQuote || !scope || Object.keys(scope).sort().join(',') !== 'domain,projectId' || scope.projectId !== binding.projectId || scope.domain !== binding.domain || declaration.baseline || declaration.relation || declaration.improvement) throw new DomainError('Native decision or its scope is ambiguous.', 'invalid_owner_declaration', 403);
    const revision = explicitNativeRevision(source.content);
    if (looksLikeNativeRevision(source.content) && !revision) throw new DomainError('Native decision or its scope is ambiguous.', 'invalid_owner_declaration', 403);
    const id = stableId('canonical-case', binding.projectId, binding.domain, 'authenticated-message', binding.messageId);
    const citation = { sourceId: source.id, revision: source.revision, quote: source.content, locator: source.locator };
    const ref = saveVersion(store, { schemaVersion: 1, id, projectId: binding.projectId, domain: binding.domain, identity: 'host-bound', original: { kind: 'authenticated-message', id: binding.messageId, revision: binding.nativeRevision }, authority: 'owner-explicit', ownerId: binding.ownerId, frozenJudgment: null, sourceRefs: binding.sourceRefs, citations: [citation], choiceText: source.content, rationale: null, alternatives: [], ruleVersions: [], expectedOutcome: null, observationRefs: [], effectiveAt: binding.receivedAt }, at);
    const ruleId = stableId('explicit-original-rule', id), historyId = stableId('decision.rule-version', ruleId, ref.version, ref.hash);
    if (store.get('actions', historyId)) return ref;
    const baseline = revision ? standingPrinciples(store, config, binding).filter(rule => rule.id !== ruleId) : [];
    if (revision && baseline.length !== 1) throw new DomainError('Native decision or its scope is ambiguous.', 'invalid_owner_declaration', 403);
    const previous = !revision && ref.version > 1 ? priorRuleAudit(store, binding, ruleId, ref.version - 1) : undefined;
    if (!revision && ref.version > 1 && !previous) return ref;
    const prior = baseline[0];
    const priorRef = prior ? { id: prior.id, version: prior.version, hash: digest(prior) } : undefined;
    const status = revision?.relation === 'conflict' ? 'suspended' as const : 'active' as const;
    const rule: Rule = { id: ruleId, projectId: binding.projectId, domain: binding.domain, title: source.title, statement: source.content, conditions: `Applies only within project ${binding.projectId}, domain ${binding.domain}.`, exceptions: revision?.relation === 'owner-change' ? 'Replaces the previous explicit decision from this message onward.' : revision?.relation === 'bounded-exception' ? 'Bounded exception. The previous explicit decision remains in force.' : revision?.relation === 'conflict' ? 'Conflicts with the previous explicit decision. Neither side is cited automatically.' : 'Reconfirm outside this declared scope.', version: ref.version, kind: 'principle', status, caseIds: [id], citations: [citation], createdAt: binding.receivedAt, reviewAt: new Date(+at + 30 * 86400_000).toISOString(), ...(revision?.relation === 'owner-change' && prior ? { supersedes: prior.id } : {}) };
    const history: RuleHistory = { schemaVersion: 1, id: historyId, projectId: binding.projectId, domain: binding.domain, ruleId, version: ref.version, kind: 'principle', relation: revision?.relation ?? (previous ? 'revision' : 'initial'), ...(revision && priorRef ? { previous: priorRef } : previous ? { previous } : {}), effectiveAt: binding.receivedAt, supports: [{ case: ref, citation }], opposes: [], confirmation: ref, scopeCitation: { ...citation, quote: declaration.scopeQuote }, application: revision?.relation === 'bounded-exception' && prior ? { exceptionOf: prior.id } : {}, ruleHash: digest(rule), createdAt: at.toISOString() };
    store.save('rules', rule);
    store.save('actions', { id: historyId, projectId: binding.projectId, domain: binding.domain, kind: 'decision.rule-version', status: 'completed', payload: { history, origin, sourceRefs: binding.sourceRefs }, updatedAt: history.createdAt });
    if (prior && revision?.relation === 'owner-change') {
      store.save('rules', { ...prior, status: 'superseded' });
      pauseExceptions(store, binding, prior.id, 'superseded');
      rejudgeOpenTasks(store, binding, 'owner_changed', historyId);
    } else if (prior && revision?.relation === 'conflict') {
      store.save('rules', { ...prior, status: 'suspended' });
      pauseExceptions(store, binding, prior.id, 'suspended');
      rejudgeOpenTasks(store, binding, 'rules_conflict', historyId);
    }
    return ref;
  });
}

export function applicableOriginalPrinciple(store: Store, config: AppConfig, rule: Rule, task: Scope & { id: string }): boolean {
  if (rule.kind !== 'principle' || rule.caseIds.length !== 1 || !sameScope(rule, task)) return false;
  const action = store.list('actions').find(a => a.kind === 'decision.rule-version' && a.status === 'completed' && sameScope(a, task) && (a.payload.history as RuleHistory | undefined)?.ruleId === rule.id && (a.payload.history as RuleHistory).ruleHash === digest(rule));
  const history = action?.payload.history as RuleHistory | undefined, origin = action?.payload.origin as OwnerOriginRef | undefined;
  if (!history || !origin || !history.confirmation || history.confirmation.id !== rule.caseIds[0] || history.version !== rule.version || history.confirmation.version !== rule.version || !verifiedOrigin(store, config, origin) || history.application.taskId && history.application.taskId !== task.id || history.validUntil && Date.parse(history.validUntil) <= Date.now()) return false;
  if (!relationHolds(store, rule, history)) return false;
  return caseVersions(store, config, task).some(v => v.id === history.confirmation!.id && v.version === history.confirmation!.version && v.hash === history.confirmation!.hash && v.authority === 'owner-explicit' && v.original.kind === 'authenticated-message');
}

/** Model mentions remain unresolved unless their exact native original is already bound by the producer. */
export function captureSourceCaseMentions(store: Store, config: AppConfig, source: SourceRevision, mentions: CaseMention[], at = new Date()): CaseRef[] {
  return store.transaction(() => {
    const current = store.get('sources', source.id), project = store.get('projects', source.projectId);
    if (!current || !project || project.ownerId !== config.ownerId || !sameScope(current, source) || current.revision !== source.revision || digest(current.content) !== digest(source.content) || mentions.length > 20) throw new DomainError('Case extraction refers to an obsolete source.', 'stale_source', 409);
    const refs = currentRefs(store, source, [{ id: source.id, revision: source.revision }]);
    return mentions.flatMap(raw => {
      const mention = caseMentionSchema.parse(raw);
      const span = verifiedFragment(source, mention.quote, mention.locator);
      if (!span) return [];
      const origin = authenticatedOriginalDecisionOrigins(store, config, { id: source.id, revision: source.revision })[0], clear = clearNativeDecision(source.content);
      if (origin && clear && mention.quote === source.content) return [admitOriginalOwnerDecision(store, config, origin, { source: { id: source.id, revision: source.revision }, quote: source.content, scopeQuote: clear.scopeQuote, declaredScope: { projectId: source.projectId, domain: source.domain } }, at)];
      const fragment = stableId('source-fragment', source.id, source.locator, span.start, span.end), id = stableId('canonical-case', source.projectId, source.domain, 'source-fragment', fragment);
      const previous = caseVersions(store, config, source).filter(value => value.id === id).sort((a, b) => b.version - a.version)[0];
      if (previous) return [{ id, version: previous.version, hash: previous.hash }];
      return [saveVersion(store, { schemaVersion: 1, id, projectId: source.projectId, domain: source.domain, identity: 'unresolved', original: { kind: 'source-fragment', id: fragment, revision: source.revision }, authority: 'source-report', frozenJudgment: null, sourceRefs: refs, citations: [{ sourceId: source.id, revision: source.revision, quote: mention.quote, locator: source.locator }], choiceText: mention.choiceText, rationale: mention.rationale, alternatives: mention.alternatives, ruleVersions: [], expectedOutcome: null, observationRefs: [], effectiveAt: source.createdAt }, at, span)];
    });
  });
}

/** Read the accepted question and its original host snapshot; never resolve current rule bodies. */
export function captureOwnerCaseVersion(store: Store, config: AppConfig, ownerCaseId: string, at = new Date()): CaseRef {
  return store.transaction(() => {
    const owner = store.get('cases', ownerCaseId), q = owner && store.get('questions', owner.questionId), task = owner && store.get('tasks', owner.taskId), project = owner && store.get('projects', owner.projectId);
    if (!owner || owner.status !== 'active' || !q || q.status !== 'answered' || !q.answer || !validFrozenAnswer(q) || !task || !project || !sameScope(owner, q) || !sameScope(owner, task) || !sameScope(owner, project) || project.ownerId !== config.ownerId || q.ownerId !== project.ownerId || q.answer.actorId !== project.ownerId || owner.actorId !== project.ownerId || owner.taskId !== q.taskId || owner.choice !== q.answer.choice || owner.originalWords !== q.answer.text || owner.id !== stableId('decision-case', q.id)) throw new DomainError('Accepted owner decision is unavailable.', 'invalid_owner_case', 409);
    const fingerprint = digest({ questionId: q.id, choice: q.answer.choice, words: q.answer.text });
    if (store.get('cursors', stableId('answer-event', task.projectId, task.domain, q.answer.eventId))?.value !== fingerprint) throw new DomainError('Accepted owner event is unavailable.', 'invalid_owner_case', 409);
    const answerSource = store.get('sources', owner.sourceId), primary = store.get('sources', task.sourceId);
    if (!answerSource || !primary || answerSource.id !== stableId('owner-answer', q.id) || answerSource.content !== owner.originalWords || answerSource.revision !== digest(owner.originalWords) || answerSource.authorId !== project.ownerId || primary.revision !== task.sourceRevision) throw new DomainError('Accepted original is unavailable.', 'invalid_owner_case', 409);
    let snapshot: DecisionSnapshot | undefined;
    if (owner.decisionSnapshot) {
      const frozen = retainedSnapshot(store, owner.decisionId, owner);
      if (!frozen || digest(frozen) !== digest(owner.decisionSnapshot) || q.decisionSnapshotId !== frozen.id || !questionMatchesSnapshot(q, frozen)) throw new DomainError('Frozen owner judgment is unavailable.', 'invalid_decision_snapshot', 409);
      snapshot = frozen;
    } else if (q.decisionSnapshotId) throw new DomainError('Frozen owner judgment is unavailable.', 'invalid_decision_snapshot', 409);
    const observations = questionObservations(store, q, snapshot, at);
    const refs = currentRefs(store, owner, [{ id: answerSource.id, revision: answerSource.revision }, { id: primary.id, revision: primary.revision }, ...(snapshot?.sourceRefs ?? []), ...observations.sources]);
    const citations = [{ sourceId: answerSource.id, revision: answerSource.revision, quote: owner.originalWords, locator: answerSource.locator }, ...(snapshot?.decision.citations ?? [])];
    if (citations.some(c => { const s = store.get('sources', c.sourceId); return !s || s.revision !== c.revision || s.locator !== c.locator || !c.quote.trim() || !s.content.includes(c.quote); })) throw new DomainError('Case citation is unavailable.', 'invalid_quote', 409);
    const observationRefs = [...(owner.outcomes ?? []).flatMap(outcome => { const receipt = store.get('receipts', outcome.receiptId); return receipt && receipt.taskId === task.id && sameScope(receipt, owner) ? [{ kind: 'receipt' as const, id: receipt.id, hash: digest(receipt) }] : []; }), ...observations.refs];
    const frozenJudgment = snapshot ? frozenSnapshot(snapshot) : null;
    return saveVersion(store, { schemaVersion: 1, id: stableId('canonical-case', owner.projectId, owner.domain, 'question', q.id), projectId: owner.projectId, domain: owner.domain, identity: 'host-bound', original: { kind: 'question', id: q.id, revision: digest({ questionVersion: q.version, answer: q.answer.text }) }, authority: 'owner-explicit', ownerId: project.ownerId, ownerCaseId: owner.id, taskId: task.id, ...(snapshot ? { decisionSnapshotId: snapshot.id } : {}), frozenJudgment, sourceRefs: refs, citations, choiceText: owner.originalWords, rationale: owner.rationale, alternatives: [...owner.alternatives], ruleVersions: snapshot?.rules.map(rule => ({ id: rule.id, version: rule.version, hash: digest(rule) })) ?? [], expectedOutcome: snapshot?.expectedOutcome ?? null, observationRefs, effectiveAt: q.answeredAt ?? owner.createdAt }, at);
  });
}

/** Capture a real successful host judgment that proceeded without an owner question. */
export function captureNoQuestionCaseVersion(store: Store, config: AppConfig, snapshotId: string, at = new Date()): CaseRef {
  return store.transaction(() => {
    const action = store.get('actions', snapshotId), scope = action && { projectId: action.projectId, domain: action.domain }, latest = scope && retainedSnapshot(store, snapshotId, scope), task = latest && store.get('tasks', latest.taskId), project = latest && store.get('projects', latest.projectId);
    if (!latest || !task || !project || project.ownerId !== config.ownerId || latest.decision.action === 'ask' || store.list('questions').some(q => q.taskId === task.id && q.status === 'answered') || Date.parse(latest.recordedAt) > +at) throw new DomainError('No-question judgment is unavailable.', 'invalid_decision_snapshot', 409);
    const id = stableId('canonical-case', latest.projectId, latest.domain, 'source-fragment', task.id);
    const prior = store.list('actions').flatMap(row => { const value = row.kind === 'decision.case-version' ? row.payload.case as CanonicalCaseVersion | undefined : undefined; return value?.id === id && value.decisionSnapshotId ? [value] : []; }).sort((a, b) => a.version - b.version)[0];
    const candidates = store.list('actions').flatMap(row => { const value = row.kind === 'decision.snapshot' && row.taskId === task.id ? retainedSnapshot(store, row.id, latest) : undefined; return value && value.decision.action !== 'ask' ? [value] : []; }).sort((a, b) => a.taskVersion - b.taskVersion || a.recordedAt.localeCompare(b.recordedAt));
    const snapshot = prior ? retainedSnapshot(store, prior.decisionSnapshotId!, latest) : candidates[0];
    if (!snapshot) throw new DomainError('Initial no-question judgment is unavailable.', 'invalid_decision_snapshot', 409);
    const observed = noQuestionObservations(store, snapshot, at), sourceRefs = currentRefs(store, snapshot, [...snapshot.sourceRefs, ...observed.sources]);
    const citations = snapshot.decision.citations;
    if (citations.some(c => { const s = store.get('sources', c.sourceId); return !s || s.revision !== c.revision || s.locator !== c.locator || !c.quote.trim() || !s.content.includes(c.quote); })) throw new DomainError('Judgment citation is unavailable.', 'invalid_quote', 409);
    return saveVersion(store, { schemaVersion: 1, id, projectId: snapshot.projectId, domain: snapshot.domain, identity: 'host-bound', original: { kind: 'source-fragment', id: task.id, revision: snapshot.id }, authority: 'source-report', taskId: task.id, decisionSnapshotId: snapshot.id, frozenJudgment: frozenSnapshot(snapshot), sourceRefs, citations: structuredClone(citations), choiceText: snapshot.decision.summary, rationale: snapshot.decision.rationale, alternatives: [], ruleVersions: snapshot.rules.map(rule => ({ id: rule.id, version: rule.version, hash: digest(rule) })), expectedOutcome: snapshot.expectedOutcome, observationRefs: observed.refs, effectiveAt: snapshot.recordedAt }, at);
  });
}

export function refreshCasesForSnapshot(store: Store, config: AppConfig, snapshotId: string, at = new Date()): void {
  const snapshot = store.get('actions', snapshotId)?.payload.snapshot as DecisionSnapshot | undefined;
  if (!snapshot) return;
  for (const owner of store.list('cases')) if (owner.status === 'active' && owner.taskId === snapshot.taskId) {
    const question = store.get('questions', owner.questionId), initial = owner.decisionSnapshot && retainedSnapshot(store, owner.decisionSnapshot.id, owner);
    if (question && relatedQuestionSnapshots(store, question, initial).some(item => item.id === snapshotId)) try { captureOwnerCaseVersion(store, config, owner.id, at); } catch (error) { if (!(error instanceof DomainError)) throw error; }
  }
  if (!store.list('questions').some(q => q.taskId === snapshot.taskId && q.status === 'answered')) try { captureNoQuestionCaseVersion(store, config, snapshotId, at); } catch (error) { if (!(error instanceof DomainError)) throw error; }
}

/** Newest host judgment in the last week that did not ask the owner. The summary is the assistant's, not the owner's words. */
export function latestUnaskedJudgment(store: Store, config: AppConfig, scope: Scope, at = new Date()): { taskId: string; summary: string } | undefined {
  const since = at.getTime() - 7 * 86400000;
  const found = caseVersions(store, config, scope, at).filter(item => item.original.kind === 'source-fragment' && item.authority === 'source-report' && item.taskId && Date.parse(item.recordedAt) >= since).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
  return found?.taskId ? { taskId: found.taskId, summary: found.choiceText } : undefined;
}

export function caseVersions(store: Store, config: AppConfig, scope: Scope, at = new Date()): CanonicalCaseVersion[] {
  const project = store.get('projects', scope.projectId);
  if (!project || !sameScope(project, scope) || project.ownerId !== config.ownerId) return [];
  return store.readSnapshot(() => store.list('actions').flatMap(action => {
    const value = action.payload.case as CanonicalCaseVersion | undefined;
    if (action.kind !== 'decision.case-version' || action.status !== 'completed' || !value || !Array.isArray(value.sourceRefs) || !Array.isArray(action.payload.sourceRefs) || !Array.isArray(value.observationRefs) || !sameScope(action, scope) || !sameScope(value, scope) || action.id !== stableId('decision.case-version', value.id, value.version, value.hash) || value.hash !== caseHash(value) || digest(action.payload.sourceRefs) !== digest(value.sourceRefs) || !Number.isFinite(Date.parse(value.recordedAt)) || Date.parse(value.recordedAt) > +at) return [];
    try { if (digest(currentRefs(store, scope, value.sourceRefs)) !== digest(value.sourceRefs)) return []; } catch { return []; }
    if (!Array.isArray(value.citations) || value.citations.some(c => { const source = store.get('sources', c.sourceId); return !source || source.revision !== c.revision || source.locator !== c.locator || !c.quote.trim() || !source.content.includes(c.quote) || !value.sourceRefs.some(ref => ref.id === c.sourceId && ref.revision === c.revision); })) return [];
    if (value.identity === 'unresolved' && value.original.kind === 'source-fragment') {
      const span = action.payload.fragment as FragmentBinding | undefined, source = span && store.get('sources', span.sourceId), citation = value.citations[0];
      if (!span || !source || !citation || value.citations.length !== 1 || source.revision !== span.revision || source.locator !== span.locator || citation.sourceId !== source.id || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > source.content.length || source.content.slice(span.start, span.end) !== citation.quote || value.original.revision !== source.revision || value.original.id !== stableId('source-fragment', source.id, source.locator, span.start, span.end) || value.id !== stableId('canonical-case', scope.projectId, scope.domain, 'source-fragment', value.original.id)) return [];
    }
    if (value.original.kind === 'authenticated-message' && !value.sourceRefs.some(source => authenticatedOriginalDecisionOrigins(store, config, source).some(ref => { const o = verifiedOrigin(store, config, ref); return o?.binding.messageId === value.original.id && o.binding.nativeRevision === value.original.revision && store.get('sources', source.id)?.content === value.choiceText; }))) return [];
    let question: Question | undefined;
    if (value.original.kind === 'question') {
      const q = store.get('questions', value.original.id), owner = value.ownerCaseId && store.get('cases', value.ownerCaseId);
      if (!q || q.status !== 'answered' || !q.answer || !validFrozenAnswer(q) || !owner || owner.status !== 'active' || owner.questionId !== q.id || owner.taskId !== q.taskId || q.ownerId !== project.ownerId || q.answer.actorId !== project.ownerId || q.answer.text !== value.choiceText || owner.originalWords !== value.choiceText || store.get('cursors', stableId('answer-event', scope.projectId, scope.domain, q.answer.eventId))?.value !== digest({ questionId: q.id, choice: q.answer.choice, words: q.answer.text })) return [];
      question = q;
    }
    let snapshot: DecisionSnapshot | undefined;
    if (value.decisionSnapshotId) { snapshot = retainedSnapshot(store, value.decisionSnapshotId, scope); if (!snapshot || !value.frozenJudgment || digest(frozenSnapshot(snapshot)) !== digest(value.frozenJudgment) || question && !questionMatchesSnapshot(question, snapshot)) return []; }
    const currentObservations = question ? questionObservations(store, question, snapshot, at).refs : snapshot && value.identity === 'host-bound' ? noQuestionObservations(store, snapshot, at).refs : [];
    if (value.observationRefs.some(ref => ref.kind === 'receipt' ? (() => { const receipt = store.get('receipts', ref.id); return !receipt || !sameScope(receipt, scope) || receipt.taskId !== value.taskId || digest(receipt) !== ref.hash; })() : !currentObservations.some(observed => observed.kind === ref.kind && observed.id === ref.id && observed.hash === ref.hash))) return [];
    return [structuredClone(value)];
  }));
}
export function refreshCaseVersions(store: Store, config: AppConfig, scope: Scope, at = new Date()): number {
  let count = 0;
  for (const owner of store.list('cases')) if (owner.status === 'active' && sameScope(owner, scope)) {
    const before = store.list('actions').filter(a => a.kind === 'decision.case-version').length;
    try { captureOwnerCaseVersion(store, config, owner.id, at); } catch (error) { if (!(error instanceof DomainError)) throw error; }
    if (store.list('actions').filter(a => a.kind === 'decision.case-version').length > before) count++;
  }
  const visitedTasks = new Set<string>();
  for (const action of store.actionsOfKind('decision.snapshot')) if (sameScope(action, scope)) {
    const snapshot = action.payload.snapshot as DecisionSnapshot | undefined;
    if (!snapshot?.decision || snapshot.decision.action === 'ask' || visitedTasks.has(snapshot.taskId) || store.list('questions').some(q => q.taskId === snapshot.taskId && q.status === 'answered')) continue;
    visitedTasks.add(snapshot.taskId);
    const before = store.list('actions').filter(a => a.kind === 'decision.case-version').length;
    try { captureNoQuestionCaseVersion(store, config, action.id, at); } catch (error) { if (!(error instanceof DomainError)) throw error; }
    if (store.list('actions').filter(a => a.kind === 'decision.case-version').length > before) count++;
  }
  return count;
}
