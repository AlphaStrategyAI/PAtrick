import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { createDelegationApi, type RunGrant } from '../../packages/domain/src/delegation.js';
import { createStandardsApi } from '../../packages/domain/src/standards.js';
import { createBlobStore } from '../../packages/storage/src/blob-store.js';
import { createSourceRegistry } from '../../packages/integrations/sources/registry.js';
import { openDatabase, type MigrationEntry } from '../../packages/storage/src/database.js';
import { createEffectRepository } from '../../packages/domain/src/effects.js';
import { createGitHubClient, createPrPublisher } from '../../packages/integrations/publisher/github.js';
import { buildWorkspace, createPrBuildVerifier, gitBlobSha, planPath } from '../../packages/integrations/publisher/build.js';
import { runAttempt } from '../../packages/executor/src/wrapper.js';
import { createOutcomeObserver } from '../../packages/integrations/publisher/outcomes.js';
import {
  claimContinuation, confirmCollectedEvidence, INSERT_RESUME_SQL, recordCollectionRound, type ResumeKey,
} from '../../packages/domain/src/work-continuation.js';

const NOW = '2026-11-16T12:00:00.000Z';
const UPDATE = '2026-11-16T14:00:00.000Z';
const NOW_FN = () => new Date(NOW);
const DOMAIN = 'product';
const GENERATION = 1;
const TARGET = { owner: 'approved', repo: 'plans', repoId: '123', baseRef: 'main' };
const RESOURCE = 'github:123';
const AUTHORITY = { repoId: TARGET.repoId, rulesetId: 1234, appId: 3456 };
const BASE = 'a'.repeat(40);
const NEW_BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const EDITED = 'e'.repeat(40);
const EDITED_TREE = 'f'.repeat(40);
const BASE_TREE = '1'.repeat(40);
const NEXT_BASE_TREE = '2'.repeat(40);
const artifact = { headSha: HEAD, treeSha: TREE, baseSha: BASE, title: 'Plan for approval', body: 'Candidate plan' };
const principal = {
  account_id: 'owner', caller_id: 'service', auth_epoch: 1,
  domains: [DOMAIN], operations: ['owner'],
};
const options = { domain: DOMAIN, now: NOW_FN };
function githubFixture() {
  type Pull = { number: number; head: string; headRepo: number; baseRepo: number; branch: string;
    baseRef: string; state: 'open' | 'closed'; merged: boolean; updated: string };
  let base = BASE;
  let baseUnavailable = false;
  let branch: string | undefined;
  let branchHead: string | undefined;
  let pull: Pull | undefined;
  let hide = false;
  let hideByNumber = false;
  let duplicate = false;
  let drop = false;
  let onCreate: (() => Promise<void> | void) | undefined;
  let onBaseRead: (() => Promise<void> | void) | undefined;
  const commits = new Map([[HEAD, { tree: TREE, parents: [BASE] }], [EDITED, { tree: EDITED_TREE, parents: [HEAD] }],
    [BASE, { tree: BASE_TREE, parents: [] }], [NEW_BASE, { tree: NEXT_BASE_TREE, parents: [BASE] }]]);
  type Entry = { path: string; type: string; mode: string; sha: string };
  const stable = { path: 'README.md', type: 'blob', mode: '100644', sha: '3'.repeat(40) };
  const upstream = { path: 'new-upstream.md', type: 'blob', mode: '100644', sha: '4'.repeat(40) };
  const trees = new Map<string, Entry[]>([[BASE_TREE, [stable]], [NEXT_BASE_TREE, [stable, upstream]]]);
  let afterRef: (() => void) | undefined;
  let planEntry: Entry | undefined;
  let replacementTree: string | undefined;
  let dropObject: 'tree' | 'commit' | undefined;
  let driftAfterRef = false;
  let branchAuthority = true;
  const outputBlobs = new Map<string, Buffer>();
  function gitObject(type: string, bytes: Buffer) {
    return execFileSync('git', ['hash-object', '-t', type, '--stdin'], { input: bytes, encoding: 'utf8' }).trim();
  }
  const calls: string[] = [];
  const render = (pr: Pull) => ({
    number: pr.number, state: pr.state, merged: pr.merged, merged_at: pr.merged ? pr.updated : null, updated_at: pr.updated,
    head: { ref: pr.branch, sha: pr.head, repo: { id: pr.headRepo } },
    base: { ref: pr.baseRef, sha: base, repo: { id: pr.baseRepo } },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.github.com');
    const path = decodeURIComponent(url.pathname).replace(/^\/repos\/approved\/plans/, '');
    expect(path.startsWith('/repos')).toBe(false);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    let callback: (() => Promise<void> | void) | undefined;
    if (!path && method === 'GET') return Response.json({ id: 123, full_name: 'approved/plans' });
    if (path === '/rulesets/1234') return Response.json({
      id: 1234, source: 'approved/plans', source_type: 'Repository', target: 'branch', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/patrick/*'], exclude: [] } },
      bypass_actors: [{ actor_id: 3456, actor_type: 'Integration', bypass_mode: 'always' },
        ...(branchAuthority ? [] : [{ actor_id: 999, actor_type: 'RepositoryRole', bypass_mode: 'always' }])],
      rules: ['creation', 'update', 'deletion'].map((type) => ({ type })),
    });
    if (path === '/git/ref/heads/main' && method === 'GET') {
      callback = onBaseRead;
      onBaseRead = undefined;
      await callback?.();
      if (driftAfterRef && branchHead) { branchHead = EDITED; driftAfterRef = false; }
      return baseUnavailable ? new Response(null, { status: 404 }) : Response.json({ ref: 'refs/heads/main', object: { sha: base, type: 'commit' } });
    }
    if (path.startsWith('/git/ref/heads/') && method === 'GET') {
      if (!branchHead || path !== '/git/ref/heads/' + branch) return new Response(null, { status: 404 });
      return Response.json({ ref: 'refs/heads/' + branch, object: { sha: branchHead, type: 'commit' } });
    }
    if (path.startsWith('/git/commits/') && method === 'GET') {
      const sha = path.split('/').at(-1) ?? '';
      const commit = commits.get(sha);
      return commit ? Response.json({ sha, tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) }) : new Response(null, { status: 404 });
    }
    if (path.startsWith('/git/trees/') && method === 'GET') {
      const sha = path.split('/').at(-1) ?? '';
      const tree = trees.get(sha);
      return tree ? Response.json({ sha, tree, truncated: false }) : new Response(null, { status: 404 });
    }
    if (path === '/git/refs' && method === 'POST') {
      calls.push('createRef');
      expect(branchHead).toBeUndefined();
      branch = String(body.ref).replace('refs/heads/', '');
      branchHead = String(body.sha);
      afterRef?.();
      return Response.json({ ref: body.ref, object: { sha: body.sha, type: 'commit' } }, { status: 201 });
    }
    if (path.startsWith('/git/blobs/') && method === 'GET') {
      const sha = path.split('/').at(-1)!;
      const bytes = outputBlobs.get(sha);
      return bytes ? Response.json({ sha, size: bytes.length, content: bytes.toString('base64'), encoding: 'base64' }) : new Response(null, { status: 404 });
    }
    if (path === '/git/blobs' && method === 'POST') {
      calls.push('createBlob');
      expect(body.encoding).toBe('base64');
      const bytes = Buffer.from(String(body.content), 'base64');
      const sha = gitObject('blob', bytes);
      outputBlobs.set(sha, bytes);
      return Response.json({ sha }, { status: 201 });
    }
    if (path === '/git/trees' && method === 'POST') {
      calls.push('createTree');
      const baseTree = trees.get(String(body.base_tree));
      if (base === NEW_BASE) expect(baseTree).toContainEqual(upstream);
      expect(body.tree).toEqual([planEntry]);
      if (!baseTree || !planEntry) throw new Error('missing tree');
      const nextTree = [...baseTree.filter((entry) => entry.path !== planEntry!.path), planEntry];
      const sha = gitObject('tree', Buffer.concat(nextTree.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
        .flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.path}\0`), Buffer.from(entry.sha, 'hex')])));
      replacementTree = sha;
      trees.set(sha, nextTree);
      if (dropObject === 'tree') { dropObject = undefined; throw new TypeError('lost replacement tree reply'); }
      return Response.json({ sha, tree: nextTree, truncated: false }, { status: 201 });
    }
    if (path === '/git/commits' && method === 'POST') {
      calls.push('createCommit');
      expect(body.parents).toEqual(branchHead ? [branchHead, base] : [base]);
      expect(body.tree).toBe(replacementTree);
      const author = body.author as { name: string; email: string; date: string };
      const identity = `${author.name} <${author.email}> ${Date.parse(author.date) / 1000} +0000`;
      const sha = gitObject('commit', Buffer.from(`tree ${body.tree}
${(body.parents as string[]).map((p) => `parent ${p}
`).join('')}author ${identity}
committer ${identity}

${body.message}
`));
      commits.set(sha, { tree: String(body.tree), parents: body.parents as string[] });
      if (dropObject === 'commit') { dropObject = undefined; throw new TypeError('lost replacement commit reply'); }
      return Response.json({ sha, tree: { sha: body.tree } }, { status: 201 });
    }
    if (path === '/git/refs/heads/' + branch && method === 'PATCH') {
      calls.push('updateRef');
      expect(body.force).toBe(false);
      branchHead = String(body.sha);
      if (pull) pull.head = branchHead;
      return Response.json({ ref: 'refs/heads/' + branch, object: { sha: body.sha, type: 'commit' } });
    }
    if (path === '/pulls' && method === 'POST') {
      calls.push('createPullRequest');
      expect(pull).toBeUndefined();
      expect(body.head).toBe(branch);
      expect(body.base).toBe(TARGET.baseRef);
      if (!branch || !branchHead) throw new Error('missing fixed branch');
      pull = { number: 17, head: branchHead, headRepo: 123, baseRepo: 123, branch, baseRef: 'main', state: 'open', merged: false, updated: NOW };
      await onCreate?.();
      if (drop) { drop = false; throw new TypeError('connection lost'); }
      return Response.json(render(pull), { status: 201 });
    }
    if (path === '/pulls' && method === 'GET') {
      calls.push('listPullRequests');
      expect(url.searchParams.get('state')).toBe('all');
      expect(url.searchParams.get('head')).toMatch(/^approved:patrick\//);
      expect(url.searchParams.get('base')).toBe('main');
      if (hide) { hide = false; return Response.json([]); }
      if (!pull) return Response.json([]);
      if (url.searchParams.get('page') === '2') return Response.json([render({ ...pull, number: 18 })]);
      const next = new URL(url);
      next.searchParams.set('page', '2');
      return Response.json([render(pull)], duplicate ? { headers: { link: '<' + next.href + '>; rel="next"' } } : {});
    }
    if (path === '/pulls/' + pull?.number && method === 'GET' && pull) {
      calls.push('getPullRequest');
      if (hideByNumber) { hideByNumber = false; return new Response(null, { status: 404 }); }
      return Response.json(render(pull));
    }
    throw new Error('unexpected GitHub protocol request: ' + method + ' ' + url);
  };
  return {
    fetch,
    seedPlan(path: string, sha: string) {
      const entry = { path, type: 'blob', mode: '100644', sha };
      planEntry = entry;
      trees.set(TREE, [stable, entry]);
      trees.set(EDITED_TREE, [stable, { ...entry, sha: '5'.repeat(40) }]);
    },
    loseReplacement(kind: 'tree' | 'commit') { dropObject = kind; },
    driftAtFinalPreflight() { driftAfterRef = true; },
    disableBranchAuthority() { branchAuthority = false; },
    afterRef(callback: () => void) { afterRef = callback; },
    conflictBasePath() { if (planEntry) trees.set(NEXT_BASE_TREE, [stable, upstream, { ...planEntry, sha: '6'.repeat(40) }]); },
    addUnrelatedHeadChange() { trees.get(EDITED_TREE)?.push({ ...upstream, path: 'unrelated.md' }); },
    hasUpstreamChange(tree: string) { return trees.get(tree)?.some((entry) => entry.path === upstream.path && entry.sha === upstream.sha); },
    calls: (name: string) => calls.filter((call) => call === name).length,
    writes: () => calls.filter((call) => ['createBlob', 'createRef', 'createTree', 'createCommit', 'updateRef', 'createPullRequest'].includes(call)),
    dropNextPrResponseAfterCommit() { drop = true; },
    hideCreatedPrFromNextList() { hide = true; },
    hideCreatedPrFromNextGet() { hideByNumber = true; },
    preexisting(fixedBranch: string) {
      branch = fixedBranch;
      branchHead = HEAD;
      pull = { number: 17, head: HEAD, headRepo: 123, baseRepo: 123, branch, baseRef: 'main', state: 'open', merged: false, updated: NOW };
    },
    advanceBase() { base = NEW_BASE; },
    removeBase() { baseUnavailable = true; },
    createRace(callback: () => Promise<void> | void) { onCreate = callback; },
    beforeNextBaseRead(callback: () => Promise<void> | void) { onBaseRead = callback; },
    showDuplicatePage() { duplicate = true; },
    editPr() { if (pull) { pull.head = EDITED; pull.updated = UPDATE; branchHead = EDITED; } },
    changeIdentity() { if (pull) pull.headRepo = 999; },
    merge() { if (pull) { pull.state = 'closed'; pull.merged = true; pull.updated = UPDATE; } },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function scene(phase: 'delivery' | 'judgment' = 'delivery', resource = RESOURCE) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t12-'));
  const location = join(dir, 'state.sqlite');
  let db = openDatabase(location);
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO accounts VALUES ('owner', 1, 1, ?)").run(NOW);
  db.prepare("INSERT INTO caller_scopes VALUES (?, ?, ?, 'publish_pr', NULL)").run(principal.account_id, principal.caller_id, DOMAIN);
  const github = githubFixture();
  const sourcePath = join(dir, 'source');
  mkdirSync(sourcePath);
  const demand = join(sourcePath, 'demand.md');
  writeFileSync(demand, 'Demand A');
  const blobs = createBlobStore(join(dir, 'blobs'));
  const registry = createSourceRegistry(db, { blobs, now: () => NOW });
  const source = await registry.enableSource({ accountId: principal.account_id, dataDomain: DOMAIN }, {
    type: 'directory', target: sourcePath, hasTriggerRule: true, excludes: [], frequency: 'poll', history: 'none',
  });
  async function collect() { await registry.collectSource(source.sourceId, source.configRevision); }
  await collect();
  const { event_id: workId } = db.prepare("SELECT event_id FROM outbox WHERE destination = 'source-work'").get() as { event_id: string };
  const delegation = () => createDelegationApi(db, principal, options);
  const standards = () => createStandardsApi(db, principal, options);
  const seeded = await standards().seedProductDataset();
  let caseId: string;
  const otherCase = seeded.training_ids[1]!;
  const scope = {
    actions: ['judge', 'collect', 'publish_pr'], resources: ['work', resource],
    effects: ['publish_pr'], domains: [DOMAIN], risk: 'low', level: 'L1' as const, budget_micros: 5000,
  };
  await delegation().registerMandateType({ type_id: 'type', ...scope, config_version: 1 });
  await delegation().openMandate({ mandate_id: 'mandate', type_id: 'type', ...scope, expires_at: '2026-11-18T00:00:00Z' });
  await delegation().setCapability({ profile_id: 'profile', level: 'L2', actions: scope.actions,
    report_id: 'report', report_version: 1, config_version: 1 });
  await delegation().openWork({ work_id: workId, generation: GENERATION, mandate_id: 'mandate',
    phase, next_action: phase === 'delivery' ? 'publish_pr' : 'judge', budget_micros: 5000 });
  if (phase === 'delivery') await delegation().setWorkGate(workId, GENERATION, { evidence_ready: true });
  async function grant(prepareExisting = true) {
    const granted = await delegation().authorizeAction({
      work_id: workId, generation: GENERATION, attempt_id: phase, phase,
      next_action: phase === 'delivery' ? 'publish_pr' : 'judge', allowed_effects: phase === 'delivery' ? ['publish_pr'] : [],
      expires_at: '2026-11-17T00:00:00Z',
    });
    if (phase === 'delivery' && resource === RESOURCE && prepareExisting) await prepare(granted);
    return granted;
  }
  const remote = createGitHubClient({ fetch: github.fetch, branchAuthority: AUTHORITY, writeAuthorization: () => 'fixture-write-credential', assertWriteAllowed() {} });
  const artifactsRoot = join(dir, 'jobs');
  const receiptsRoot = join(dir, 'receipts');
  const repository = () => createEffectRepository(db, principal, { ...options, target: TARGET,
    verifyBuild: createPrBuildVerifier(remote, { artifactsRoot, receiptsRoot, blobs }),
  });
  async function prepare(grant: RunGrant, recordExisting = true) {
    const { receipt } = await runLocalPlan(grant);
    expect(receipt.classification).toBe('agent_completed');
    if (recordExisting) caseId = await repository().prepareBuild({ workId, generation: GENERATION, grant, artifact });
  }
  async function runLocalPlan(grant: RunGrant, source?: string, configHash = 'fixture-config', backend: 'codex' | 'grok' = 'codex') {
    if (grant.subject_kind !== 'work') throw new Error('expected work grant');
    const context = { workId, generation: GENERATION, attemptId: grant.attempt_id };
    const job = buildWorkspace(artifactsRoot, context);
    const sourceRevision = workId.slice('work:'.length);
    const { content_hash: sourceHash } = db.prepare('SELECT content_hash FROM source_revisions WHERE revision_id = ?')
      .get(sourceRevision) as { content_hash: string };
    const sourceBytes = source === undefined ? await blobs.readBlob(sourceHash) : Buffer.from(source);
    const contents = `# Candidate plan

Source revision: ${sourceRevision}

Proposed steps.
`;
    github.seedPlan(planPath(context), gitBlobSha(Buffer.from(contents)));
    mkdirSync(job, { recursive: true });
    const binaries = join(dir, 'binaries');
    mkdirSync(binaries, { recursive: true });
    const eventLines = [
      { type: 'thread.started', thread_id: 'local-wrapper-fixture' },
      { type: 'item.completed', item: { type: 'agent_message', text: contents } },
      { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 3, cached_input_tokens: 0 } },
    ].map((event) => JSON.stringify(event)).join('\n');
    const admittedText = 'Demand A';
    const starts = join(job, 'backend-starts');
    const received = join(job, 'backend-input');
    writeFileSync(join(binaries, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(starts)}, 'start\\n');
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(received)}, input);
if (!input.includes(${JSON.stringify(admittedText)}) || !input.includes(${JSON.stringify('Source revision: ' + sourceRevision)})) process.exit(3);
process.stdout.write(${JSON.stringify(eventLines)});
`, { mode: 0o755 });
    if (backend === 'grok') writeFileSync(join(binaries, 'grok'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(starts)}, 'start\\n');
const prompt = process.argv[process.argv.indexOf('--prompt-file') + 1];
fs.writeFileSync(prompt, 'Replacement input');
process.stdout.write(${JSON.stringify(JSON.stringify({ result: contents, stop_reason: 'end_turn', session_id: 'grok-fixture', usage: { input_tokens: 3, output_tokens: 3 } }))});
`, { mode: 0o755 });
    vi.stubEnv('PATH', binaries);
    try {
      const receipt = await runAttempt({
        backend, subject: { kind: 'work', work_id: workId, generation: GENERATION,
          next_action: grant.next_action, resume_phase: null, judgment_basis: { hash: grant.basis_hash, evidence_watermark: 0 } },
        home: job, config_hash: configHash, cwd: job, session_id: null, bundle_present: true, controller: 'run',
        terminal: null, resume: null, ledger_dir: buildWorkspace(receiptsRoot, context), paid: null,
        deliveryPlan: { source_revision: sourceRevision, source_sha256: sourceHash, sourceBytes },
      }, grant, { db, principal, now: NOW_FN });
      return { receipt, contents, job, sourceRevision, sourceHash, starts, received };
    } finally { vi.unstubAllEnvs(); }
  }
  const publisher = () => createPrPublisher(repository(), remote);
  const observer = () => createOutcomeObserver(repository(), remote);
  const freeze = (authorization: RunGrant, headSha = HEAD, originalCase = caseId) => repository().freezePr({
    workId: workId, generation: GENERATION, caseId: originalCase, grant: authorization,
    artifact: { ...artifact, headSha },
  });
  return {
    delegation, standards, github, publisher, observer, freeze, grant, prepare, runLocalPlan, repository, otherCase, workId,
    get caseId() { return caseId; },
    artifactsRoot, receiptsRoot, blobs,
    async changeSource() { writeFileSync(demand, 'Demand B'); await collect(); },
    db: () => db,
    restart() { db.close(); db = openDatabase(location); },
    deliveredCount: () => (db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE aggregate_id = ? AND json_extract(payload, '$.type') = 'work.delivered'").get(workId) as { n: number }).n,
  };
}

test('lost create response remains uncertain on an empty restart read; a late result delivers once', async () => {
  const fx = await scene();
  const grant = await fx.grant();
  const { intentId } = fx.freeze(grant);
  expect(fx.freeze(grant).intentId).toBe(intentId);
  expect(() => fx.freeze(grant, EDITED)).toThrow(/CONFLICT/);
  fx.github.dropNextPrResponseAfterCommit();
  expect((await fx.publisher().publishPr(intentId)).status).toBe('uncertain');
  fx.restart();
  expect(fx.db().prepare("SELECT event_id FROM domain_events WHERE json_extract(payload, '$.type') = 'effect.uncertain'").all()).toHaveLength(1);
  fx.github.hideCreatedPrFromNextList();
  expect((await fx.publisher().reconcilePr(intentId)).status).toBe('uncertain');
  expect(fx.github.calls('createPullRequest')).toBe(1);
  expect(fx.deliveredCount()).toBe(0);
  expect(fx.db().prepare("SELECT event_id FROM domain_events WHERE json_extract(payload, '$.type') = 'effect.uncertain'").all()).toHaveLength(1);
  const receipt = await fx.publisher().reconcilePr(intentId);
  expect(receipt).toMatchObject({ status: 'verified', proof: { number: 17, verifiedBaseSha: BASE, headSha: HEAD, treeSha: TREE } });
  fx.github.advanceBase();
  expect(await fx.publisher().reconcilePr(intentId)).toEqual(receipt);
  expect(fx.github.writes()).toEqual(['createRef', 'createPullRequest']);
  expect(fx.deliveredCount()).toBe(1);
});

test('a listed PR that is briefly missing by number does not cause a second create', async () => {
  const fx = await scene();
  const { intentId, effectKey } = fx.freeze(await fx.grant());
  fx.github.preexisting('patrick/' + effectKey);
  fx.github.hideCreatedPrFromNextGet();
  expect((await fx.publisher().publishPr(intentId)).status).toBe('uncertain');
  expect(fx.github.writes()).toEqual([]);
  expect((await fx.publisher().reconcilePr(intentId)).status).toBe('verified');
  expect(fx.github.writes()).toEqual([]);
});

test('a PR with no dispatch record cannot deliver after its grant was revoked', async () => {
  const fx = await scene();
  const grant = await fx.grant();
  const { intentId, effectKey } = fx.freeze(grant);
  fx.github.preexisting('patrick/' + effectKey);
  await fx.delegation().revokeGrant(grant.grant_id);
  expect((await fx.publisher().publishPr(intentId)).status).toBe('blocked');
  expect(fx.github.writes()).toEqual([]);
  expect(fx.deliveredCount()).toBe(0);
});

test('drift during POST pauses delivery then atomically freezes the new base for the existing PR', async () => {
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  fx.github.createRace(async () => {
    fx.github.advanceBase();
    expect((await fx.publisher().reconcilePr(intentId)).status).toBe('uncertain');
    expect(fx.deliveredCount()).toBe(0);
  });
  expect((await fx.publisher().publishPr(intentId)).status).toBe('uncertain');
  expect(fx.deliveredCount()).toBe(0);
  fx.restart();
  expect(await fx.publisher().reconcilePr(intentId)).toMatchObject({ status: 'verified', proof: { number: 17, verifiedBaseSha: NEW_BASE, headSha: HEAD } });
  expect(fx.github.calls('listPullRequests')).toBe(1); // preflight only; the persisted number is used after POST
  expect(fx.github.writes()).toEqual(['createRef', 'createPullRequest']);
  expect(fx.deliveredCount()).toBe(1);
});

test('changed head before first verification reapplies only the approved patch on the same PR branch', async () => {
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  fx.github.createRace(() => { fx.github.advanceBase(); fx.github.editPr(); });
  expect((await fx.publisher().publishPr(intentId)).status).toBe('uncertain');
  expect(fx.deliveredCount()).toBe(0);
  fx.restart();
  const receipt = await fx.publisher().reconcilePr(intentId);
  expect(receipt).toMatchObject({ status: 'verified', proof: { number: 17, verifiedBaseSha: NEW_BASE } });
  expect(receipt.proof?.headSha).not.toBe(EDITED);
  expect(receipt.proof?.headSha).not.toBe(HEAD);
  expect(receipt.proof?.treeSha).not.toBe(TREE);
  expect(fx.github.hasUpstreamChange(receipt.proof!.treeSha)).toBe(true);
  expect(fx.github.writes()).toEqual(['createRef', 'createPullRequest', 'createTree', 'createCommit', 'updateRef']);
  expect(fx.deliveredCount()).toBe(1);
});

test('the approved patch is replaced and audited if the base advances between ref and PR creation', async () => {
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  fx.github.afterRef(() => { fx.github.advanceBase(); });
  const receipt = await fx.publisher().publishPr(intentId);
  expect(receipt).toMatchObject({ status: 'verified', proof: { number: 17, verifiedBaseSha: NEW_BASE } });
  expect(fx.github.hasUpstreamChange(receipt.proof!.treeSha)).toBe(true);
  expect(fx.github.writes()).toEqual(['createRef', 'createTree', 'createCommit', 'updateRef', 'createPullRequest']);
  expect(fx.db().prepare("SELECT phase FROM effect_dispatches WHERE intent_id = ? ORDER BY dispatch_seq").all(intentId))
    .toEqual(fx.github.writes().map((_, i) => ({ phase: ['create_ref', 'rebuild_tree', 'rebuild_commit', 'update_ref', 'create_pr'][i] })));
  expect(fx.db().prepare('SELECT parent_head_sha, observed_base_sha, replacement_head_sha FROM effect_pr_rebuilds WHERE intent_id = ?').get(intentId))
    .toEqual({ parent_head_sha: HEAD, observed_base_sha: NEW_BASE, replacement_head_sha: receipt.proof!.headSha });
});

test('a conflicting base or unrelated head edit leaves an uncertain PR without rebuilding or recreating it', async () => {
  for (const scenario of ['patch-conflict', 'unrelated-head']) {
    const fx = await scene();
    const { intentId } = fx.freeze(await fx.grant());
    fx.github.createRace(() => {
      fx.github.advanceBase();
      fx.github.editPr();
      if (scenario === 'patch-conflict') fx.github.conflictBasePath();
      else fx.github.addUnrelatedHeadChange();
    });
    expect((await fx.publisher().publishPr(intentId)).status).toBe('uncertain');
    expect((await fx.publisher().reconcilePr(intentId)).status).toBe('conflict');
    expect(fx.github.writes()).toEqual(['createRef', 'createPullRequest']);
    expect(fx.deliveredCount()).toBe(0);
  }
});

test.each(['tree', 'commit'] as const)('restart verifies the exact replacement %s after its successful POST reply is lost', async (kind) => {
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  fx.github.createRace(() => { fx.github.advanceBase(); fx.github.editPr(); });
  expect((await fx.publisher().publishPr(intentId)).status).toBe('uncertain');
  fx.github.loseReplacement(kind);
  expect((await fx.publisher().reconcilePr(intentId)).status).toBe('uncertain');
  const plan = fx.db().prepare('SELECT replacement_tree_sha, replacement_head_sha FROM effect_pr_rebuilds').get();
  expect(plan).toMatchObject({ replacement_tree_sha: expect.stringMatching(/^[a-f0-9]{40}$/),
    replacement_head_sha: expect.stringMatching(/^[a-f0-9]{40}$/) });
  fx.restart();
  expect((await fx.publisher().reconcilePr(intentId)).status).toBe('verified');
  expect(fx.github.writes()).toEqual(['createRef', 'createPullRequest', 'createTree', 'createCommit', 'updateRef']);
  expect(fx.deliveredCount()).toBe(1);
});

test('a head move during the final base read never posts a PR for the wrong head', async () => {
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  fx.github.afterRef(() => fx.github.driftAtFinalPreflight());
  expect((await fx.publisher().publishPr(intentId)).status).toBe('conflict');
  expect(fx.github.writes()).toEqual(['createRef']);
  expect(fx.db().prepare("SELECT 1 FROM effect_dispatches WHERE phase = 'create_pr'").get()).toBeUndefined();
});

test('the durable create permit binds both final branch tips', async () => {
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  fx.github.afterRef(() => fx.github.advanceBase());
  const receipt = await fx.publisher().publishPr(intentId);
  expect(receipt.status).toBe('verified');
  expect(fx.db().prepare("SELECT * FROM effect_dispatches WHERE phase = 'create_pr'").get()).toMatchObject({
    expected_remote_version: NEW_BASE, expected_head_sha: receipt.proof!.headSha,
  });
});

test('live sends require the exact single-writer branch authority without another bypass actor', async () => {
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  fx.github.disableBranchAuthority();
  expect((await fx.publisher().publishPr(intentId)).status).toBe('blocked');
  expect(fx.github.writes()).toEqual([]);
  expect(fx.db().prepare('SELECT * FROM effect_dispatches').all()).toEqual([]);
});

test('wrapper seals a real local process plan and a subsequent file edit cannot be published', async () => {
  const fx = await scene();
  const grant = await fx.grant(false);
  const { receipt, contents, job, sourceRevision, sourceHash, received } = await fx.runLocalPlan(grant);
  expect(receipt.classification).toBe('agent_completed');
  expect(readFileSync(join(job, 'plan.md'), 'utf8')).toBe(contents);
  const input = readFileSync(received, 'utf8');
  expect(JSON.parse(input.split('Admitted source (JSON):\n')[1]!)).toEqual({ content: 'Demand A' });
  expect(JSON.parse(readFileSync(receipt.persisted_path, 'utf8'))).toMatchObject({ delivery_artifact: {
    source_revision: sourceRevision, source_sha256: sourceHash, sha256: createHash('sha256').update(contents).digest('hex'),
    bytes: Buffer.byteLength(contents), request_sha256: createHash('sha256').update(input).digest('hex'), dag_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  } });
  writeFileSync(join(job, 'plan.md'), contents + '\nEdited after the wrapper receipt.\n');
  await expect(fx.repository().prepareBuild({ workId: fx.workId, generation: GENERATION, grant, artifact }))
    .rejects.toThrow(/BUILD_RECEIPT_MISMATCH/);
  expect(fx.github.writes()).toEqual([]);
});

test('a completed delivery attempt replays its sealed receipt without another backend start or overwrite', async () => {
  const fx = await scene();
  const grant = await fx.grant(false);
  const first = await fx.runLocalPlan(grant);
  expect(first.receipt.classification).toBe('agent_completed');
  const sealed = readFileSync(first.receipt.persisted_path, 'utf8');
  const exact = await fx.runLocalPlan(grant);
  expect(exact.receipt).toEqual(first.receipt);
  const different = await fx.runLocalPlan(grant, 'Demand A', 'different-config');
  expect(different.receipt.classification).toBe('technical_failure');
  if (grant.subject_kind !== 'work') throw new Error('expected work grant');
  const differentAction = await fx.runLocalPlan({ ...grant, next_action: 'judge', phase: 'judgment' });
  expect(differentAction.receipt.classification).toBe('technical_failure');
  expect(readFileSync(first.receipt.persisted_path, 'utf8')).toBe(sealed);
  expect(readFileSync(first.starts, 'utf8').trim().split('\n')).toEqual(['start']);
});

test('restart accepts durable ledger proofs with their leftover scratch links but rejects a linked plan', async () => {
  const fx = await scene();
  const grant = await fx.grant(false);
  const run = await fx.runLocalPlan(grant);
  expect(run.receipt.classification).toBe('agent_completed');
  const terminal = run.receipt.persisted_path;
  const claim = join(dirname(dirname(terminal)), 'execution_claim', grant.attempt_id + '.json');
  for (const path of [terminal, claim]) {
    linkSync(path, join(dirname(path), '.' + grant.attempt_id + '.01b2c3d4-5678-4abc-9def-012345678abc.tmp'));
    expect(statSync(path).nlink).toBe(2);
  }
  fx.restart();
  expect((await fx.runLocalPlan(grant)).receipt).toEqual(run.receipt);
  expect(readFileSync(run.starts, 'utf8').trim().split('\n')).toEqual(['start']);
  const planAlias = join(run.job, 'plan-alias.md');
  linkSync(join(run.job, 'plan.md'), planAlias);
  const build = { workId: fx.workId, generation: GENERATION, grant, artifact };
  await expect(fx.repository().prepareBuild(build)).rejects.toThrow(/BUILD_FILE_INVALID/);
  rmSync(planAlias);
  await expect(fx.repository().prepareBuild(build)).resolves.toMatch(/^work-case:/);
  expect((await fx.publisher().publishPr(fx.freeze(grant).intentId)).status).toBe('verified');
  expect(fx.github.calls('createPullRequest')).toBe(1);
});

test('Grok delivery cannot start with a prompt file the executor can change', async () => {
  const fx = await scene();
  const grant = await fx.grant(false);
  const result = await fx.runLocalPlan(grant, undefined, undefined, 'grok');
  expect(result.receipt.classification).toBe('technical_failure');
  expect(existsSync(result.starts)).toBe(false);
  expect(existsSync(join(result.job, 'publish-prompt.txt'))).toBe(false);
});

test('an interrupted durable delivery claim cannot start the backend again or recreate its terminal', async () => {
  const fx = await scene();
  const grant = await fx.grant(false);
  const first = await fx.runLocalPlan(grant);
  expect(first.receipt.classification).toBe('agent_completed');
  // Simulate the durable state left by a process that died after claiming and before the terminal write.
  rmSync(first.receipt.persisted_path);
  rmSync(join(first.job, 'plan.md'));
  const second = await fx.runLocalPlan(grant);
  expect(second.receipt.classification).toBe('technical_failure');
  expect(existsSync(first.receipt.persisted_path)).toBe(false);
  expect(readFileSync(first.starts, 'utf8').trim().split('\n')).toEqual(['start']);
});

test('mismatched source bytes stop before process launch and cannot produce a publishable receipt', async () => {
  const fx = await scene();
  const grant = await fx.grant(false);
  const result = await fx.runLocalPlan(grant, 'Different source bytes');
  expect(result.receipt.classification).toBe('technical_failure');
  expect(existsSync(result.starts)).toBe(false);
  await expect(fx.repository().prepareBuild({ workId: fx.workId, generation: GENERATION, grant, artifact })).rejects.toThrow();
  expect(fx.github.writes()).toEqual([]);
});

test('multiple paginated matches and mismatched remote identity cannot deliver', async () => {
  for (const conflict of ['duplicate', 'identity']) {
    const fx = await scene();
    const { intentId } = fx.freeze(await fx.grant());
    fx.github.dropNextPrResponseAfterCommit();
    expect((await fx.publisher().publishPr(intentId)).status).toBe('uncertain');
    if (conflict === 'duplicate') fx.github.showDuplicatePage();
    else fx.github.changeIdentity();
    expect((await fx.publisher().reconcilePr(intentId)).status).toBe('conflict');
    expect(fx.github.calls('createPullRequest')).toBe(1);
    expect(fx.deliveredCount()).toBe(0);
  }
});

test('revocation before send permission blocks every write; revocation after PR dispatch still allows readback', async () => {
  const early = await scene();
  const earlyGrant = await early.grant();
  const { intentId } = early.freeze(earlyGrant);
  early.github.beforeNextBaseRead(() => early.delegation().revokeGrant(earlyGrant.grant_id));
  expect((await early.publisher().publishPr(intentId)).status).toBe('blocked');
  expect(early.github.writes()).toEqual([]);
  expect(early.deliveredCount()).toBe(0);

  const late = await scene();
  const lateGrant = await late.grant();
  const { intentId: lateIntent } = late.freeze(lateGrant);
  late.github.dropNextPrResponseAfterCommit();
  late.github.createRace(() => late.delegation().revokeGrant(lateGrant.grant_id));
  expect((await late.publisher().publishPr(lateIntent)).status).toBe('uncertain');
  late.restart();
  expect((await late.publisher().reconcilePr(lateIntent)).status).toBe('verified');
  expect(late.github.writes()).toEqual(['createRef', 'createPullRequest']);
  expect(late.deliveredCount()).toBe(1);
});

test('the original case and exact build come from work provenance, never the first freeze request', async () => {
  const fx = await scene();
  const grant = await fx.grant();
  expect(() => fx.freeze(grant, HEAD, fx.otherCase)).toThrow(/CONFLICT/);
  expect(() => fx.freeze(grant, EDITED)).toThrow(/CONFLICT/);
  expect(fx.db().prepare('SELECT * FROM effect_intents').all()).toEqual([]);
  expect(fx.github.writes()).toEqual([]);
  expect((await fx.publisher().publishPr(fx.freeze(grant).intentId)).status).toBe('verified');
});

test('a source revision changed after freeze cannot claim a send permit', async () => {
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  await fx.changeSource();
  expect((await fx.publisher().publishPr(intentId)).status).toBe('blocked');
  expect(fx.github.writes()).toEqual([]);
});

test('withdrawing only the caller domain permission blocks sends but allows reconciliation of a prior send', async () => {
  function withdraw(fx: Awaited<ReturnType<typeof scene>>) {
    const before = fx.db().prepare('SELECT * FROM execution_grants').all();
    fx.db().prepare("UPDATE caller_scopes SET revoked_at = ? WHERE account_id = ? AND caller_id = ? AND data_domain = ? AND permission = 'publish_pr'")
      .run(NOW, principal.account_id, principal.caller_id, DOMAIN);
    expect(fx.db().prepare('SELECT * FROM execution_grants').all()).toEqual(before);
    expect(fx.db().prepare("SELECT auth_epoch FROM accounts WHERE account_id = 'owner'").get()).toEqual({ auth_epoch: 1 });
  }
  const early = await scene();
  const { intentId } = early.freeze(await early.grant());
  // A permission from a different data domain cannot authorize this effect.
  early.db().prepare("INSERT INTO caller_scopes VALUES (?, ?, 'personal', 'publish_pr', NULL)").run(principal.account_id, principal.caller_id);
  early.github.beforeNextBaseRead(() => { withdraw(early); });
  expect((await early.publisher().publishPr(intentId)).status).toBe('blocked');
  expect(early.github.writes()).toEqual([]);

  const late = await scene();
  const lateIntent = late.freeze(await late.grant()).intentId;
  late.github.dropNextPrResponseAfterCommit();
  late.github.createRace(() => { withdraw(late); });
  expect((await late.publisher().publishPr(lateIntent)).status).toBe('uncertain');
  expect((await late.publisher().reconcilePr(lateIntent)).status).toBe('verified');
  expect(late.github.writes()).toEqual(['createRef', 'createPullRequest']);
});

test('T08 rejects consultation and unapproved repo grants even if a work ID is present', async () => {
  const fx = await scene();
  await fx.delegation().openConsultation({
    request_id: 'consult', caller_id: principal.caller_id, parent_work_id: fx.workId, result_version: 1,
    domains: [DOMAIN], tools: ['catalog.search'], deadline_at: '2026-11-17T00:00:00Z',
    budget_micros: 100, permission_revision: 1,
  });
  const consultation = await fx.delegation().authorizeConsultation('consult', 'attempt-consult');
  expect(() => fx.freeze(consultation)).toThrow(/DENIED/);
  expect(fx.github.writes()).toEqual([]);

  const wrong = await scene('delivery', 'github:999');
  const wrongGrant = await wrong.grant();
  expect(() => wrong.freeze(wrongGrant)).toThrow(/DENIED/);
  expect(wrong.github.writes()).toEqual([]);

});

test('T10 waits for verified evidence, then dispatches with its real continuation grant', async () => {
  const fx = await scene('judgment');
  const judgeGrant = await fx.grant();
  if (judgeGrant.subject_kind !== 'work') throw new Error('judgment grant absent');
  const db = fx.db();
  const { workId } = fx;
  const key: ResumeKey = { work_id: workId, generation: GENERATION, question_id: 'question-1', answer_event_id: 'answer-1', phase: 'answer' };
  db.prepare("INSERT INTO work_stages VALUES (?, ?, 'waiting_evidence', ?)").run(workId, GENERATION, NOW);
  expect(() => fx.freeze({ ...judgeGrant, phase: 'delivery', next_action: 'publish_pr', allowed_effects: ['publish_pr'] })).toThrow(/DENIED/);
  expect(claimContinuation(db, principal, DOMAIN, { ...key, phase: 'evidence_ready' }, 'delivery', NOW_FN())).toEqual({ status: 'waiting' });
  expect(fx.github.writes()).toEqual([]);

  insertCollectionBinding(db, judgeGrant.basis_hash, key);
  db.prepare(INSERT_RESUME_SQL).run({ ...key, next_action: 'collect:collection-1', evidence_ref: null });
  // An answer was verified and the completed judgment attempt was stopped.
  await fx.delegation().revokeGrant(judgeGrant.grant_id);
  closeAttempt(db, workId);
  const collecting = claimContinuation(db, principal, DOMAIN, key, 'collection', NOW_FN());
  expect(collecting.status).toBe('claimed');
  if (collecting.status !== 'claimed') throw new Error('T10 collection grant absent');
  expect(() => fx.freeze(collecting.grant)).toThrow(/DENIED/);
  recordCollectionRound(db, principal, { question_id: key.question_id, material: 'material', evidence_ref: 'material' }, NOW_FN());
  confirmCollectedEvidence(db, principal, DOMAIN, key, 'material', NOW_FN());
  closeAttempt(db, workId);
  const delivery = claimContinuation(db, principal, DOMAIN, { ...key, phase: 'evidence_ready' }, 'delivery', NOW_FN());
  if (delivery.status !== 'claimed') throw new Error('T10 delivery grant absent');
  await fx.prepare(delivery.grant);
  const { intentId } = fx.freeze(delivery.grant);
  expect((await fx.publisher().publishPr(intentId)).status).toBe('verified');
  expect(fx.deliveredCount()).toBe(1);
});

test('outcome observations attach only to the verified original case; later edits preserve proof', async () => {
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  const receipt = await fx.publisher().publishPr(intentId);
  expect(receipt.status).toBe('verified');
  const ref = 'github:123/pull/17';
  await expect(fx.observer().observeOutcome(fx.otherCase, ref)).rejects.toThrow(/NOT_FOUND/);
  fx.github.editPr();
  expect(await fx.publisher().reconcilePr(intentId)).toEqual(receipt);
  const first = await fx.observer().observeOutcome(fx.caseId, ref);
  expect(first).toMatchObject({ result: 'rework', source: ref, observed_at: UPDATE });
  expect(await fx.observer().observeOutcome(fx.caseId, ref)).toEqual(first);
  expect(fx.db().prepare('SELECT case_id, result FROM case_outcomes').all()).toEqual([{ case_id: fx.caseId, result: 'rework' }]);
  fx.github.changeIdentity();
  expect(await fx.publisher().reconcilePr(intentId)).toEqual(receipt);
  expect((await fx.observer().observeOutcome(fx.caseId, ref)).result).toBe('unknown');
  expect(fx.db().prepare('SELECT DISTINCT kind FROM effect_observations ORDER BY kind').all()).toEqual([{ kind: 'head_changed' }, { kind: 'identity_anomaly' }]);
  expect(fx.deliveredCount()).toBe(1);
});

test('verified unchanged merge is accepted as feedback without a new work root', async () => {
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  expect((await fx.publisher().publishPr(intentId)).status).toBe('verified');
  fx.github.merge();
  fx.github.removeBase();
  const ref = 'github:123/pull/17';
  expect(await fx.observer().observeOutcome(fx.caseId, ref)).toEqual({ result: 'accepted', source: ref, observed_at: UPDATE });
  expect(fx.db().prepare('SELECT case_id, result FROM case_outcomes').all()).toEqual([{ case_id: fx.caseId, result: 'accepted' }]);
  expect(fx.deliveredCount()).toBe(1);
  expect(fx.db().prepare("SELECT event_id FROM domain_events WHERE json_extract(payload, '$.type') = 'outcome.observed'").all()).toHaveLength(1);
});

test('service polling resumes the durable queue and watches outcomes while writes are disabled', async () => {
  const loaded = await import('../../apps/service/src/pr-delivery.js').catch(() => ({}));
  expect(loaded).toHaveProperty('createPrDeliveryService');
  if (!('createPrDeliveryService' in loaded)) throw new Error('missing service composition');
  const { createPrDeliveryService } = loaded;
  const fx = await scene();
  const grant = await fx.grant();
  const { intentId } = fx.freeze(grant);
  const config = { accountId: principal.account_id, callerId: principal.caller_id, domain: DOMAIN, target: TARGET,
    artifactsRoot: fx.artifactsRoot, receiptsRoot: fx.receiptsRoot, blobs: fx.blobs, fetch: fx.github.fetch };
  const worker = () => createPrDeliveryService(fx.db(), NOW_FN, config);
  await worker().pollOnce();
  expect(fx.github.writes()).toEqual([]);
  expect(fx.deliveredCount()).toBe(0);

  fx.github.dropNextPrResponseAfterCommit();
  const writer = createPrDeliveryService(fx.db(), NOW_FN, { ...config, liveWrites: true, branchAuthority: AUTHORITY, writeAuthorization: () => 'fixture-only' });
  await writer.pollOnce();
  expect(fx.github.writes()).toEqual(['createRef', 'createPullRequest']);
  expect(fx.deliveredCount()).toBe(0);
  fx.restart();
  await worker().pollOnce();
  expect(fx.deliveredCount()).toBe(1);
  expect(fx.db().prepare('SELECT intent_id, case_id, remote_ref, observed_revision FROM outcome_watches').get()).toMatchObject({
    intent_id: intentId, case_id: fx.caseId, remote_ref: 'github:123/pull/17',
  });
  fx.github.merge();
  await worker().pollOnce();
  expect(fx.db().prepare('SELECT case_id, result FROM case_outcomes').get()).toEqual({ case_id: fx.caseId, result: 'accepted' });
  expect(fx.db().prepare('SELECT observed_revision FROM outcome_watches').get()).toEqual({ observed_revision: UPDATE });
  expect(fx.github.writes()).toEqual(['createRef', 'createPullRequest']);
});

test('the fixed service producer stages and dispatches a verified plan from isolated bytes with no prebuilt commit', async () => {
  const { createPrDeliveryService } = await import('../../apps/service/src/pr-delivery.js');
  const fx = await scene();
  const grant = await fx.grant(false);
  if (grant.subject_kind !== 'work') throw new Error('missing work grant');
  await fx.prepare(grant, false);
  const worker = createPrDeliveryService(fx.db(), NOW_FN, {
    accountId: principal.account_id, callerId: principal.caller_id, domain: DOMAIN, target: TARGET, artifactsRoot: fx.artifactsRoot, receiptsRoot: fx.receiptsRoot, blobs: fx.blobs,
    fetch: fx.github.fetch, liveWrites: true, branchAuthority: AUTHORITY, writeAuthorization: () => 'fixture-only',
  });
  const staged = await worker.stageCompletedBuild(grant, { baseSha: BASE, title: 'Verified plan', body: 'Verified work artifact' });
  expect(staged.status).toBe('pending');
  expect(fx.github.writes()).toEqual([]);
  await worker.pollOnce();
  expect(fx.deliveredCount()).toBe(1);
  expect(fx.github.writes()).toEqual(['createBlob', 'createTree', 'createCommit', 'createRef', 'createPullRequest']);
  expect(fx.db().prepare('SELECT phase FROM effect_dispatches ORDER BY dispatch_seq').all())
    .toEqual(['build_blob', 'build_tree', 'build_commit', 'create_ref', 'create_pr'].map((phase) => ({ phase })));
});

test('the production poller discovers only completed scoped delivery attempts and stages their exact bytes', async () => {
  const { createPrDeliveryService } = await import('../../apps/service/src/pr-delivery.js');
  const fx = await scene();
  const grant = await fx.grant(false);
  const worker = createPrDeliveryService(fx.db(), NOW_FN, {
    accountId: principal.account_id, callerId: principal.caller_id, domain: DOMAIN, target: TARGET,
    artifactsRoot: fx.artifactsRoot, receiptsRoot: fx.receiptsRoot, blobs: fx.blobs,
    fetch: fx.github.fetch, liveWrites: true, branchAuthority: AUTHORITY, writeAuthorization: () => 'fixture-only',
  });
  await worker.pollOnce();
  expect(fx.db().prepare('SELECT * FROM effect_intents').all()).toEqual([]);
  expect(fx.github.writes()).toEqual([]);
  await fx.prepare(grant, false);
  await worker.pollOnce();
  expect(fx.deliveredCount()).toBe(1);
  expect(fx.github.writes()).toEqual(['createBlob', 'createTree', 'createCommit', 'createRef', 'createPullRequest']);
});

test('another service caller in the same domain cannot claim or block the original caller’s queued send', async () => {
  const { createPrDeliveryService } = await import('../../apps/service/src/pr-delivery.js');
  const fx = await scene();
  const { intentId } = fx.freeze(await fx.grant());
  const config = { accountId: principal.account_id, domain: DOMAIN, target: TARGET, artifactsRoot: fx.artifactsRoot,
    receiptsRoot: fx.receiptsRoot, blobs: fx.blobs, fetch: fx.github.fetch, liveWrites: true, branchAuthority: AUTHORITY, writeAuthorization: () => 'fixture-only' };
  const another = createPrDeliveryService(fx.db(), NOW_FN, { ...config, callerId: 'different-service' });
  await another.pollOnce();
  expect(fx.db().prepare('SELECT status FROM effect_receipts WHERE intent_id = ?').get(intentId)).toEqual({ status: 'pending' });
  expect(fx.github.writes()).toEqual([]);
  await createPrDeliveryService(fx.db(), NOW_FN, { ...config, callerId: principal.caller_id }).pollOnce();
  expect(fx.deliveredCount()).toBe(1);
});

test('T12 upgrades a T11 database without changing its case rows or migration history', async () => {
  const migrationsDir = fileURLToPath(new URL('../../packages/storage/migrations/', import.meta.url));
  const manifest = JSON.parse(readFileSync(join(migrationsDir, 'manifest.json'), 'utf8')) as MigrationEntry[];
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t12-upgrade-'));
  const location = join(dir, 'state.sqlite');
  const t12Position = manifest.findIndex(({ file }) => file === '0012_effects_outcomes.sql');
  expect(t12Position).toBeGreaterThan(0);
  let db = openDatabase(location, { migrationsDir, manifest: manifest.slice(0, t12Position) });
  cleanups.push(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });
  // Seed fixture rows on the current schema, then copy them into the historical
  // database whose upgrade is under test. Current business APIs require recovery tables.
  const seedPath = join(dir, 'seed.sqlite');
  const seed = openDatabase(seedPath);
  try { await createStandardsApi(seed, principal, options).seedProductDataset(); }
  finally { seed.close(); }
  db.prepare('ATTACH DATABASE ? AS fixture_seed').run(seedPath);
  db.exec(`INSERT INTO evaluation_policies SELECT * FROM fixture_seed.evaluation_policies;
    INSERT INTO evaluation_datasets SELECT * FROM fixture_seed.evaluation_datasets;
    INSERT INTO cases SELECT * FROM fixture_seed.cases;`);
  db.exec('DETACH DATABASE fixture_seed');
  const cases = db.prepare('SELECT * FROM cases ORDER BY case_id').all();
  db.close();
  db = openDatabase(location);
  expect(db.prepare('SELECT * FROM cases ORDER BY case_id').all()).toEqual(cases);
  expect(db.prepare('SELECT file, sha256 FROM schema_migrations ORDER BY position').all()).toEqual(manifest);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

function insertCollectionBinding(db: ReturnType<typeof openDatabase>, basisHash: string, key: ResumeKey) {
  db.prepare(`INSERT INTO question_bindings (
    question_id, question_version, work_id, generation, proposal_revision, account_id, data_domain,
    hub_card_id, options_hash, options_json, custom_allowed, custom_rules_json, status, revision,
    judgment_basis_hash, withdrawal_watermark, expected_material, schema_version, created_at, updated_at
  ) VALUES (?, 1, ?, ?, 1, 'owner', ?, 17, ?, '[]', 0, '[]', 'closed', 0,
    ?, 0, 'material', '1.0', ?, ?)`).run(key.question_id, key.work_id, GENERATION, DOMAIN, 'a'.repeat(64), basisHash, NOW, NOW);
}

function closeAttempt(db: ReturnType<typeof openDatabase>, workId: string) {
  db.prepare(`UPDATE work_generations SET attempt_closed = 1, process_tree_stopped = 1, effects_reconciled = 1, control_state = 'stopped'
    WHERE work_id = ? AND generation = ?`).run(workId, GENERATION);
}
