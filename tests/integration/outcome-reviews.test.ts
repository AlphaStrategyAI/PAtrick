import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, type AppConfig, type DecisionSnapshot, type Project, type WorkerInput } from '../../src/domain.js';
import { Store } from '../../src/store.js';
import { ingestSource, withdrawSource } from '../../src/intake.js';
import { recordDecisionSnapshot } from '../../src/standards.js';
import { projectSchema } from '../../src/config.js';
const roots: string[] = [], stores: Store[] = [];
const p: Project = { id: 'p', projectId: 'p', domain: 'personal', name: 'P', description: '', repository: 'a/b', repositoryProvider: 'github', prdPath: 'PRD.md', allowedPaths: ['PRD.md'], trustedChecks: ['test'], trustedAppIds: [1], ownerId: 'owner', autoMerge: true, budgetUsd: 1, createdAt: new Date().toISOString() };
function fixture(temporary = false) {
    const root = mkdtempSync(join(tmpdir(), 'outcome-'));
    roots.push(root);
    const db = join(root, 'db');
    const store = new Store(db);
    stores.push(store);
    const config = { projects: [{ ...p, reviewIntervalDays: 2 }], ownerId: 'owner' } as AppConfig;
    const task = ingestSource(store, config, { projectId: 'p', externalId: 'idea', title: 'Idea', content: 'Original judgment source', retention: temporary ? 'ephemeral' : 'permanent' })!;
    const source = store.get('sources', task.sourceId)!;
    const input = { task, source, project: config.projects[0], role: 'decide', cards: [], facts: [], rules: [] } as WorkerInput;
    store.save('attempts', { id: 'attempt', projectId: 'p', domain: 'personal', taskId: task.id, taskVersion: task.version, role: 'decide', runner: 'grok', model: 'local', provider: 'local', inputHash: digest(input), status: 'succeeded', costUsd: 0, startedAt: new Date().toISOString() });
    const snapshot = recordDecisionSnapshot(store, task, input, { action: 'proceed', summary: 'Judgment', rationale: 'Reason', citations: [], ruleIds: [] });
    return { store, config, task, snapshot, db };
}
async function api() { return import('../../src/reviews.js'); }
function reference(f: ReturnType<typeof fixture>, quote: string, externalId = 'metric', temporary = false) { ingestSource(f.store, f.config, { projectId: 'p', externalId, title: 'Reference', content: quote, purpose: 'reference', retention: temporary ? 'ephemeral' : 'permanent', authorId: 'analyst' }); return f.store.list('sources').find(s => s.externalId === externalId && s.status === 'active')!; }
function metric(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) { const end = new Date(Date.parse(f.snapshot.recordedAt) + 86400000).toISOString(); return JSON.stringify({ schemaVersion: 1, name: 'usage', value: 12, unit: 'events', sampleSize: 10, periodStart: f.snapshot.recordedAt, periodEnd: end, ...extra }); }
function raw(f: ReturnType<typeof fixture>, quote: string, kind = 'metric') { const s = reference(f, quote, kind); return { projectId: 'p', domain: 'personal', kind, sourceId: s.id, sourceRevision: s.revision, quote, observedAt: JSON.parse(kind === 'metric' ? quote : '{}').periodEnd ?? f.snapshot.recordedAt }; }
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
it('references are idempotent without tasks and purpose conflicts fail', () => { const f = fixture(); reference(f, 'metric quote'); reference(f, 'metric quote'); expect(f.store.list('tasks')).toHaveLength(1); expect(() => ingestSource(f.store, f.config, { projectId: 'p', externalId: 'metric', title: 'Reference', content: 'metric quote' })).toThrow(); });
it('freezes interval and validates bounds', () => { const f = fixture(); expect(f.snapshot.reviewIntervalDays).toBe(2); expect(f.snapshot.reviewAt).toBe(new Date(Date.parse(f.snapshot.recordedAt) + 2 * 86400000).toISOString()); expect(projectSchema.safeParse({ ...p, reviewIntervalDays: 0 }).success).toBe(false); });
it('creates due reports only, preserves frozen cadence and restart idempotence', async () => { const { runOutcomeReviews, outcomeReviewViews } = await api(); const f = fixture(); const due = new Date(f.snapshot.reviewAt!); expect(runOutcomeReviews(f.store, new Date(+due - 1))).toBe(0); expect(runOutcomeReviews(f.store, due)).toBe(1); expect(runOutcomeReviews(f.store, due)).toBe(0); expect(outcomeReviewViews(f.store, p, due)[0]?.latestReview?.status).toBe('observing'); f.store.save('projects', { ...p, reviewIntervalDays: 99 }); expect(runOutcomeReviews(f.store, new Date(+due + 2 * 86400000))).toBe(1); f.store.close(); const next = new Store(f.db); stores.push(next); expect(runOutcomeReviews(next, new Date(+due + 2 * 86400000))).toBe(0); expect(outcomeReviewViews(next, { projectId: 'missing', domain: 'personal' }, due)).toEqual([]); });
it('records quoted JSON with separate author and recorder, rejects identity and metadata conflicts', async () => { const { recordOutcomeEvidence } = await api(); const f = fixture(); const input = raw(f, metric(f)); const at = new Date(f.snapshot.reviewAt!); const e = recordOutcomeEvidence(f.store, f.config, f.snapshot.id, input, 'owner', at); expect(e).toMatchObject({ authorId: 'analyst', actorId: 'owner', metric: { value: 12 } }); expect(recordOutcomeEvidence(f.store, f.config, f.snapshot.id, input, 'owner', at)).toEqual(e); expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, observedAt: f.snapshot.recordedAt }, 'owner', at)).toThrow(); expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, actorId: 'owner' }, 'owner', at)).toThrow(); expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, input, 'intruder', at)).toThrow(); expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, domain: 'other' }, 'owner', at)).toThrow(); });
it('requires exact JSON quotes, ordered nonfuture observations and permanent scope', async () => {
    const { recordOutcomeEvidence } = await api();
    const f = fixture();
    const at = new Date(f.snapshot.reviewAt!);
    for (const q of ['not JSON', metric(f, { sampleSize: 0 }), metric(f, { periodStart: '2099-01-01T00:00:00.000Z' }), metric(f, { value: '12' })]) {
        const input = raw(f, q, q === 'not JSON' ? 'correction' : 'metric');
        expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, kind: 'metric' }, 'owner', at)).toThrow();
    }
    const input = raw(f, metric(f));
    expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, quote: input.quote + ' ' }, 'owner', at)).toThrow();
    expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, input, 'owner', new Date(f.snapshot.recordedAt))).toThrow();
    const temp = reference(f, 'temporary correction', 'temp', true);
    expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, kind: 'correction', sourceId: temp.id, sourceRevision: temp.revision, quote: temp.content, observedAt: f.snapshot.recordedAt }, 'owner', at)).toThrow();
});
it('links only attributed sampled metrics after verified delivery, excludes later-recorded evidence from earlier views', async () => {
    const { recordOutcomeEvidence, runOutcomeReviews, outcomeReviewViews } = await api();
    const f = fixture();
    const due = new Date(f.snapshot.reviewAt!);
    const input = raw(f, metric(f));
    const s = f.store.get('sources', input.sourceId)!;
    const attribution = { method: 'direct_measurement', citations: [{ sourceId: s.id, revision: s.revision, quote: input.quote, locator: s.locator }] };
    f.store.save('tasks', { ...f.task, artifact: { taskVersion: 1, planHash: 'p', baselineSha: 'base', files: [{ path: p.prdPath, content: 'Delivered' }], tests: [{ command: 'test', passed: true, output: 'passed' }], summary: 'Delivery' } });
    f.store.save('receipts', { id: 'receipt', taskId: f.task.id, projectId: 'p', domain: 'personal', repository: p.repository, path: p.prdPath, pullRequestUrl: 'https://example.com/1', pullRequestNumber: 1, headSha: 'head', mergeSha: 'merge', contentHash: digest('Delivered'), verifiedAt: f.snapshot.recordedAt, checks: [{ name: 'test', conclusion: 'success', headSha: 'head', appId: 1, url: 'https://example.com/check' }] });
    recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, attribution }, 'owner', due);
    expect(runOutcomeReviews(f.store, due)).toBe(1);
    expect(outcomeReviewViews(f.store, p, due)[0]?.latestReview?.status).toBe('evidence_linked');
    const later = new Date(+due + 1000);
    const correction = raw(f, 'Corrected interpretation', 'correction');
    recordOutcomeEvidence(f.store, f.config, f.snapshot.id, correction, 'owner', later);
    expect(runOutcomeReviews(f.store, later)).toBe(1);
    expect(outcomeReviewViews(f.store, p, due)[0]?.evidence).toHaveLength(1);
    expect(outcomeReviewViews(f.store, p, later)[0]?.evidence).toHaveLength(2);
    withdrawSource(f.store, input.sourceId);
    expect(outcomeReviewViews(f.store, p, later)[0]?.latestReview).toBeUndefined();
    expect(JSON.stringify(f.store.list('actions'))).not.toContain(input.quote);
});
it('keeps unknown samples and pre-delivery measurements observing; cancellation and failed checks stay separate', async () => { const { recordOutcomeEvidence, runOutcomeReviews, outcomeReviewViews } = await api(); const f = fixture(); const at = new Date(f.snapshot.reviewAt!); recordOutcomeEvidence(f.store, f.config, f.snapshot.id, raw(f, metric(f, { sampleSize: undefined })), 'owner', at); f.store.save('tasks', { ...f.task, status: 'cancelled', updatedAt: at.toISOString(), plan: {taskVersion:1,sourceRevision:f.task.sourceRevision,baselineSha:'base',summary:'Plan',paths:[p.prdPath],steps:['Update'],tests:['test'],stopConditions:['change']}, review: { taskVersion: 1, planHash: 'p', artifactHash: 'a', verdict: 'repair', summary: 'failed', issues: [], tests: [{ command: 'test', passed: false, output: 'engineering error' }] } }); runOutcomeReviews(f.store, at); const r = outcomeReviewViews(f.store, p, at)[0]?.latestReview; expect(r?.status).toBe('observing'); expect(r?.taskState).toBe('cancelled'); expect(r?.failedTests).toHaveLength(1); });
it('keeps temporary outcome derivatives off disk and removes them on restart', async () => { const { recordOutcomeEvidence, runOutcomeReviews, outcomeReviewViews } = await api(); const f = fixture(true); const quote = 'PRIVATE_OUTCOME_SENTINEL'; const temp = reference(f, quote, 'private-reference', true); const input = { projectId: 'p', domain: 'personal', kind: 'correction', sourceId: temp.id, sourceRevision: temp.revision, quote, observedAt: f.snapshot.recordedAt }; const at = new Date(f.snapshot.reviewAt!); recordOutcomeEvidence(f.store, f.config, f.snapshot.id, input, 'owner', at); runOutcomeReviews(f.store, at); expect(outcomeReviewViews(f.store, p, at)).toHaveLength(1); f.store.close(); expect(readFileSync(f.db).includes(Buffer.from(quote))).toBe(false); const next = new Store(f.db); stores.push(next); expect(outcomeReviewViews(next, p, at)).toEqual([]); });
it('does not certify an unbound or untrusted receipt as current delivery', async () => {
    const { recordOutcomeEvidence, runOutcomeReviews, outcomeReviewViews } = await api();
    const f = fixture(), at = new Date(f.snapshot.reviewAt!);
    const input = raw(f, metric(f)), s = f.store.get('sources', input.sourceId)!;
    recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, attribution: { method: 'direct_measurement', citations: [{ sourceId: s.id, revision: s.revision, quote: input.quote, locator: s.locator }] } }, 'owner', at);
    f.store.save('receipts', { id: 'unbound', taskId: f.task.id, projectId: 'p', domain: 'personal', repository: p.repository, path: p.prdPath, pullRequestUrl: 'https://example.com/1', pullRequestNumber: 1, headSha: 'head', mergeSha: 'merged', contentHash: 'invented hash', verifiedAt: f.snapshot.recordedAt, checks: [{ name: 'test', conclusion: 'success', headSha: 'head', appId: 1, url: 'https://example.com/check' }] });
    runOutcomeReviews(f.store, at);
    expect(outcomeReviewViews(f.store, p, at)[0]?.latestReview?.status).toBe('observing');
});
it('uses seven days for legacy snapshots independently of current settings', async () => {
    const { runOutcomeReviews, outcomeReviewViews } = await api();
    const f = fixture();
    const legacy: DecisionSnapshot = { ...f.snapshot, reviewAt: undefined, reviewIntervalDays: undefined };
    const a = f.store.get('actions', legacy.id)!;
    f.store.save('actions', { ...a, payload: { snapshot: legacy } });
    const due = new Date(Date.parse(legacy.recordedAt) + 7 * 86400000);
    expect(runOutcomeReviews(f.store, new Date(+due - 1))).toBe(0);
    expect(runOutcomeReviews(f.store, due)).toBe(1);
    expect(outcomeReviewViews(f.store, p, due)[0]?.reviewIntervalDays).toBe(7);
});
it('normalizes equivalent timezone instants while retaining exact original JSON', async () => {
    const { recordOutcomeEvidence } = await api();
    const f = fixture();
    const utc = new Date(Date.parse(f.snapshot.recordedAt) + 86400000).toISOString();
    const offset = utc.replace('Z', '+00:00');
    const input = raw(f, metric(f, { periodEnd: offset }));
    const e = recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, observedAt: utc }, 'owner', new Date(f.snapshot.reviewAt!));
    expect(e.quote).toContain(offset);
    expect(e.metric?.periodEnd).toBe(utc);
});
it('does not reuse historical reports after a referenced source revision changes', async () => {
    const { recordOutcomeEvidence, runOutcomeReviews, outcomeReviewViews } = await api();
    const f = fixture(), at = new Date(f.snapshot.reviewAt!);
    const input = raw(f, metric(f));
    recordOutcomeEvidence(f.store, f.config, f.snapshot.id, input, 'owner', at);
    runOutcomeReviews(f.store, at);
    reference(f, metric(f, { value: 13 }));
    const view = outcomeReviewViews(f.store, p, at)[0]!;
    expect(view.evidence).toEqual([]);
    expect(view.latestReview).toBeUndefined();
    expect(f.store.list('actions').filter(a => a.kind === 'decision.review')).toHaveLength(1);
    expect(runOutcomeReviews(f.store, at)).toBe(1);
    expect(outcomeReviewViews(f.store, p, at)[0]?.latestReview?.status).toBe('observing');
});
it.each(['none', 'unknown_sample', 'before_delivery'] as const)('keeps %s measurement observing even with a valid delivery', async (mode) => {
    const { recordOutcomeEvidence, runOutcomeReviews, outcomeReviewViews } = await api();
    const f = fixture(), at = new Date(f.snapshot.reviewAt!);
    f.store.save('tasks', { ...f.task, artifact: { taskVersion: 1, planHash: 'p', baselineSha: 'base', files: [{ path: p.prdPath, content: 'Delivered' }], tests: [{ command: 'test', passed: true, output: 'passed' }], summary: 'Delivery' } });
    f.store.save('receipts', { id: 'receipt', taskId: f.task.id, projectId: 'p', domain: 'personal', repository: p.repository, path: p.prdPath, pullRequestUrl: 'https://example.com/1', pullRequestNumber: 1, headSha: 'head', mergeSha: 'merge', contentHash: digest('Delivered'), verifiedAt: mode === 'before_delivery' ? new Date(Date.parse(f.snapshot.recordedAt) + 1000).toISOString() : f.snapshot.recordedAt, checks: [{ name: 'test', conclusion: 'success', headSha: 'head', appId: 1, url: 'https://example.com/check' }] });
    const input = raw(f, metric(f, mode === 'unknown_sample' ? { sampleSize: undefined } : {})), s = f.store.get('sources', input.sourceId)!;
    recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, ...(mode === 'none' ? {} : { attribution: { method: 'direct_measurement', citations: [{ sourceId: s.id, revision: s.revision, quote: input.quote, locator: s.locator }] } }) }, 'owner', at);
    runOutcomeReviews(f.store, at);
    const r = outcomeReviewViews(f.store, p, at)[0]?.latestReview;
    expect(r?.receiptIds).toEqual(['receipt']);
    expect(r?.status).toBe('observing');
    expect(r?.gaps.length).toBeGreaterThan(0);
});
it('requires current exact attribution material and validates original successful host attempt', async () => {
    const { recordOutcomeEvidence } = await api();
    const f = fixture(), at = new Date(f.snapshot.reviewAt!);
    const input = raw(f, metric(f)), s = f.store.get('sources', input.sourceId)!;
    for (const citations of [[], [{ sourceId: s.id, revision: s.revision, quote: 'absent', locator: s.locator }], [{ sourceId: s.id, revision: 'old', quote: input.quote, locator: s.locator }]]) {
        expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, attribution: { method: 'direct_measurement', citations } }, 'owner', at)).toThrow();
    }
    f.store.save('attempts', { ...f.store.get('attempts', 'attempt')!, status: 'failed' });
    expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, input, 'owner', at)).toThrow(/judgment/);
});
it.each(['cancelled', 'archived', 'blocked'] as const)('records %s separately and never mutates the subject or principles', async (status) => {
    const { runOutcomeReviews, outcomeReviewViews } = await api();
    const f = fixture(), at = new Date(f.snapshot.reviewAt!);
    f.store.save('tasks', { ...f.task, status, updatedAt: at.toISOString() });
    const before = f.store.get('tasks', f.task.id);
    runOutcomeReviews(f.store, at);
    const r = outcomeReviewViews(f.store, p, at)[0]?.latestReview;
    expect(r?.status).toBe('observing');
    expect(r?.taskState).toBe(status);
    expect(f.store.get('tasks', f.task.id)).toEqual(before);
    expect(f.store.list('rules')).toEqual([]);
});
it('retracts primary subjects and their readable review evidence durably', async () => {
    const { recordOutcomeEvidence, runOutcomeReviews, outcomeReviewViews } = await api();
    const f = fixture(), at = new Date(f.snapshot.reviewAt!);
    const input = raw(f, 'PRIMARY_WITHDRAWAL_DERIVATIVE', 'correction');
    recordOutcomeEvidence(f.store, f.config, f.snapshot.id, input, 'owner', at);
    runOutcomeReviews(f.store, at);
    withdrawSource(f.store, f.task.sourceId);
    expect(outcomeReviewViews(f.store, p, at)).toEqual([]);
    expect(JSON.stringify(f.store.list('actions'))).not.toContain(input.quote);
    f.store.close();
    const next = new Store(f.db);
    stores.push(next);
    expect(outcomeReviewViews(next, p, at)).toEqual([]);
    expect(runOutcomeReviews(next, at)).toBe(0);
});
it('rejects conflicting retry metadata and observations before the judgment', async () => {
    const { recordOutcomeEvidence } = await api();
    const f = fixture(), at = new Date(f.snapshot.reviewAt!);
    const input = raw(f, 'A source reported failure', 'failure');
    const e = recordOutcomeEvidence(f.store, f.config, f.snapshot.id, input, 'owner', at);
    expect(e.kind).toBe('failure');
    expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, observedAt: new Date(Date.parse(input.observedAt) + 1000).toISOString() }, 'owner', at)).toThrow(/conflicting/);
    expect(() => recordOutcomeEvidence(f.store, f.config, f.snapshot.id, { ...input, observedAt: new Date(Date.parse(f.snapshot.recordedAt) - 1).toISOString() }, 'owner', at)).toThrow(/time/);
});
it('includes later owner cases for answered subjects without replacing the initial judgment', async () => {
    const { recordOwnerDecision } = await import('../../src/standards.js');
    const { runOutcomeReviews, outcomeReviewViews } = await api();
    const f = fixture();
    const option = { label: 'Retain', description: 'Retain a draft', rationale: 'Recovery', tradeoff: 'Storage', evidenceUrls: ['https://example.com/source'] };
    const question = { id: 'q', projectId: 'p', domain: 'personal', taskId: f.task.id, taskVersion: 1, version: 1, ownerId: 'owner', title: 'Retain?', context: 'An owner choice', options: { A: option, B: { ...option, label: 'Delete' } }, research: { queries: [], summary: '', gaps: [] }, status: 'answered' as const, createdAt: f.snapshot.recordedAt, decisionSnapshotId: f.snapshot.id };
    f.store.save('questions', question);
    const c = recordOwnerDecision(f.store, f.task, question, { questionId: 'q', taskVersion: 1, questionVersion: 1, choice: 'A', actorId: 'owner', eventId: 'answer' });
    const at = new Date(f.snapshot.reviewAt!);
    runOutcomeReviews(f.store, at);
    const v = outcomeReviewViews(f.store, p, at)[0]!;
    expect(v.latestReview?.ownerChoices).toEqual([{ caseId: c.id, choice: 'A', createdAt: c.createdAt }]);
    expect(v.snapshot.decision.summary).toBe('Judgment');
    expect(outcomeReviewViews(f.store, p, new Date(Date.parse(f.snapshot.recordedAt) - 1))).toEqual([]);
});
it('copies only failed planned checks into a review', async () => {
 const {runOutcomeReviews,outcomeReviewViews}=await api();const f=fixture(),at=new Date(f.snapshot.reviewAt!);
 f.store.save('tasks',{...f.task,updatedAt:at.toISOString(),plan:{taskVersion:1,sourceRevision:f.task.sourceRevision,baselineSha:'base',summary:'Plan',paths:[p.prdPath],steps:['Update'],tests:['planned'],stopConditions:['change']},artifact:{taskVersion:1,planHash:'p',baselineSha:'base',files:[{path:p.prdPath,content:'Changed'}],summary:'Artifact',tests:[{command:'planned',passed:false,output:'failure'},{command:'unrelated',passed:false,output:'not a planned check'}]}});
 runOutcomeReviews(f.store,at);expect(outcomeReviewViews(f.store,p,at)[0]?.latestReview?.failedTests).toEqual([{command:'planned',passed:false,output:'failure'}]);
});

it.each([' ', '\t', '\n'] as const)('rejects blank source or attribution quote %j without trimming valid originals', async blank => {
    const {recordOutcomeEvidence}=await api();const f=fixture(),at=new Date(f.snapshot.reviewAt!);
    const text=' \t\n Source-reported attribution \n\t ';
    const s=reference(f,text,'substantive-attribution');
    const input=raw(f,metric(f));
    expect(()=>recordOutcomeEvidence(f.store,f.config,f.snapshot.id,{...input,kind:'correction',sourceId:s.id,sourceRevision:s.revision,quote:blank},'owner',at)).toThrow();
    expect(()=>recordOutcomeEvidence(f.store,f.config,f.snapshot.id,{...input,attribution:{method:'direct_measurement',citations:[{sourceId:s.id,revision:s.revision,quote:blank,locator:s.locator}]}},'owner',at)).toThrow();
    const correction=recordOutcomeEvidence(f.store,f.config,f.snapshot.id,{...input,kind:'correction',sourceId:s.id,sourceRevision:s.revision,quote:text},'owner',at);
    expect(correction.quote).toBe(text);
    const recorded=recordOutcomeEvidence(f.store,f.config,f.snapshot.id,{...input,attribution:{method:'direct_measurement',citations:[{sourceId:s.id,revision:s.revision,quote:text,locator:s.locator}]}},'owner',at);
    expect(recorded.attribution.citations[0]?.quote).toBe(text);
});

it('associates an owner answer only with its actual snapshot on a rejudged task', async () => {
    const {recordOwnerDecision}=await import('../../src/standards.js');const {runOutcomeReviews,outcomeReviewViews}=await api();const f=fixture();
    const taskB={...f.task,version:2};f.store.save('tasks',taskB);
    const input={task:taskB,source:f.store.get('sources',taskB.sourceId)!,project:f.config.projects[0],role:'decide',cards:[],facts:[],rules:[]} as WorkerInput;
    f.store.save('attempts',{...f.store.get('attempts','attempt')!,id:'attempt-B',taskVersion:2,inputHash:digest(input)});
    const snapshotB=recordDecisionSnapshot(f.store,taskB,input,{action:'proceed',summary:'Judgment B',rationale:'New judgment',citations:[],ruleIds:[]});
    const option={label:'Retain',description:'Retain a draft',rationale:'Recovery',tradeoff:'Storage',evidenceUrls:['https://example.com/source']};
    const question={id:'question-B',projectId:'p',domain:'personal',taskId:taskB.id,taskVersion:2,version:1,ownerId:'owner',title:'Retain?',context:'An owner choice',options:{A:option,B:{...option,label:'Delete'}},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:snapshotB.recordedAt,decisionSnapshotId:snapshotB.id};
    f.store.save('questions',question);
    const c=recordOwnerDecision(f.store,taskB,question,{questionId:question.id,taskVersion:2,questionVersion:1,choice:'B',actorId:'owner',eventId:'answer-B'});
    const at=new Date(snapshotB.reviewAt!);runOutcomeReviews(f.store,at);
    const views=outcomeReviewViews(f.store,p,at);
    expect(views.find(v=>v.snapshotId===f.snapshot.id)?.latestReview?.ownerChoices).toEqual([]);
    expect(views.find(v=>v.snapshotId===snapshotB.id)?.latestReview?.ownerChoices.map(choice=>choice.caseId)).toEqual([c.id]);
});

it('keeps verified delivery alone observing with an explicit missing measurement gap',async()=>{
 const {runOutcomeReviews,outcomeReviewViews}=await api();const f=fixture(),at=new Date(f.snapshot.reviewAt!);
 f.store.save('tasks',{...f.task,status:'delivered',artifact:{taskVersion:1,planHash:'p',baselineSha:'base',files:[{path:p.prdPath,content:'Delivered'}],tests:[{command:'test',passed:true,output:'passed'}],summary:'Delivery'}});
 f.store.save('receipts',{id:'delivery-only',taskId:f.task.id,projectId:'p',domain:'personal',repository:p.repository,path:p.prdPath,pullRequestUrl:'https://example.com/1',pullRequestNumber:1,headSha:'head',mergeSha:'merge',contentHash:digest('Delivered'),verifiedAt:f.snapshot.recordedAt,checks:[{name:'test',conclusion:'success',headSha:'head',appId:1,url:'https://example.com/check'}]});
 runOutcomeReviews(f.store,at);const review=outcomeReviewViews(f.store,p,at)[0]?.latestReview;
 expect(review?.receiptIds).toEqual(['delivery-only']);expect(review?.status).toBe('observing');expect(review?.evidence).toEqual([]);expect(review?.gaps).toContain('No current quoted measurement.');
});
it.each([' ', '\t', '\n'] as const)('rejects whitespace-only attribution material %j',async quote=>{
 const {recordOutcomeEvidence}=await api();const f=fixture(),at=new Date(f.snapshot.reviewAt!);const s=reference(f,' \t\n Source-reported material','blank-attribution');const input=raw(f,metric(f));
 expect(()=>recordOutcomeEvidence(f.store,f.config,f.snapshot.id,{...input,attribution:{method:'controlled_comparison',citations:[{sourceId:s.id,revision:s.revision,quote,locator:s.locator}]}},'owner',at)).toThrow();
});

it.each([true,false])('requires an independent question binding for legacy decision IDs (bound=%s)',async bound=>{
 const {recordOwnerDecision}=await import('../../src/standards.js');const {runOutcomeReviews,outcomeReviewViews}=await api();const f=fixture();
 const option={label:'Retain',description:'Retain',rationale:'Recovery',tradeoff:'Storage',evidenceUrls:['https://example.com/source']};
 const q={id:'legacy-q',projectId:'p',domain:'personal',taskId:f.task.id,taskVersion:1,version:1,ownerId:'owner',title:'Retain?',context:'Choice',options:{A:option,B:option},research:{queries:[],summary:'',gaps:[]},status:'answered' as const,createdAt:f.snapshot.recordedAt,decisionSnapshotId:f.snapshot.id};
 f.store.save('questions',q);const c=recordOwnerDecision(f.store,f.task,q,{questionId:q.id,taskVersion:1,questionVersion:1,choice:'A',actorId:'owner',eventId:'answer'});
 const {stableId}=await import('../../src/domain.js');f.store.save('cases',{...c,decisionSnapshot:undefined,decisionId:stableId('decision',f.task.id,1)});
 if(!bound)f.store.save('questions',{...q,decisionSnapshotId:undefined});
 const at=new Date(f.snapshot.reviewAt!);runOutcomeReviews(f.store,at);
 expect(outcomeReviewViews(f.store,p,at)[0]?.latestReview?.ownerChoices.map(v=>v.caseId)).toEqual(bound?[c.id]:[]);
});
