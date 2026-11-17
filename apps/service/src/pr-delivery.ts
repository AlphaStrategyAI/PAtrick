import type { BlobStore, SqliteDatabase } from '@patrick/storage';
import { createPrBuildVerifier } from '@patrick/integrations/publisher/build';
import { createGitHubClient, createPrPublisher, type BranchWriteAuthority } from '@patrick/integrations/publisher/github';
import { createOutcomeObserver } from '@patrick/integrations/publisher/outcomes';
import { createEffectRepository, type ApprovedPrTarget, type BuildCandidate } from '../../../packages/domain/src/effects.js';
import type { ExecutionGrant } from '../../../packages/domain/src/delegation.js';

type Credential = () => string | Promise<string>;

export type PrDeliveryOptions = {
  accountId: string;
  callerId: string;
  domain: string;
  target: ApprovedPrTarget;
  artifactsRoot: string;
  receiptsRoot: string;
  blobs: BlobStore;
  authorization?: Credential;
  writeAuthorization?: Credential;
  liveWrites?: boolean;
  branchAuthority?: BranchWriteAuthority;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  pollMs?: number;
  reportError?: (error: unknown) => void;
};

const batchSize = 12;

export function createPrDeliveryService(db: SqliteDatabase, now: () => Date, options: PrDeliveryOptions) {
  if (!options.accountId || !options.callerId || !options.domain || !options.artifactsRoot.trim() || !options.receiptsRoot.trim()) throw new Error('PUBLISHER_SCOPE_REQUIRED');
  const allowWrites = options.liveWrites === true;
  if (allowWrites && (!options.writeAuthorization || (!options.authorization && !options.fetch))) {
    throw new Error('PUBLISHER_SCOPED_CREDENTIALS_REQUIRED');
  }
  if (allowWrites && (!options.branchAuthority || options.branchAuthority.repoId !== options.target.repoId)) {
    throw new Error('PUBLISHER_SINGLE_WRITER_REQUIRED');
  }
  const github = createGitHubClient({
    fetch: options.fetch,
    authorization: options.authorization,
    writeAuthorization: allowWrites ? options.writeAuthorization : undefined,
    requireWriteAuthorization: true,
    branchAuthority: allowWrites ? options.branchAuthority : undefined,
  });
  const target = { ...options.target };
  const { accountId, callerId, domain, signal, reportError } = options;
  const verifyBuild = createPrBuildVerifier(github, { artifactsRoot: options.artifactsRoot, receiptsRoot: options.receiptsRoot, blobs: options.blobs });
  const stop = new AbortController();
  let stageCursor = '';
  let cursor = '';
  let watchCursor = '';
  let polling: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopped = () => stop.signal.aborted || signal?.aborted === true;

  function scopedRepository() {
    const account = db.prepare('SELECT auth_epoch FROM accounts WHERE account_id = ?').get(accountId) as { auth_epoch: number } | undefined;
    if (!account) return null;
    return createEffectRepository(db, {
      account_id: accountId, caller_id: callerId, auth_epoch: account.auth_epoch, domains: [domain], operations: ['publish_pr'],
    }, { domain, now, target, verifyBuild });
  }

  async function stage(repository: NonNullable<ReturnType<typeof scopedRepository>>, grant: ExecutionGrant, artifact: BuildCandidate) {
    const input = { workId: grant.work_id, generation: grant.generation, grant };
    // If the process died between recording the proof and freezing the intent, resume that exact proof first.
    try {
      return repository.freezePr(input);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'BUILD_PROOF_REQUIRED') throw error;
    }
    const { baseSha, title, body } = artifact;
    await repository.prepareBuild({ ...input, artifact: { ...(baseSha ? { baseSha } : {}), title, body } });
    return repository.freezePr(input);
  }

  async function poll() {
    if (stopped()) return;
    const repository = scopedRepository();
    if (!repository) return;
    if (allowWrites) {
      for (const grant of repository.buildCandidatesAfter(stageCursor, batchSize)) {
        if (stopped()) return;
        try {
          await stage(repository, grant, { title: 'Plan for review', body: 'Plan generated from the admitted source revision.' });
        } catch (error) {
          const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
          if (code !== 'ENOENT') reportError?.(error);
        }
        stageCursor = grant.grant_id;
      }
      if (repository.buildCandidatesAfter(stageCursor, 1).length === 0) stageCursor = '';
    }
    const publisher = createPrPublisher(repository, github, { allowWrites, blobs: options.blobs });
    const observer = createOutcomeObserver(repository, github);
    for (const item of repository.pendingAfter(cursor, batchSize)) {
      if (stopped()) return;
      try {
        if (allowWrites) await publisher.publishPr(item.intent_id);
        else await publisher.reconcilePr(item.intent_id);
      } catch (error) {
        reportError?.(error);
      }
      cursor = item.intent_id;
    }
    if (repository.pendingAfter(cursor, 1).length === 0) cursor = '';

    for (const watch of repository.watchesAfter(watchCursor, batchSize)) {
      if (stopped()) return;
      try {
        await observer.observeOutcome(watch.case_id, watch.remote_ref);
      } catch (error) {
        reportError?.(error);
      }
      watchCursor = watch.intent_id;
    }
    if (repository.watchesAfter(watchCursor, 1).length === 0) watchCursor = '';
  }

  function pollOnce(): Promise<void> {
    polling ??= poll().finally(() => { polling = undefined; });
    return polling;
  }

  function close() {
    stop.abort();
    signal?.removeEventListener('abort', close);
    clearInterval(timer);
  }

  return {
    // Private composition port for the supervisor; no model or HTTP route can stage a PR.
    async stageCompletedBuild(grant: ExecutionGrant, artifact: Pick<BuildCandidate, 'baseSha' | 'title' | 'body'>) {
      const repository = stopped() ? null : scopedRepository();
      if (!repository) throw new Error('PUBLISHER_SCOPE_UNAVAILABLE');
      return stage(repository, grant, artifact);
    },

    pollOnce,

    start() {
      if (timer || stopped()) return close;
      const interval = options.pollMs ?? 30_000;
      if (!Number.isSafeInteger(interval) || interval < 250) throw new Error('PUBLISHER_INTERVAL_INVALID');
      signal?.addEventListener('abort', close, { once: true });
      const run = () => { void pollOnce().catch((error) => reportError?.(error)); };
      timer = setInterval(run, interval);
      timer.unref();
      run();
      return close;
    },
  };
}
