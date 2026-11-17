import type { CaseOutcome, EffectRepository } from '@patrick/domain/effects';
import { readVerifiedPublication, type GitHubClient } from './github.js';

export function createOutcomeObserver(repository: EffectRepository, github: GitHubClient) {
  return {
    async observeOutcome(caseId: string, remoteRef: string): Promise<CaseOutcome> {
      const intent = repository.intentForOutcome(caseId, remoteRef);
      const proof = repository.receipt(intent.intentId).proof;
      if (!proof) throw new Error('NOT_FOUND');
      const observation = await readVerifiedPublication(repository, github, intent, proof);
      if (!('snapshot' in observation)) return { result: 'unknown', source: remoteRef, observed_at: intent.createdAt };
      const { pull } = observation.snapshot;
      const result = observation.kind === 'head_changed' ? 'rework' : pull.merged === true ? 'accepted'
        : pull.state === 'closed' && pull.merged === false ? 'rejected' : 'unknown';
      const outcome = { result, source: remoteRef, observed_at: pull.updatedAt } satisfies CaseOutcome;
      if (outcome.result !== 'unknown') await repository.recordOutcome(intent.intentId, outcome);
      repository.markWatchRevision(intent.intentId, pull.updatedAt);
      return outcome;
    },
  };
}
