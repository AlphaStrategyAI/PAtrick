import { expect, it } from 'vitest';
import type { DeliveryReceipt, Project } from '../../src/domain.js';
import { operationsWatch } from '../../src/operations.js';

function project(provider: Project['repositoryProvider'] = 'github'): Project {
  return { id: 'p', projectId: 'p', domain: 'personal', name: '笔记', description: '', repository: 'owner/repo', repositoryProvider: provider, prdPath: 'docs/product/PRD.md', allowedPaths: ['docs/product/PRD.md'], trustedChecks: ['validate', 'lint'], trustedAppIds: [7], ownerId: 'owner', autoMerge: true, budgetUsd: 0, createdAt: '2026-11-07T00:00:00.000Z' };
}
function receipt(patch: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return { id: 'receipt', projectId: 'p', domain: 'personal', taskId: 'task', repository: 'owner/repo', path: 'docs/product/PRD.md', pullRequestUrl: 'https://github.com/owner/repo/pull/4', pullRequestNumber: 4, headSha: 'head', mergeSha: 'merge', contentHash: 'hash', verifiedAt: '2026-11-07T00:00:00.000Z', checks: [{ name: 'validate', conclusion: 'success', headSha: 'head', appId: 7, url: 'https://github.com/owner/repo/checks/1' }, { name: 'lint', conclusion: 'success', headSha: 'head', appId: 7, url: 'https://github.com/owner/repo/checks/2' }], ...patch };
}

it('keeps a merged receipt bound to its head without measuring release error or dispatching another chain', () => {
  const watch = operationsWatch(project(), receipt());
  expect(watch).toMatchObject({ provider: 'github', headSha: 'head', mergeSha: 'merge', checks: [{ name: 'validate', headSha: 'head' }, { name: 'lint', headSha: 'head' }], errorRate: null, rollback: null, dispatched: false });
});

it('does not treat a required check on another head as the merged commit', () => {
  const watch = operationsWatch(project('gitlab'), receipt({ checks: [{ name: 'validate', conclusion: 'success', headSha: 'other', appId: 7, url: 'https://gitlab.example/checks/1' }, { name: 'lint', conclusion: 'success', headSha: 'head', appId: 7, url: 'https://gitlab.example/checks/2' }] }));
  expect(watch).toBeNull();
});
