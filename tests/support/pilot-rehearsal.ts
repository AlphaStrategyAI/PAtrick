import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAnswerGate, type BindQuestionInput, type Principal } from '../../packages/domain/src/answer-gate.js';
import { createDelegationApi, type AdmissionPrincipal, type RunGrant } from '../../packages/domain/src/delegation.js';
import { createEffectRepository } from '../../packages/domain/src/effects.js';
import { createStandardsApi } from '../../packages/domain/src/standards.js';
import {
  claimContinuation, confirmCollectedEvidence, recordCollectionRound, type ResumeKey,
} from '../../packages/domain/src/work-continuation.js';
import { createGitHubClient, createPrPublisher } from '../../packages/integrations/publisher/github.js';
import { buildWorkspace, createPrBuildVerifier, gitBlobSha, planPath } from '../../packages/integrations/publisher/build.js';
import { runAttempt } from '../../packages/executor/src/wrapper.js';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import type { PilotTrace } from './pilot-trace.js';

/**
 * The three pilot routes, rehearsed against the local domain.
 *
 * Each route runs the real domain: the source dispatch opens the work, the
 * delegation admits the grant, the answer gate decides, and the publisher
 * creates and verifies the pull request. The fault fixtures are the ones the
 * plan names: the answered route continues the work only after the answer is
 * recorded, and the blocked route answers a card that is already stale, so
 * nothing is published.
 */

const DOMAIN = 'product';
const GENERATION = 1;
const TARGET = { owner: 'approved', repo: 'plans', repoId: '123', baseRef: 'main' };
const RESOURCE = 'github:123';
const AUTHORITY = { repoId: TARGET.repoId, rulesetId: 1234, appId: 3456 };
const BASE = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const BASE_TREE = '1'.repeat(40);
const ARTIFACT = { headSha: HEAD, treeSha: TREE, baseSha: BASE, title: 'Plan for approval', body: 'Candidate plan' };

const owner: AdmissionPrincipal = {
  account_id: 'owner', caller_id: 'service', auth_epoch: 1, domains: [DOMAIN], operations: ['owner'],
};
const web: Principal = {
  account_id: 'owner', caller_id: 'web', auth_epoch: 1, domains: [DOMAIN], operations: ['owner', 'questions.answer'],
};

export type RouteOutcome = {
  route: PilotTrace['route'];
  workId: string;
  sourceRevision: string;
  standardRevision: string;
  evidenceEpoch: number;
  caseId: string | null;
  grantId: string | null;
  answerReceiptId: string | null;
  answerValidity: string | null;
  pr: { effectId: string; headSha: string; treeSha: string } | null;
  observedWorkIds: string[];
  verifiedPrCount: number;
  unauthorizedEffects: number;
};

export type Rehearsal = {
  outcomes: RouteOutcome[];
  evidenceRoot: string;
  close(): void;
};

export async function rehearsePilotRoutes(options: { root: string; now: () => Date }): Promise<Rehearsal> {
  const evidenceRoot = join(options.root, 'evidence');
  mkdirSync(evidenceRoot, { recursive: true });
  const scenes = await Promise.all([
    scene(options, 'direct-pr', 'delivery'), scene(options, 'answered-pr', 'judgment'),
    scene(options, 'stale-blocked', 'judgment'),
  ]);
  const [direct, answered, blocked] = scenes;
  try {
    const outcomes: RouteOutcome[] = [];
    outcomes.push(await directRoute(direct));
    outcomes.push(await answeredRoute(answered));
    outcomes.push(await blockedRoute(blocked));
    return {
      outcomes,
      evidenceRoot,
      close() { for (const item of scenes) item.close(); },
    };
  } catch (error) {
    for (const item of scenes) item.close();
    throw error;
  }
}

type Scene = {
  db: SqliteDatabase;
  now: () => Date;
  workId: string;
  sourceRevision: string;
  /** The grant that admits the judgment or the publication of this route. */
  grant: (grantPhase?: 'delivery' | 'judgment') => Promise<RunGrant>;
  /** Publishes the frozen build and returns the verified receipt. */
  publish: (grant: RunGrant) => Promise<{ pr: { effectId: string; headSha: string; treeSha: string }; caseId: string } | null>;
  /** Ends the judgment attempt, so the answer may continue the work. */
  closeJudgment: (grant: RunGrant) => Promise<void>;
  close(): void;
};

async function scene(options: { root: string; now: () => Date }, route: PilotTrace['route'],
  phase: 'delivery' | 'judgment'): Promise<Scene> {
  const dir = join(options.root, route);
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(join(dir, 'state.sqlite'));
  db.prepare("INSERT INTO accounts VALUES ('owner', 1, 1, ?)").run(options.now().toISOString());
  db.prepare("INSERT INTO caller_scopes VALUES (?, ?, ?, 'publish_pr', NULL)").run(owner.account_id, owner.caller_id, DOMAIN);
  const blobs = createBlobStore(join(dir, 'blobs'));
  const registry = createSourceRegistry(db, { blobs, now: () => options.now().toISOString() });
  const sourcePath = join(dir, 'source');
  mkdirSync(sourcePath);
  writeFileSync(join(sourcePath, 'demand.md'), `Demand for ${route}\n`);
  const source = await registry.enableSource({ accountId: owner.account_id, dataDomain: DOMAIN }, {
    type: 'directory', target: sourcePath, hasTriggerRule: true, excludes: [], frequency: 'poll', history: 'none',
  });
  await registry.collectSource(source.sourceId, source.configRevision);
  const { event_id: workId } = db.prepare("SELECT event_id FROM outbox WHERE destination = 'source-work'").get() as { event_id: string };
  const sourceRevision = workId.slice('work:'.length);
  await createStandardsApi(db, owner, { domain: DOMAIN, now: options.now }).seedProductDataset();
  const scope = {
    actions: ['judge', 'collect', 'publish_pr'], resources: ['work', RESOURCE],
    effects: ['publish_pr'], domains: [DOMAIN], risk: 'low', level: 'L1' as const, budget_micros: 5000,
  };
  const delegation = createDelegationApi(db, owner, { domain: DOMAIN, now: options.now });
  await delegation.registerMandateType({ type_id: 'type', ...scope, config_version: 1 });
  await delegation.openMandate({ mandate_id: 'mandate', type_id: 'type', ...scope, expires_at: '2026-12-01T00:00:00Z' });
  await delegation.setCapability({ profile_id: 'profile', level: 'L2', actions: scope.actions,
    report_id: 'report', report_version: 1, config_version: 1 });
  await delegation.openWork({ work_id: workId, generation: GENERATION, mandate_id: 'mandate',
    phase, next_action: phase === 'delivery' ? 'publish_pr' : 'judge', budget_micros: 5000 });
  if (phase === 'delivery') await delegation.setWorkGate(workId, GENERATION, { evidence_ready: true });
  const artifactsRoot = join(dir, 'jobs');
  const receiptsRoot = join(dir, 'receipts');
  mkdirSync(artifactsRoot, { recursive: true });
  mkdirSync(receiptsRoot, { recursive: true });
  const github = githubFixture();
  const remote = createGitHubClient({ fetch: github.fetch, branchAuthority: AUTHORITY,
    writeAuthorization: () => 'rehearsal-write-credential', assertWriteAllowed() {} });
  const repository = () => createEffectRepository(db, owner, { domain: DOMAIN, now: options.now, target: TARGET,
    verifyBuild: createPrBuildVerifier(remote, { artifactsRoot, receiptsRoot, blobs }) });
  const publisher = () => createPrPublisher(repository(), remote);
  const database = db;
  /** Runs the backend in isolation so the publication carries a sealed attempt. */
  async function runLocalPlan(grant: RunGrant) {
    if (grant.subject_kind !== 'work') throw new Error('REHEARSAL_GRANT_KIND');
    const context = { workId, generation: GENERATION, attemptId: grant.attempt_id };
    const job = buildWorkspace(artifactsRoot, context);
    const { content_hash: sourceHash } = db.prepare('SELECT content_hash FROM source_revisions WHERE revision_id = ?')
      .get(sourceRevision) as { content_hash: string };
    const sourceBytes = await blobs.readBlob(sourceHash);
    const contents = `# Candidate plan\n\nSource revision: ${sourceRevision}\n\nProposed steps.\n`;
    github.seedPlan(planPath(context), gitBlobSha(Buffer.from(contents)));
    mkdirSync(job, { recursive: true });
    const binaries = join(dir, 'binaries');
    mkdirSync(binaries, { recursive: true });
    const eventLines = [
      { type: 'thread.started', thread_id: 'rehearsal-thread' },
      { type: 'item.completed', item: { type: 'agent_message', text: contents } },
      { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 3, cached_input_tokens: 0 } },
    ].map((event) => JSON.stringify(event)).join('\n');
    writeFileSync(join(binaries, 'codex'), `#!${process.execPath}
process.stdout.write(${JSON.stringify(eventLines)});
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = binaries;
    try {
      return await runAttempt({
        backend: 'codex', subject: { kind: 'work', work_id: workId, generation: GENERATION,
          next_action: grant.next_action, resume_phase: null, judgment_basis: { hash: grant.basis_hash, evidence_watermark: 0 } },
        home: job, config_hash: 'rehearsal-config', cwd: job, session_id: null, bundle_present: true, controller: 'run',
        terminal: null, resume: null, ledger_dir: buildWorkspace(receiptsRoot, context), paid: null,
        deliveryPlan: { source_revision: sourceRevision, source_sha256: sourceHash, sourceBytes },
      }, grant, { db, principal: owner, now: options.now });
    } finally { process.env.PATH = previousPath; }
  }
  return {
    db,
    now: options.now,
    workId,
    sourceRevision,
    async grant(grantPhase: 'delivery' | 'judgment' = phase) {
      return delegation.authorizeAction({
        work_id: workId, generation: GENERATION, attempt_id: `${route}-${grantPhase}`, phase: grantPhase,
        next_action: grantPhase === 'delivery' ? 'publish_pr' : 'judge',
        allowed_effects: grantPhase === 'delivery' ? ['publish_pr'] : [], expires_at: '2026-12-01T00:00:00Z',
      });
    },
    async closeJudgment(grant: RunGrant) {
      await delegation.revokeGrant(grant.grant_id);
      // The judgment attempt is over, so the answer may open the next one.
      database.prepare('UPDATE work_generations SET attempt_closed=1, process_tree_stopped=1, effects_reconciled=1, '
+ "control_state='stopped' WHERE work_id=? AND generation=?").run(workId, GENERATION);
    },
    async publish(grant: RunGrant): Promise<{ pr: { effectId: string; headSha: string; treeSha: string }; caseId: string } | null> {
      const attempt = await runLocalPlan(grant);
      if (attempt.classification !== 'agent_completed') return null;
      const artifact = ARTIFACT;
      // The work's own case is the one the build was prepared from.
      const caseId = await repository().prepareBuild({ workId, generation: GENERATION, grant, artifact });
      const { intentId } = repository().freezePr({ workId, generation: GENERATION, caseId, grant, artifact });
      const receipt = await publisher().publishPr(intentId);
      if (receipt.status !== 'verified' || !receipt.proof) return null;
      return { pr: { effectId: receipt.intentId, headSha: receipt.proof.headSha, treeSha: receipt.proof.treeSha }, caseId };
    },
    close() { db.close(); },
  };
}

/** The direct route publishes without waiting for an answer. */
async function directRoute(scene: Scene): Promise<RouteOutcome> {
  const grant = await scene.grant('delivery');
  const published = await scene.publish(grant);
  const pr = published?.pr ?? null;
  const basis = basisOf(scene);
  return {
    route: 'direct-pr',
    workId: scene.workId,
    sourceRevision: scene.sourceRevision,
    standardRevision: basis.standardRevision,
    evidenceEpoch: basis.evidenceEpoch,
    caseId: published?.caseId ?? null,
    grantId: grant.grant_id,
    answerReceiptId: null,
    answerValidity: null,
    pr,
    observedWorkIds: [scene.workId],
    verifiedPrCount: pr ? 1 : 0,
    unauthorizedEffects: unauthorizedEffects(scene),
  };
}

/** The answered route waits for the answer and then continues to the publication. */
async function answeredRoute(scene: Scene): Promise<RouteOutcome> {
  // The judgment grant freezes the basis the question is bound to.
  const judgment = await scene.grant('judgment');
  const gate = createAnswerGate(scene.db, { domain: DOMAIN, now: scene.now, hub: localHub(), encode: encodeHubAnswer });
  const binding = await gate.bindQuestion(web, questionInput(scene.workId));
  const payload = { work_id: scene.workId, generation: GENERATION, question_id: binding.question_id,
    question_version: binding.question_version, proposal_revision: binding.proposal_revision,
    options_hash: binding.options_hash, answer: { kind: 'option' as const, option_id: 'A' } };
  const answer = await gate.submitAnswer(web, {
    client_request_id: 'rehearsal-answer', expected_revision: binding.proposal_revision, entry: 'web',
    payload, payload_hash: sha256(canonicalPayload(payload as unknown as Json)),
  });
  // The verified answer ends the judgment attempt.
  await scene.closeJudgment(judgment);
  // The continuation follows the hub answer event, not the receipt id.
  const grant = await continuationGrant(scene, binding.question_id, answer.hub_answer_event_id ?? answer.receipt_id);
  const published = grant ? await scene.publish(grant) : null;
  const pr = published?.pr ?? null;
  const basis = basisOf(scene);
  return {
    route: 'answered-pr',
    workId: scene.workId,
    sourceRevision: scene.sourceRevision,
    standardRevision: basis.standardRevision,
    evidenceEpoch: basis.evidenceEpoch,
    caseId: published?.caseId ?? null,
    grantId: grant?.grant_id ?? null,
    answerReceiptId: answer.receipt_id,
    answerValidity: answer.validity,
    pr,
    observedWorkIds: [scene.workId],
    verifiedPrCount: pr ? 1 : 0,
    unauthorizedEffects: unauthorizedEffects(scene),
  };
}

/** The blocked route answers a card that is already stale, so nothing is published. */
async function blockedRoute(scene: Scene): Promise<RouteOutcome> {
  await scene.grant('judgment');
  const gate = createAnswerGate(scene.db, { domain: DOMAIN, now: scene.now, hub: localHub(), encode: encodeHubAnswer });
  const binding = await gate.bindQuestion(web, questionInput(scene.workId));
  const payload = { work_id: scene.workId, generation: GENERATION, question_id: binding.question_id,
    question_version: binding.question_version, proposal_revision: binding.proposal_revision,
    options_hash: binding.options_hash, answer: { kind: 'option' as const, option_id: 'A' } };
  const answer = await gate.submitAnswer(web, {
    client_request_id: 'rehearsal-stale', expected_revision: binding.proposal_revision + 1, entry: 'web',
    payload, payload_hash: sha256(canonicalPayload(payload as unknown as Json)),
  });
  const basis = basisOf(scene);
  return {
    route: 'stale-blocked',
    workId: scene.workId,
    sourceRevision: scene.sourceRevision,
    standardRevision: basis.standardRevision,
    evidenceEpoch: basis.evidenceEpoch,
    caseId: null,
    grantId: null,
    answerReceiptId: answer.receipt_id,
    answerValidity: answer.validity,
    pr: null,
    observedWorkIds: [scene.workId],
    verifiedPrCount: 0,
    unauthorizedEffects: unauthorizedEffects(scene),
  };
}

/** The work waits for the verified answer, collects the material and continues to the delivery. */
async function continuationGrant(scene: Scene, questionId: string, answerEventId: string): Promise<RunGrant | null> {
  const key: ResumeKey = { work_id: scene.workId, generation: GENERATION, question_id: questionId,
    answer_event_id: answerEventId, phase: 'answer' };
  scene.db.prepare("INSERT OR IGNORE INTO work_stages VALUES (?, ?, 'waiting_evidence', ?)").run(scene.workId, GENERATION,
    scene.now().toISOString());
  const collecting = claimContinuation(scene.db, owner, DOMAIN, key, 'collection', scene.now());
  if (collecting.status !== 'claimed') return null;
  recordCollectionRound(scene.db, owner, { question_id: questionId, material: 'material', evidence_ref: 'material' },
    scene.now());
  confirmCollectedEvidence(scene.db, owner, DOMAIN, key, 'material', scene.now());
  const delivery = claimContinuation(scene.db, owner, DOMAIN, { ...key, phase: 'evidence_ready' }, 'delivery', scene.now());
  return delivery.status === 'claimed' ? delivery.grant : null;
}

function basisOf(scene: Scene): { standardRevision: string; evidenceEpoch: number } {
  const row = scene.db.prepare('SELECT standards_json, evidence_watermark FROM judgment_bases WHERE work_id = ? AND generation = ?')
    .get(scene.workId, GENERATION) as { standards_json: string; evidence_watermark: number } | undefined;
  if (!row) throw new Error('REHEARSAL_BASIS_MISSING');
  const standards = JSON.parse(row.standards_json) as { version?: string }[];
  return { standardRevision: standards[0]?.version ?? 'none', evidenceEpoch: row.evidence_watermark };
}

function unauthorizedEffects(scene: Scene): number {
  const row = scene.db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE json_extract(payload, '$.type') = 'work.effect' "
    + "AND json_extract(payload, '$.authorized') IS NOT 1").get() as { n: number };
  return row.n;
}

function questionInput(workId: string): BindQuestionInput {
  return {
    question_id: 'rehearsal-question', question_version: 1, work_id: workId, generation: GENERATION,
    proposal_revision: 1, hub_card_id: 17, custom_allowed: false,
    options: [
      // The answer asks for one material before the work may continue.
      { option_id: 'A', index: 0, label: 'Option A', disposition: 'proceed', reason_code: null,
        next_action: 'collect:collection-1', difference: null, missing: [], collection_id: 'collection-1',
        expected_material: 'material' },
      { option_id: 'B', index: 1, label: 'Option B', disposition: 'deferred', reason_code: 'OUT_OF_SCOPE',
        next_action: 'ask_again', difference: 'other', missing: [], collection_id: null, expected_material: null },
    ],
    custom_rules: [],
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function localHub() {
  const stored = new Map<string, { cardId: number; state: string; answer_event_id: string; body: unknown }>();
  return {
    async accept(questionId: string, cardId: number, body: unknown) {
      const answerEventId = `answer-event-${questionId}`;
      stored.set(questionId, { cardId, state: 'answered', answer_event_id: answerEventId, body });
      return { changed: true, state: 'answered', answer_event_id: answerEventId };
    },
    async read(questionId: string) { return (stored.get(questionId) ?? null) as never; },
  };
}

function encodeHubAnswer(answer: { kind: 'choice'; index: number } | { kind: 'custom'; raw_text: string }):
  { choice: number } | { text: string } {
  return answer.kind === 'choice' ? { choice: answer.index } : { text: answer.raw_text };
}

function githubFixture() {
  type Pull = { number: number; head: string; headRepo: number; baseRepo: number; branch: string;
    baseRef: string; state: 'open' | 'closed'; merged: boolean; updated: string };
  const base = BASE;
  let branch: string | undefined;
  let branchHead: string | undefined;
  let pull: Pull | undefined;
  const commits = new Map([[HEAD, { tree: TREE, parents: [BASE] }], [BASE, { tree: BASE_TREE, parents: [] }]]);
  type Entry = { path: string; type: string; mode: string; sha: string };
  const stable = { path: 'README.md', type: 'blob', mode: '100644', sha: '3'.repeat(40) };
  const trees = new Map<string, Entry[]>([[BASE_TREE, [stable]]]);
  let planEntry: Entry | undefined;
  const outputBlobs = new Map<string, Buffer>();
  const gitObject = (type: string, bytes: Buffer) =>
    execFileSync('git', ['hash-object', '-t', type, '--stdin'], { input: bytes, encoding: 'utf8' }).trim();
  const render = (pr: Pull) => ({
    number: pr.number, state: pr.state, merged: pr.merged, merged_at: pr.merged ? pr.updated : null, updated_at: pr.updated,
    head: { ref: pr.branch, sha: pr.head, repo: { id: pr.headRepo } },
    base: { ref: pr.baseRef, sha: base, repo: { id: pr.baseRepo } },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname).replace(/^\/repos\/approved\/plans/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (!path && method === 'GET') return Response.json({ id: 123, full_name: 'approved/plans' });
    if (path === '/rulesets/1234') return Response.json({
      id: 1234, source: 'approved/plans', source_type: 'Repository', target: 'branch', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/patrick/*'], exclude: [] } },
      bypass_actors: [{ actor_id: 3456, actor_type: 'Integration', bypass_mode: 'always' }],
      rules: ['creation', 'update', 'deletion'].map((type) => ({ type })),
    });
    if (path === '/git/ref/heads/main' && method === 'GET') {
      return Response.json({ ref: 'refs/heads/main', object: { sha: base, type: 'commit' } });
    }
    if (path.startsWith('/git/ref/heads/') && method === 'GET') {
      if (!branchHead || path !== '/git/ref/heads/' + branch) return new Response(null, { status: 404 });
      return Response.json({ ref: 'refs/heads/' + branch, object: { sha: branchHead, type: 'commit' } });
    }
    if (path.startsWith('/git/commits/') && method === 'GET') {
      const sha = path.split('/').at(-1) ?? '';
      const commit = commits.get(sha);
      return commit ? Response.json({ sha, tree: { sha: commit.tree }, parents: commit.parents.map((parent) => ({ sha: parent })) })
        : new Response(null, { status: 404 });
    }
    if (path.startsWith('/git/trees/') && method === 'GET') {
      const sha = path.split('/').at(-1) ?? '';
      const tree = trees.get(sha);
      return tree ? Response.json({ sha, tree, truncated: false }) : new Response(null, { status: 404 });
    }
    if (path === '/git/refs' && method === 'POST') {
      branch = String(body.ref).replace('refs/heads/', '');
      branchHead = String(body.sha);
      return Response.json({ ref: body.ref, object: { sha: body.sha, type: 'commit' } }, { status: 201 });
    }
    if (path.startsWith('/git/blobs/') && method === 'GET') {
      const sha = path.split('/').at(-1)!;
      const bytes = outputBlobs.get(sha);
      return bytes ? Response.json({ sha, size: bytes.length, content: bytes.toString('base64'), encoding: 'base64' })
        : new Response(null, { status: 404 });
    }
    if (path === '/git/blobs' && method === 'POST') {
      const bytes = Buffer.from(String(body.content), 'base64');
      const sha = gitObject('blob', bytes);
      outputBlobs.set(sha, bytes);
      return Response.json({ sha }, { status: 201 });
    }
    if (path === '/git/trees' && method === 'POST') {
      const baseTree = trees.get(String(body.base_tree)) ?? [];
      const nextTree = planEntry ? [...baseTree.filter((entry) => entry.path !== planEntry!.path), planEntry]
        : [...baseTree, ...(body.tree as Entry[])];
      const sha = gitObject('tree', Buffer.concat(nextTree.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
        .flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, 'hex')])));
      trees.set(sha, nextTree);
      return Response.json({ sha, tree: nextTree, truncated: false }, { status: 201 });
    }
    if (path === '/git/commits' && method === 'POST') {
      const author = body.author as { name: string; email: string; date: string };
      const identity = `${author.name} <${author.email}> ${Date.parse(author.date) / 1000} +0000`;
      const parents = body.parents as string[];
      const sha = gitObject('commit', Buffer.from(`tree ${body.tree}\n${parents.map((parent) => `parent ${parent}\n`).join('')}`
        + `author ${identity}\ncommitter ${identity}\n\n${body.message}\n`));
      commits.set(sha, { tree: String(body.tree), parents });
      return Response.json({ sha, tree: { sha: body.tree } }, { status: 201 });
    }
    if (path === '/git/refs/heads/' + branch && method === 'PATCH') {
      branchHead = String(body.sha);
      return Response.json({ ref: body.ref, object: { sha: body.sha, type: 'commit' } });
    }
    if (path === '/pulls' && method === 'POST') {
      pull = { number: 17, head: branchHead ?? String(body.sha), headRepo: 123, baseRepo: 123, branch: branch ?? 'patrick/unknown',
        baseRef: 'main', state: 'open', merged: false, updated: '2026-11-17T06:00:00Z' };
      return Response.json(render(pull), { status: 201 });
    }
    if (path.startsWith('/pulls/') && method === 'GET') {
      const number = Number(path.split('/').at(-1));
      if (!pull || pull.number !== number) return new Response(null, { status: 404 });
      return Response.json(render(pull));
    }
    if (path === '/pulls' && method === 'GET') return Response.json(pull ? [render(pull)] : []);
    return new Response(null, { status: 404 });
  };
  return {
    fetch,
    seedPlan(path: string, sha: string) {
      // The plan belongs to the new tree; the base tree stays without it.
      planEntry = { path, type: 'blob', mode: '100644', sha };
      trees.set(TREE, [stable, planEntry]);
    },
  };
}
