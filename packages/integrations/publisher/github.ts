import {
  canVerifyFirstPublication, matchesPrIdentity, matchesVerifiedPr,
  type ApprovedPrTarget, type EffectReceipt, type EffectRepository, type ObservedPr, type PrIntent, type VerifiedPr, type GitTreeWrite, type GitCommitWrite, type RebuildPayload,
} from '@patrick/domain/effects';
import { createHash } from 'node:crypto';
import type { BlobStore } from '@patrick/storage';
import { authorName, authorEmail, gitBlobSha, gitCommitSha, gitTreeSha, hasExactPatch, sameTreeExcept } from './build.js';

const origin = 'https://api.github.com';
const apiVersion = '2022-11-28';
const shaPattern = /^[0-9a-f]{40}$/;
const terminal = ['blocked', 'conflict', 'verified'];

class GitHubConflict extends Error {}
class GitHubWriterDenied extends Error {}

export type BranchWriteAuthority = { repoId: string; rulesetId: number; appId: number };

type PullIdentity = {
  number: number; repoId: string; headRepoId: string; branch: string; headSha: string; baseRef: string; baseSha: string;
  state: 'open' | 'closed'; merged: boolean | null; updatedAt: string;
};
type PrSnapshot = {
  actual: ObservedPr;
  pull: PullIdentity;
};
type JsonRecord = Record<string, unknown>;
export type TreeEntry = { path: string; type: string; mode: string; sha: string };

function validTreeMode(type: unknown, mode: unknown) {
  return (type === 'blob' && (mode === '100644' || mode === '100755' || mode === '120000'))
    || (type === 'tree' && mode === '040000') || (type === 'commit' && mode === '160000');
}

export function createGitHubClient({ fetch: fetchPort = globalThis.fetch, authorization, writeAuthorization, requireWriteAuthorization = false, branchAuthority: configuredAuthority }: {
  fetch?: typeof globalThis.fetch;
  authorization?: () => string | Promise<string>;
  writeAuthorization?: () => string | Promise<string>;
  requireWriteAuthorization?: boolean;
  branchAuthority?: BranchWriteAuthority;
} = {}) {
  const authority = configuredAuthority ? { ...configuredAuthority } : null;
  function repoPath(target: ApprovedPrTarget): string {
    return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  }

  async function request(path: string, method = 'GET', body?: JsonRecord, allowMissing = false) {
    const headers = new Headers({ accept: 'application/vnd.github+json', 'x-github-api-version': apiVersion });
    const credential = method === 'GET' ? authorization : writeAuthorization ?? (requireWriteAuthorization ? undefined : authorization);
    if (method !== 'GET' && requireWriteAuthorization && !credential) throw new Error('PUBLICATION_WRITES_DISABLED');
    if (credential) {
      const secret = await credential();
      if (!secret.trim()) throw new Error('GITHUB_CREDENTIAL_REQUIRED');
      headers.set('authorization', `Bearer ${secret}`);
    }
    if (body) headers.set('content-type', 'application/json');
    const response = await fetchPort(origin + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw new Error('GITHUB_REQUEST_FAILED');
    return { json: await response.json() as unknown, link: response.headers.get('link') };
  }

  async function assertRepo(target: ApprovedPrTarget) {
    const result = await request(repoPath(target));
    const repo = record(result?.json);
    if (repoId(repo) !== target.repoId || typeof repo.full_name !== 'string'
      || repo.full_name.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase()) throw new GitHubConflict('repository_identity');
  }

  async function assertWriter(intent: PrIntent) {
    const { target, frozen } = intent;
    if (!authority || authority.repoId !== target.repoId || !/^patrick\/[a-f0-9]{64}$/.test(frozen.branch)
      || !Number.isSafeInteger(authority.rulesetId) || authority.rulesetId < 1
      || !Number.isSafeInteger(authority.appId) || authority.appId < 1) throw new GitHubWriterDenied('single_writer_not_configured');
    const result = await request(`${repoPath(target)}/rulesets/${authority.rulesetId}`, 'GET', undefined, true);
    if (!result) throw new GitHubWriterDenied('single_writer_ruleset_missing');
    const data = record(result.json);
    const refs = record(record(data.conditions).ref_name);
    const includes = refs.include;
    const excludes = refs.exclude;
    const bypass = Array.isArray(data.bypass_actors) && data.bypass_actors.length === 1 ? record(data.bypass_actors[0]) : null;
    const rules = Array.isArray(data.rules) ? new Set(data.rules.map((rule: unknown) => record(rule).type)) : new Set();
    const source = typeof data.source === 'string' ? data.source.toLowerCase() : null;
    if (data.id !== authority.rulesetId || source !== `${target.owner}/${target.repo}`.toLowerCase() || data.source_type !== 'Repository'
      || data.target !== 'branch' || data.enforcement !== 'active' || !Array.isArray(includes) || includes.length !== 1
      || !['refs/heads/patrick/*', `refs/heads/${frozen.branch}`].includes(includes[0])
      || !Array.isArray(excludes) || excludes.length !== 0 || bypass?.actor_type !== 'Integration' || bypass.actor_id !== authority.appId
      || bypass.bypass_mode !== 'always' || !['creation', 'update', 'deletion'].every((type) => rules.has(type))) {
      throw new GitHubWriterDenied('single_writer_ruleset_mismatch');
    }
  }

  async function readRef(target: ApprovedPrTarget, ref: string) {
    const result = await request(`${repoPath(target)}/git/ref/heads/${refPath(ref)}`, 'GET', undefined, true);
    if (!result) return null;
    const data = record(result.json);
    const object = record(data.object);
    if (data.ref !== `refs/heads/${ref}` || object.type !== 'commit') throw new GitHubConflict('reference_identity');
    return sha(object.sha);
  }

  async function readCommit(target: ApprovedPrTarget, commitSha: string) {
    const expected = sha(commitSha);
    const result = await request(`${repoPath(target)}/git/commits/${expected}`, 'GET', undefined, true);
    if (!result) return null;
    const data = record(result.json);
    if (data.sha !== expected || !Array.isArray(data.parents)) throw new GitHubConflict('commit_identity');
    return { tree: sha(record(data.tree).sha), parents: data.parents.map((parent: unknown) => sha(record(parent).sha)) };
  }

  async function readCommitTree(target: ApprovedPrTarget, commitSha: string) {
    return (await readCommit(target, commitSha))?.tree ?? null;
  }

  async function readTree(target: ApprovedPrTarget, treeSha: string) {
    const result = await request(`${repoPath(target)}/git/trees/${sha(treeSha)}`, 'GET', undefined, true);
    if (!result) return null;
    const data = record(result.json);
    if (data.sha !== treeSha || data.truncated !== false || !Array.isArray(data.tree)) throw new GitHubConflict('incomplete_tree');
    const tree = new Map<string, TreeEntry>();
    for (const value of data.tree) {
      const entry = record(value);
      const { path, type, mode } = entry;
      if (typeof path !== 'string' || !path || path.length > 255 || path.includes('/') || path.includes('\\')
        || [...path].some((char) => char.charCodeAt(0) < 32) || path === '.' || path === '..' || tree.has(path)
        || !validTreeMode(type, mode)) throw new GitHubConflict('invalid_tree_entry');
      tree.set(path, { path, type: String(type), mode: String(mode), sha: sha(entry.sha) });
    }
    return tree;
  }

  async function readBlob(target: ApprovedPrTarget, objectSha: string, length: number) {
    const result = await request(`${repoPath(target)}/git/blobs/${sha(objectSha)}`, 'GET', undefined, true);
    if (!result) return false;
    const data = record(result.json);
    if (data.sha !== objectSha || data.encoding !== 'base64' || typeof data.content !== 'string' || data.size !== length
      || data.content.length > Math.ceil(length * 1.4) + 1024) throw new GitHubConflict('blob_identity');
    const bytes = Buffer.from(data.content, 'base64');
    if (bytes.length !== length || gitBlobSha(bytes) !== objectSha) throw new GitHubConflict('blob_identity');
    return true;
  }

  async function getPullRequest(target: ApprovedPrTarget, number: number) {
    const result = await request(`${repoPath(target)}/pulls/${positiveInteger(number)}`, 'GET', undefined, true);
    return result ? pullIdentity(result.json) : null;
  }

  async function listPullRequests(target: ApprovedPrTarget, branch: string): Promise<PullIdentity[]> {
    const path = `${repoPath(target)}/pulls`;
    const filters = { state: 'all', head: `${target.owner}:${branch}`, base: target.baseRef, per_page: '100' };
    const found = new Map<number, PullIdentity>();
    let page = 1;
    for (let count = 0; count < 1000; count++) {
      const query = new URLSearchParams({ ...filters, page: String(page) });
      const result = await request(`${path}?${query}`);
      if (!Array.isArray(result?.json)) throw new Error('GITHUB_RESPONSE_INVALID');
      for (const entry of result.json) {
        const pull = pullIdentity(entry);
        const previous = found.get(pull.number);
        if (previous && JSON.stringify(previous) !== JSON.stringify(pull)) throw new GitHubConflict('inconsistent_pr_readback');
        found.set(pull.number, pull);
      }
      if (found.size > 1) return [...found.values()];
      const next = result.link?.split(',').find((link) => /;\s*rel="next"(?:\s*;|\s*$)/.test(link))?.match(/<([^>]+)>/)?.[1];
      if (!next) return [...found.values()];
      const parsed = new URL(next);
      const nextPage = Number(parsed.searchParams.get('page'));
      // GitHub may replace the owner/name route with an equivalent repository-ID route.
      const validPath = parsed.pathname === path || parsed.pathname === `/repositories/${target.repoId}/pulls`;
      if (parsed.origin !== origin || !validPath || parsed.username || parsed.password || !Number.isSafeInteger(nextPage) || nextPage <= page) {
        throw new Error('GITHUB_PAGINATION_INVALID');
      }
      page = nextPage;
    }
    throw new Error('GITHUB_PAGINATION_INCOMPLETE');
  }

  async function createTree(target: ApprovedPrTarget, input: GitTreeWrite) {
    const result = await request(`${repoPath(target)}/git/trees`, 'POST', input);
    return sha(record(result?.json).sha);
  }

  async function createCommit(target: ApprovedPrTarget, input: GitCommitWrite) {
    const result = await request(`${repoPath(target)}/git/commits`, 'POST', input);
    return sha(record(result?.json).sha);
  }

  return {
    assertRepo, assertWriter, createTree, createCommit, readRef, readCommit, readCommitTree, readTree, readBlob, getPullRequest, listPullRequests,
    async createRef(intent: PrIntent) {
      await request(`${repoPath(intent.target)}/git/refs`, 'POST', { ref: `refs/heads/${intent.frozen.branch}`, sha: intent.frozen.headSha });
    },
    async createPullRequest(intent: PrIntent) {
      const result = await request(`${repoPath(intent.target)}/pulls`, 'POST', {
        head: intent.frozen.branch, base: intent.frozen.baseRef, title: intent.artifact.title, body: intent.artifact.body,
      });
      return pullIdentity(result?.json);
    },
    async createBlob(intent: PrIntent, bytes: Uint8Array) {
      const result = await request(`${repoPath(intent.target)}/git/blobs`, 'POST', {
        content: Buffer.from(bytes).toString('base64'), encoding: 'base64',
      });
      return sha(record(result?.json).sha);
    },
    createReplacementTree: (intent: PrIntent, baseTree: string) => createTree(intent.target, {
      base_tree: sha(baseTree), tree: [patchEntry(intent)],
    }),
    createReplacement: (intent: PrIntent, treeSha: string, parents: string[], recipe: { authoredAt: string; message: string }) => {
      const identity = { name: authorName, email: authorEmail, date: recipe.authoredAt };
      return createCommit(intent.target, { message: recipe.message, tree: sha(treeSha), parents: parents.map(sha),
        author: identity, committer: identity });
    },
    async updateRef(intent: PrIntent, replacement: string) {
      await request(`${repoPath(intent.target)}/git/refs/heads/${refPath(intent.frozen.branch)}`, 'PATCH', {
        sha: sha(replacement), force: false,
      });
    },
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;

// The service is the sole dispatcher. This keeps concurrent local calls from treating the live POST
// window as a restart. Durable per-stage permits also prevent duplicate sends on reopening SQLite.
const inFlight = new Set<string>();

export function createPrPublisher(repository: EffectRepository, github: GitHubClient, { allowWrites = true, blobs }: { allowWrites?: boolean; blobs?: BlobStore } = {}) {
  async function perform(intentId: string, publish: boolean): Promise<EffectReceipt> {
    const receipt = repository.receipt(intentId);
    if (inFlight.has(intentId) || receipt.status === 'blocked' || receipt.status === 'conflict'
      || (publish && !repository.ownsDispatch(intentId))) return receipt;
    inFlight.add(intentId);
    try {
      const intent = repository.intent(intentId);
      if (receipt.proof) {
        await readVerifiedPublication(repository, github, intent, receipt.proof);
        return receipt;
      }
      if (!publish && receipt.status === 'pending') return receipt;
      try {
        await github.assertRepo(intent.target);
        if (!publish || !allowWrites || repository.dispatchVersion(intentId, 'create_pr')) return await reconcileFirst(intent);
        return await dispatchFirst(intent);
      } catch (error) {
        if (error instanceof GitHubWriterDenied) {
          return repository.mark(intentId, repository.hasDispatch(intentId) ? 'uncertain' : 'blocked', error.message);
        }
        return error instanceof GitHubConflict
          ? repository.mark(intentId, 'conflict', error.message)
          : repository.mark(intentId, 'uncertain', 'github_read_or_send_unknown');
      }
    } finally {
      inFlight.delete(intentId);
    }
  }

  async function dispatchFirst(intent: PrIntent, replace = true): Promise<EffectReceipt> {
    const { intentId, target, frozen, artifact } = intent;
    const existing = await readPull(repository, github, intent);
    if (existing) return await finishFirst(intent, existing, { rebuild: false });
    // The list can establish a number before the detail endpoint becomes consistent.
    if (repository.receipt(intentId).remoteNumber !== null) return repository.mark(intentId, 'uncertain', 'pr_not_visible');
    const baseBeforeRef = await github.readRef(target, frozen.baseRef);
    if (!baseBeforeRef) return repository.mark(intentId, 'uncertain', 'base_unavailable');
    let branchHead = await github.readRef(target, frozen.branch);
    const priorRef = repository.dispatchVersion(intentId, 'create_ref');
    if (!branchHead && priorRef) return repository.mark(intentId, 'uncertain', 'branch_not_visible');
    const planned = repository.rebuild(intentId);
    if (branchHead && branchHead !== frozen.headSha && branchHead !== planned?.replacement_head_sha) {
      return repository.mark(intentId, 'conflict', 'fixed_branch_conflict');
    }
    if (baseBeforeRef !== artifact.baseSha || (planned && !planned.applied_at)) {
      if (!replace) return repository.mark(intentId, 'uncertain', 'base_advancing');
      const result = await rebuildArtifact(intent, { number: null, headSha: branchHead, baseSha: baseBeforeRef });
      return result ?? await dispatchFirst(repository.intent(intentId), false);
    }
    const tree = await github.readCommitTree(target, frozen.headSha);
    if (!tree) {
      const result = await materializeOriginal(intent);
      if (result) return result;
    } else if (tree !== frozen.treeSha) return repository.mark(intentId, 'conflict', 'artifact_tree_mismatch');

    const baseAtSend = await github.readRef(target, frozen.baseRef);
    if (!baseAtSend) return repository.mark(intentId, 'uncertain', 'base_unavailable');
    if (baseAtSend !== artifact.baseSha) {
      if (!replace) return repository.mark(intentId, 'uncertain', 'base_advancing');
      const result = await rebuildArtifact(intent, { number: null, headSha: branchHead, baseSha: baseAtSend });
      return result ?? await dispatchFirst(repository.intent(intentId), false);
    }
    if (!branchHead) {
      await github.assertWriter(intent);
      if (!repository.claimSend(intentId, 'create_ref', frozen.headSha)) return repository.receipt(intentId);
      await github.createRef(intent);
      branchHead = await github.readRef(target, frozen.branch);
    }
    if (!branchHead) return repository.mark(intentId, 'uncertain', 'branch_not_visible');
    if (branchHead !== frozen.headSha) return repository.mark(intentId, 'conflict', 'fixed_branch_conflict');
    await github.assertWriter(intent);
    const baseBeforePr = await github.readRef(target, frozen.baseRef);
    if (!baseBeforePr) return repository.mark(intentId, 'uncertain', 'base_unavailable');
    const headBeforePr = await github.readRef(target, frozen.branch);
    if (!headBeforePr) return repository.mark(intentId, 'uncertain', 'head_unavailable_at_pr_send');
    if (headBeforePr !== frozen.headSha) return repository.mark(intentId, 'conflict', 'fixed_branch_changed_at_pr_send');
    if (baseBeforePr !== artifact.baseSha) {
      if (!replace) return repository.mark(intentId, 'uncertain', 'base_advancing');
      const result = await rebuildArtifact(intent, { number: null, headSha: branchHead, baseSha: baseBeforePr });
      return result ?? await dispatchFirst(repository.intent(intentId), false);
    }
    if (!repository.claimSend(intentId, 'create_pr', baseBeforePr, undefined, headBeforePr)) return repository.receipt(intentId);
    const created = await github.createPullRequest(intent);
    if (!identityMatches(created, intent)) return repository.mark(intentId, 'conflict', 'create_response_identity');
    repository.mark(intentId, 'uncertain', 'awaiting_readback', created.number);
    const observed = await readPull(repository, github, intent);
    if (!observed) return repository.mark(intentId, 'uncertain', 'pr_not_visible');
    if (created.baseSha !== baseBeforePr) return repository.mark(intentId, 'uncertain', 'base_changed_during_post');
    return await finishFirst(intent, observed, { sendBase: baseBeforePr, rebuild: false });
  }

  async function materializeBlob(intent: PrIntent): Promise<boolean> {
    const { intentId, patch, target } = intent;
    if (!patch.material) return true; // A separately verified immutable commit already proved the blob binding.
    const { contentHash, length } = patch.material;
    if (await github.readBlob(target, patch.after, length)) return true;
    if (!allowWrites || !blobs || repository.dispatchVersion(intentId, 'build_blob')) return false;
    const bytes = await blobs.readBlob(contentHash);
    if (bytes.byteLength !== length || gitBlobSha(bytes) !== patch.after || createHash('sha256').update(bytes).digest('hex') !== contentHash) {
      throw new GitHubConflict('approved_bytes_mismatch');
    }
    await github.assertWriter(intent);
    if (!repository.claimSend(intentId, 'build_blob', patch.after)) return false;
    if (await github.createBlob(intent, bytes) !== patch.after) throw new GitHubConflict('built_blob_mismatch');
    return github.readBlob(target, patch.after, length);
  }

  async function materializeOriginal(intent: PrIntent): Promise<EffectReceipt | null> {
    const { intentId, target, artifact, patch } = intent;
    const material = patch.material;
    if (!material) return repository.mark(intentId, 'uncertain', 'artifact_commit_unavailable');
    if (!await materializeBlob(intent)) return repository.mark(intentId, 'uncertain', 'artifact_blob_unavailable');
    const baseTree = await github.readTree(target, material.baseTree);
    if (!baseTree) return repository.mark(intentId, 'uncertain', 'artifact_base_tree_unavailable');
    const baseUnchanged = async () => await github.readRef(target, target.baseRef) === artifact.baseSha;
    let builtTree = await github.readTree(target, artifact.treeSha);
    if (!builtTree) {
      await github.assertWriter(intent);
      if (!await baseUnchanged() || !repository.claimSend(intentId, 'build_tree', artifact.treeSha)) return repository.receipt(intentId);
      if (await github.createReplacementTree(intent, material.baseTree) !== artifact.treeSha) throw new GitHubConflict('built_tree_mismatch');
      builtTree = await github.readTree(target, artifact.treeSha);
    }
    if (!builtTree) return repository.mark(intentId, 'uncertain', 'artifact_tree_unavailable');
    if (!hasExactPatch(baseTree, builtTree, patch)) throw new GitHubConflict('built_tree_mismatch');
    await github.assertWriter(intent);
    if (!await baseUnchanged() || !repository.claimSend(intentId, 'build_commit', artifact.headSha)) return repository.receipt(intentId);
    const head = await github.createReplacement(intent, artifact.treeSha, [artifact.baseSha], material);
    if (head !== artifact.headSha) throw new GitHubConflict('built_commit_mismatch');
    const observed = await github.readCommit(target, artifact.headSha);
    if (!observed) return repository.mark(intentId, 'uncertain', 'artifact_commit_unavailable');
    if (observed.tree !== artifact.treeSha || observed.parents.length !== 1 || observed.parents[0] !== artifact.baseSha) {
      throw new GitHubConflict('built_commit_mismatch');
    }
    return null;
  }

  async function reconcileFirst(intent: PrIntent): Promise<EffectReceipt> {
    const observed = await readPull(repository, github, intent);
    if (!observed) return repository.mark(intent.intentId, 'uncertain', 'pr_not_visible');
    return await finishFirst(intent, observed, { rebuild: true });
  }

  async function finishFirst(intent: PrIntent, observed: PrSnapshot, options: { sendBase?: string; rebuild: boolean }): Promise<EffectReceipt> {
    const { intentId, target, frozen } = intent;
    const { actual, pull } = observed;
    if (pull.state === 'open' && await github.readRef(target, frozen.branch) !== actual.headSha) {
      return repository.mark(intentId, 'uncertain', 'head_changed_during_readback', actual.number);
    }
    const baseNow = await github.readRef(target, frozen.baseRef);
    if (!baseNow || actual.currentBaseSha !== baseNow || (options.sendBase && options.sendBase !== baseNow)) {
      return repository.mark(intentId, 'uncertain', 'base_changed_during_readback', actual.number);
    }
    const pending = repository.mark(intentId, 'uncertain', 'awaiting_verification', actual.number);
    if (terminal.includes(pending.status)) return pending;
    if (canVerifyFirstPublication(actual, frozen, baseNow)) return repository.verify(intentId, actual, baseNow);
    if (!options.rebuild) return repository.mark(intentId, 'uncertain', 'artifact_changed_before_verification', actual.number);
    if (!repository.dispatchVersion(intentId, 'create_pr')) {
      return repository.mark(intentId, 'conflict', 'unowned_pr_artifact_changed', actual.number);
    }
    if (pull.state !== 'open') return repository.mark(intentId, 'conflict', 'closed_pr_artifact_changed', actual.number);
    const result = await rebuildArtifact(intent, { number: actual.number, headSha: actual.headSha, baseSha: baseNow });
    if (result) return result;
    const active = repository.intent(intentId);
    const built = await readPull(repository, github, active);
    if (!built) return repository.mark(intentId, 'uncertain', 'rebuilt_pr_not_visible', actual.number);
    return await finishFirst(active, built, { sendBase: baseNow, rebuild: false });
  }

  async function rebuildArtifact(
    intent: PrIntent, version: { number: number | null; headSha: string | null; baseSha: string },
  ): Promise<EffectReceipt | null> {
    const { intentId, target, frozen, patch } = intent;
    const prior = repository.rebuild(intentId);
    const pending = prior && !prior.applied_at ? prior : undefined;
    if (pending && (pending.remote_number !== version.number || pending.observed_base_sha !== version.baseSha
      || (version.headSha !== pending.parent_head_sha && version.headSha !== pending.replacement_head_sha))) {
      return repository.mark(intentId, 'conflict', 'replacement_version_changed');
    }
    if (prior?.applied_at && prior.remote_number !== null) return repository.mark(intentId, 'conflict', 'branch_changed_again');
    const oldHead = pending ? pending.parent_head_sha : version.headSha;
    const base = await github.readCommit(target, version.baseSha);
    const baseTree = base ? await github.readTree(target, base.tree) : null;
    if (!base || !baseTree) return repository.mark(intentId, 'uncertain', 'base_tree_unavailable');
    const currentFile = baseTree.get(patch.path);
    if ((currentFile?.sha ?? null) !== patch.before || (currentFile && currentFile.mode !== '100644')
      || [...baseTree.keys()].some((path) => path !== patch.path && path.toLowerCase() === patch.path.toLowerCase())) {
      return repository.mark(intentId, 'conflict', 'approved_patch_conflicts_with_base');
    }
    if (oldHead && oldHead !== frozen.headSha) {
      const oldTree = await github.readCommitTree(target, oldHead);
      const original = await github.readTree(target, frozen.treeSha);
      const actual = oldTree ? await github.readTree(target, oldTree) : null;
      if (!original || !actual) return repository.mark(intentId, 'uncertain', 'branch_tree_unavailable');
      if (!sameTreeExcept(original, actual, patch.path) && !sameTreeExcept(baseTree, actual, patch.path)) {
        return repository.mark(intentId, 'conflict', 'branch_contains_unrelated_changes');
      }
    }
    if ((!allowWrites || !repository.ownsDispatch(intentId)) && !pending) return repository.mark(intentId, 'uncertain', 'publication_writes_disabled');
    const parents = oldHead && oldHead !== version.baseSha ? [oldHead, version.baseSha] : [version.baseSha];
    const change = patchEntry(intent);
    const tree = gitTreeSha(new Map(baseTree).set(patch.path, change));
    const message = `Rebuild verified plan artifact (${intent.effectKey})`;
    const date = new Date(Math.floor(Date.parse(intent.createdAt) / 1000) * 1000).toISOString();
    const identity = { name: authorName, email: authorEmail, date };
    const replacement = gitCommitSha(tree, parents, date, message);
    const recipe = { tree: { base_tree: base.tree, tree: [change] },
      commit: { message, tree, parents, author: identity, committer: identity } };
    const plan = repository.prepareRebuild(intentId, { number: version.number, headSha: oldHead, baseSha: version.baseSha,
      baseTree: base.tree, expectedTree: tree, expectedHead: replacement, payload: recipe });
    const payload = JSON.parse(plan.payload) as RebuildPayload;
    if (!await materializeBlob(intent)) return repository.mark(intentId, 'uncertain', 'artifact_blob_unavailable');
    const sameVersion = async (head: string | null) => await github.readRef(target, frozen.baseRef) === version.baseSha
      && await github.readRef(target, frozen.branch) === head;
    let actualTree = await github.readTree(target, tree);
    if (!actualTree) {
      if (allowWrites && !repository.dispatchVersion(intentId, 'rebuild_tree', plan.rebuild_id)) await github.assertWriter(intent);
      if (!allowWrites || repository.dispatchVersion(intentId, 'rebuild_tree', plan.rebuild_id)
        || !await sameVersion(oldHead) || !repository.claimSend(intentId, 'rebuild_tree', tree, plan.rebuild_id)) {
        return repository.mark(intentId, 'uncertain', 'replacement_tree_not_visible');
      }
      if (await github.createTree(target, payload.tree) !== tree) throw new GitHubConflict('replacement_tree_mismatch');
      actualTree = await github.readTree(target, tree);
    }
    if (!actualTree) return repository.mark(intentId, 'uncertain', 'replacement_tree_not_visible');
    if (!hasExactPatch(baseTree, actualTree, patch)) return repository.mark(intentId, 'conflict', 'replacement_patch_mismatch');
    let commit = await github.readCommit(target, replacement);
    if (!commit) {
      if (allowWrites && !repository.dispatchVersion(intentId, 'rebuild_commit', plan.rebuild_id)) await github.assertWriter(intent);
      if (!allowWrites || repository.dispatchVersion(intentId, 'rebuild_commit', plan.rebuild_id)
        || !await sameVersion(oldHead) || !repository.claimSend(intentId, 'rebuild_commit', replacement, plan.rebuild_id)) {
        return repository.mark(intentId, 'uncertain', 'replacement_commit_not_visible');
      }
      if (await github.createCommit(target, payload.commit) !== replacement) throw new GitHubConflict('replacement_commit_mismatch');
      commit = await github.readCommit(target, replacement);
    }
    if (!commit) return repository.mark(intentId, 'uncertain', 'replacement_commit_not_visible');
    if (commit.tree !== tree || commit.parents.length !== parents.length || commit.parents.some((parent, i) => parent !== parents[i])) {
      return repository.mark(intentId, 'conflict', 'replacement_commit_mismatch');
    }
    if (oldHead && !await sameVersion(replacement)) {
      if (allowWrites) await github.assertWriter(intent);
      if (!await sameVersion(oldHead)) return repository.mark(intentId, 'uncertain', 'version_changed_before_rebuild');
      if (!allowWrites || !repository.claimSend(intentId, 'update_ref', oldHead, plan.rebuild_id)) return repository.receipt(intentId);
      // Fast-forward only: the existing branch tip is a parent and the observed base is an ancestor.
      await github.updateRef(intent, replacement);
    }
    if (!await sameVersion(oldHead ? replacement : null)) return repository.mark(intentId, 'uncertain', 'replacement_not_visible');
    repository.activateReplacement(intentId, plan.rebuild_id, replacement, tree, version.baseSha);
    return null;
  }

  return {
    publishPr: (intentId: string): Promise<EffectReceipt> => perform(intentId, true),
    reconcilePr: (intentId: string): Promise<EffectReceipt> => perform(intentId, false),
  };
}

async function readPull(repository: EffectRepository, github: GitHubClient, intent: PrIntent): Promise<PrSnapshot | null> {
  const { target, frozen } = intent;
  let number = repository.receipt(intent.intentId).remoteNumber;
  if (number === null) {
    const matches = await github.listPullRequests(target, frozen.branch);
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new GitHubConflict('multiple_pull_requests');
    const candidate = matches[0]!;
    if (!identityMatches(candidate, intent)) throw new GitHubConflict('pull_identity');
    number = candidate.number;
    const bound = repository.mark(intent.intentId, 'uncertain', 'awaiting_readback', number);
    if (bound.status === 'conflict') throw new GitHubConflict('pull_identity');
  }
  const pull = await github.getPullRequest(target, number);
  if (!pull) return null;
  if (!identityMatches(pull, intent, number)) throw new GitHubConflict('pull_identity');
  return snapshot(github, intent, pull);
}

async function snapshot(github: GitHubClient, intent: PrIntent, pull: PullIdentity, historical = false): Promise<PrSnapshot | null> {
  const treeSha = await github.readCommitTree(intent.target, pull.headSha);
  const currentBaseSha = historical ? pull.baseSha : await github.readRef(intent.target, intent.frozen.baseRef);
  if (!treeSha || !currentBaseSha) return null;
  return { pull, actual: { repoId: pull.repoId, headRepoId: pull.headRepoId, branch: pull.branch,
    number: pull.number, headSha: pull.headSha, treeSha, baseRef: pull.baseRef, currentBaseSha } };
}

type VerifiedObservation = { kind: 'unchanged' | 'head_changed'; snapshot: PrSnapshot } | { kind: 'identity_anomaly' | 'unavailable' };

export async function readVerifiedPublication(
  repository: EffectRepository, github: GitHubClient, intent: PrIntent, proof: VerifiedPr,
): Promise<VerifiedObservation> {
  const anomaly = (key: string, at = intent.createdAt): VerifiedObservation => {
    repository.observe(intent.intentId, 'identity_anomaly', key, at);
    return { kind: 'identity_anomaly' };
  };
  try {
    await github.assertRepo(intent.target);
    const pull = await github.getPullRequest(intent.target, proof.number);
    if (!pull) return { kind: 'unavailable' };
    if (!identityMatches(pull, intent, proof.number)) {
      return anomaly(JSON.stringify([pull.number, pull.repoId, pull.headRepoId, pull.branch, pull.baseRef]), pull.updatedAt);
    }
    const observed = await snapshot(github, intent, pull, true);
    if (!observed) return { kind: 'unavailable' };
    if (matchesVerifiedPr(observed.actual, proof)) return { kind: 'unchanged', snapshot: observed };
    repository.observe(intent.intentId, 'head_changed', JSON.stringify([observed.actual.headSha, observed.actual.treeSha]), pull.updatedAt);
    return { kind: 'head_changed', snapshot: observed };
  } catch (error) {
    return error instanceof GitHubConflict ? anomaly(error.message) : { kind: 'unavailable' };
  }
}

function patchEntry(intent: PrIntent): TreeEntry {
  return { path: intent.patch.path, type: 'blob', mode: '100644', sha: intent.patch.after };
}

function identityMatches(pull: PullIdentity, intent: PrIntent, number?: number) {
  const observed = { ...pull, treeSha: '', currentBaseSha: '' };
  return matchesPrIdentity(observed, intent.frozen, number);
}

function pullIdentity(input: unknown): PullIdentity {
  const data = record(input);
  const head = record(data.head);
  const base = record(data.base);
  if (typeof head.ref !== 'string' || typeof base.ref !== 'string'
    || (data.state !== 'open' && data.state !== 'closed')) throw new Error('GITHUB_RESPONSE_INVALID');
  // GitHub omits the merged flag from some representations; a close is judged only from GET.
  if (typeof data.updated_at !== 'string' || !Number.isFinite(Date.parse(data.updated_at))) throw new Error('GITHUB_RESPONSE_INVALID');
  return {
    number: positiveInteger(data.number), headRepoId: repoId(head.repo), repoId: repoId(base.repo),
    branch: head.ref, headSha: sha(head.sha), baseRef: base.ref, baseSha: sha(base.sha), state: data.state,
    merged: data.state === 'closed' && (data.merged === true
      || (typeof data.merged_at === 'string' && Number.isFinite(Date.parse(data.merged_at)))) ? true
      : data.merged === false || data.merged_at === null ? false : null,
    updatedAt: new Date(data.updated_at).toISOString(),
  };
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GITHUB_RESPONSE_INVALID');
  return value as JsonRecord;
}

function refPath(ref: string): string {
  return ref.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error('GITHUB_RESPONSE_INVALID');
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('GITHUB_RESPONSE_INVALID');
  return value;
}

function repoId(value: unknown): string {
  // A null head repository is a remote identity anomaly, not an edit to the built artifact.
  if (value === null) return '';
  return String(positiveInteger(record(value).id));
}
