import { caseObservationSchema, digest, now, stableId, type AppConfig, type DecisionCase, type Project, type Role, type Rule, type Runner, type WorkerAdapter, type WorkerInput } from './domain.js';
import type { Store } from './store.js';

const runners: Runner[] = ['grok', 'dsh', 'codex'];
const idleSchema = caseObservationSchema;

/** When nothing else is ready, distill one observation from owner cases. It never becomes a principle. */
export async function distillIdleObservations(store: Store, config: AppConfig, workers: WorkerAdapter[], canRun?: (project: Project) => boolean): Promise<void> {
  for (const project of store.list('projects')) {
    if (project.ownerId !== config.ownerId || canRun && !canRun(project)) continue;
    const representatives = mirrorRepresentatives(store, project);
    if (!representatives.length) continue;
    const batchId = stableId('case-observation-batch', project.projectId, project.domain, digest(representatives.map(item => [item.id, digest(item.originalWords), item.outcome ?? '', item.outcomes?.length ?? 0])));
    const existing = store.get('actions', batchId);
    const retryAt = typeof existing?.payload.runAfter === 'string' ? Date.parse(existing.payload.runAfter) : 0;
    if (existing?.status === 'completed' || existing?.status === 'pending' && retryAt > Date.now()) continue;
    const policy = runners.flatMap(runner => config.runnerPolicies.filter(item => item.runner === runner && item.admitted && item.roles.includes('case_extract' satisfies Role) && item.domains.includes(project.domain))).at(0);
    const worker = policy && workers.find(item => item.name === policy.runner);
    if (!policy || !worker) continue;
    const source = store.get('sources', representatives[0]!.sourceId);
    const task = store.get('tasks', representatives[0]!.taskId);
    if (!source || !task) continue;
    const input: WorkerInput = { task: { ...task, stage: 'case_extract' }, project, role: 'case_extract', source, cards: [], facts: [], rules: [], caseBatch: { cases: representatives.map(item => ({ id: item.id, choice: item.choice, words: item.originalWords, outcome: item.outcome ?? null })) } };
    try {
      const result = await worker.run(input);
      const accepted = acceptCaseObservations(store, project, representatives, result.output);
      store.save('actions', { id: batchId, projectId: project.projectId, domain: project.domain, kind: 'decision.case-observation-batch', status: 'completed', payload: { caseIds: representatives.map(item => item.id), ruleIds: accepted.map(rule => rule.id) }, updatedAt: now() });
    } catch {
      store.save('actions', { id: batchId, projectId: project.projectId, domain: project.domain, kind: 'decision.case-observation-batch', status: 'pending', payload: { runAfter: new Date(Date.now() + 30_000).toISOString() }, updatedAt: now() });
    }
  }
}

function mirrorRepresentatives(store: Store, project: Project): DecisionCase[] {
  const eligible = store.list('cases').filter(item => {
    if (item.projectId !== project.projectId || item.domain !== project.domain || item.status !== 'active' || item.actorId !== project.ownerId) return false;
    const source = store.get('sources', item.sourceId);
    return !!source && source.status === 'active' && source.projectId === project.projectId && source.domain === project.domain && !store.sourceRequiresTemporaryRetention(source) && source.content.includes(item.originalWords);
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  return eligible.filter(item => {
    const key = `${item.choice}\0${item.originalWords.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function acceptCaseObservations(store: Store, project: Project, representatives: DecisionCase[], output: unknown): Rule[] {
  const parsed = output && typeof output === 'object' && 'caseObservations' in output ? (output as { caseObservations?: unknown }).caseObservations : undefined;
  if (!Array.isArray(parsed)) return [];
  const byId = new Map(representatives.map(item => [item.id, item]));
  const saved: Rule[] = [];
  for (const candidate of parsed) {
    const item = idleSchema.safeParse(candidate);
    if (!item.success) continue;
    const supports = [...new Set(item.data.supports)];
    const opposes = [...new Set(item.data.opposes)];
    if (supports.some(id => opposes.includes(id)) || [...supports, ...opposes].some(id => !byId.has(id))) continue;
    const cited = [...supports, ...opposes].map(id => byId.get(id)!);
    if (cited.some(entry => !entry.originalWords.includes(item.data.quote))) continue;
    const citations = cited.flatMap(entry => {
      const source = store.get('sources', entry.sourceId);
      return source && source.content.includes(item.data.quote) ? [{ sourceId: source.id, revision: source.revision, quote: item.data.quote, locator: source.locator }] : [];
    });
    if (citations.length !== cited.length) continue;
    const rule: Rule = { id: stableId('case-observation', project.projectId, project.domain, item.data.title, item.data.quote), projectId: project.projectId, domain: project.domain, title: item.data.title, statement: item.data.statement, conditions: item.data.conditions, exceptions: item.data.exceptions, version: 1, kind: 'observation', status: 'active', caseIds: cited.map(entry => entry.id), citations, createdAt: now(), reviewAt: new Date(Date.now() + 30 * 86400_000).toISOString() };
    if (!store.get('rules', rule.id)) {
      store.save('rules', rule);
      store.save('events', { id: stableId('case-observation-event', rule.id), projectId: project.projectId, domain: project.domain, taskId: cited[0]!.taskId, type: 'case.observation', message: '从本域案例记下一条观察。它不是你的原则。', data: { ruleId: rule.id }, createdAt: now() });
    }
    const linkId = stableId('case-observation-links', rule.id);
    if (!store.get('actions', linkId)) store.save('actions', { id: linkId, projectId: project.projectId, domain: project.domain, kind: 'decision.case-observation', status: 'completed', payload: { ruleId: rule.id, supports, opposes }, updatedAt: now() });
    saved.push(store.get('rules', rule.id) ?? rule);
  }
  return saved;
}
