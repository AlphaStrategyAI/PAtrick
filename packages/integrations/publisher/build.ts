import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalPayload } from '@patrick/contracts';
import type { BuildContext, BuildVerifier } from '@patrick/domain/effects';
import type { BlobStore } from '@patrick/storage';
import type { GitHubClient, TreeEntry } from './github.js';

import { readExactFile } from '../../executor/src/ledger.js';
import { createDeliveryRequest, planLimit, sealDeliveryMarkdown, type DeliveryArtifact } from '../../executor/src/delivery-artifact.js';
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export function buildWorkspace(root: string, context: Pick<BuildContext, 'workId' | 'generation' | 'attemptId'>) {
  return resolve(root, sha256(canonicalPayload([context.workId, context.generation])), context.attemptId);
}

export function planPath(context: Pick<BuildContext, 'workId' | 'generation'>) {
  return `patrick-plan-${sha256(canonicalPayload([context.workId, context.generation])).slice(0, 32)}.md`;
}

function gitSha(type: string, bytes: Uint8Array) {
  return createHash('sha1').update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

export function gitBlobSha(bytes: Uint8Array) { return gitSha('blob', bytes); }

export const authorName = 'PAtrick';
export const authorEmail = 'publisher@patrick.invalid';

export function gitTreeSha(tree: Map<string, TreeEntry>) {
  const key = (entry: TreeEntry) => Buffer.from(entry.path + (entry.type === 'tree' ? '/' : ''));
  const entries = [...tree.values()].sort((a, b) => Buffer.compare(key(a), key(b)));
  return gitSha('tree', Buffer.concat(entries.flatMap((entry) => [
    Buffer.from(`${entry.mode.replace(/^0/, '')} ${entry.path}\0`), Buffer.from(entry.sha, 'hex'),
  ])));
}

export function gitCommitSha(tree: string, parents: string[], authoredAt: string, message: string) {
  const identity = `${authorName} <${authorEmail}> ${Date.parse(authoredAt) / 1000} +0000`;
  return gitSha('commit', Buffer.from(`tree ${tree}
${parents.map((parent) => `parent ${parent}
`).join('')}author ${identity}
committer ${identity}

${message}
`));
}

export function hasExactPatch(base: Map<string, TreeEntry>, target: Map<string, TreeEntry>, patch: { path: string; after: string }) {
  const changed = target.get(patch.path);
  return changed?.sha === patch.after && changed.type === 'blob' && changed.mode === '100644' && sameTreeExcept(base, target, patch.path);
}

/** The model can write its isolated plan, but only the fixed producer can approve its scoped commit. */
export function createPrBuildVerifier(github: GitHubClient, options: { artifactsRoot: string; receiptsRoot: string; blobs: BlobStore }): BuildVerifier {
  const root = resolve(options.artifactsRoot);
  return async (target, context, candidate) => {
    if (!/^[-A-Za-z0-9]+$/.test(context.attemptId)) throw new Error('INVALID_BUILD_ATTEMPT');
    const outputs = await realpath(root);
    const receipts = await realpath(options.receiptsRoot);
    if (outputs === receipts || outputs.startsWith(receipts + '/') || receipts.startsWith(outputs + '/')) throw new Error('BUILD_ROOTS_MUST_BE_SEPARATE');
    const jobs = buildWorkspace(outputs, context);
    const ledger = buildWorkspace(receipts, context);
    const terminal = readText(join(ledger, 'terminal', `${context.attemptId}.json`), 64 * 1024, 'supervisor_record');
    const receipt = JSON.parse(terminal) as {
      classification?: string; origin?: string; attempt_id?: string; exit_code?: number | null; execution_binding?: string; delivery_artifact?: DeliveryArtifact;
      subject?: { kind?: string; work_id?: string; generation?: number; next_action?: string; judgment_basis?: { hash?: string } };
    };
    if (receipt.origin !== 'wrapper' || receipt.classification !== 'agent_completed' || receipt.exit_code !== 0
      || receipt.attempt_id !== context.attemptId || receipt.subject?.kind !== 'work' || receipt.subject.work_id !== context.workId
      || receipt.subject.generation !== context.generation || receipt.subject.next_action !== 'publish_pr'
      || receipt.subject.judgment_basis?.hash !== context.basisHash) throw new Error('BUILD_PRODUCER_MISMATCH');
    const claim = JSON.parse(readText(join(ledger, 'execution_claim', `${context.attemptId}.json`), 64 * 1024, 'supervisor_record')) as {
      binding?: string; attempt_id?: string; grant_id?: string; request_sha256?: string;
    };
    if (!receipt.execution_binding || !/^[a-f0-9]{64}$/.test(receipt.execution_binding) || claim.binding !== receipt.execution_binding
      || claim.attempt_id !== context.attemptId || claim.grant_id !== context.grantId) throw new Error('BUILD_CLAIM_MISMATCH');
    const source = await options.blobs.readBlob(context.sourceHash);
    if (sha256(source) !== context.sourceHash) throw new Error('BUILD_SOURCE_MISMATCH');
    const request = createDeliveryRequest(source, { source_revision: context.sourceRevision, source_sha256: context.sourceHash });
    if (claim.request_sha256 !== request.sha256) throw new Error('BUILD_REQUEST_MISMATCH');
    const markdown = readText(join(jobs, 'plan.md'), planLimit);
    const { bytes, artifact: expectedSeal } = sealDeliveryMarkdown(markdown, {
      source_revision: context.sourceRevision, source_sha256: context.sourceHash, work_id: context.workId,
      generation: context.generation, attempt_id: context.attemptId, basis_hash: context.basisHash, evidence_watermark: context.evidenceWatermark,
    }, request.sha256);
    if (!receipt.delivery_artifact || canonicalPayload(receipt.delivery_artifact) !== canonicalPayload(expectedSeal)) {
      throw new Error('BUILD_RECEIPT_MISMATCH');
    }
    const path = planPath(context);
    const after = gitBlobSha(bytes);
    await github.assertRepo(target);
    const baseSha = await github.readRef(target, target.baseRef);
    if (!baseSha || (candidate.baseSha && baseSha !== candidate.baseSha)) throw new Error('BUILD_BASE_CHANGED');
    const base = await github.readCommit(target, baseSha);
    const baseTree = base ? await github.readTree(target, base.tree) : null;
    if (!base || !baseTree) throw new Error('BUILD_BASE_UNAVAILABLE');
    const previous = baseTree.get(path);
    const before = previous?.sha ?? null;
    if ((previous && previous.mode !== '100644') || before === after
      || [...baseTree.keys()].some((entry) => entry !== path && entry.toLowerCase() === path.toLowerCase())) {
      throw new Error('BUILD_PATCH_MISMATCH');
    }
    const contentHash = sha256(bytes);
    const approved = { path, before, after, digest: sha256(canonicalPayload([path, before, after, contentHash, context.sourceRevision, context.basisHash])) };
    if (candidate.headSha && candidate.treeSha) {
      const head = await github.readCommit(target, candidate.headSha);
      if (head?.tree !== candidate.treeSha || head.parents.length !== 1 || head.parents[0] !== baseSha) {
        throw new Error('BUILD_COMMIT_MISMATCH');
      }
      const builtTree = await github.readTree(target, head.tree);
      if (!builtTree || !hasExactPatch(baseTree, builtTree, approved)) throw new Error('BUILD_PATCH_MISMATCH');
      return { artifact: { ...candidate, baseSha, headSha: candidate.headSha, treeSha: candidate.treeSha }, patch: approved };
    }
    // Derive the exact Git objects from the verified bytes without any remote mutation.
    const tree = new Map(baseTree).set(path, { path, type: 'blob', mode: '100644', sha: after });
    const treeSha = gitTreeSha(tree);
    const authoredAt = new Date(Math.floor(Date.parse(context.createdAt) / 1000) * 1000).toISOString();
    const message = `Plan for work ${sha256(canonicalPayload([context.workId, context.generation, context.attemptId]))}`;
    const headSha = gitCommitSha(treeSha, [baseSha], authoredAt, message);
    if (await options.blobs.putBlob(bytes) !== contentHash) throw new Error('BUILD_OUTPUT_STORAGE_MISMATCH');
    return { artifact: { ...candidate, baseSha, headSha, treeSha }, patch: { ...approved, material: {
      contentHash, length: bytes.byteLength, baseTree: base.tree, authoredAt, message,
    } } };
  };
}

export function sameTreeExcept(a: Map<string, TreeEntry>, b: Map<string, TreeEntry>, path: string): boolean {
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].every((name) => name === path || canonicalPayload(a.get(name) ?? null) === canonicalPayload(b.get(name) ?? null));
}

function readText(path: string, limit: number, kind: 'plan' | 'supervisor_record' = 'plan'): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readExactFile(path, limit, kind));
}
