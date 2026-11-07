import { DomainError, stableId, type AppConfig, type DeliveryReceipt, type Project, type Task } from './domain.js';
import { ingestSource, type IngestInput } from './intake.js';
import type { Store } from './store.js';

export interface OperationsWatch {
  provider: 'github' | 'gitlab';
  pullRequestUrl: string;
  pullRequestNumber: number;
  mergeSha: string;
  headSha: string;
  checks: { name: string; headSha: string }[];
  errorRate: null;
  rollback: null;
  dispatched: false;
}

/** A merged receipt can name the same-commit checks. It cannot invent a release error rate, a rollback, or another worker chain. */
export function operationsWatch(project: Project, receipt: DeliveryReceipt): OperationsWatch | null {
  if (receipt.projectId !== project.id || receipt.domain !== project.domain || receipt.repository !== project.repository || receipt.path !== project.prdPath || !project.trustedChecks.length) return null;
  const checks = project.trustedChecks.flatMap(name => {
    const check = receipt.checks.find(item => item.name === name && item.conclusion === 'success' && item.headSha === receipt.headSha && project.trustedAppIds.includes(item.appId) && item.url.startsWith('https://'));
    return check ? [{ name: check.name, headSha: check.headSha }] : [];
  });
  if (checks.length !== project.trustedChecks.length || !receipt.mergeSha.trim() || !Number.isInteger(receipt.pullRequestNumber) || receipt.pullRequestNumber < 1) return null;
  try { if (new URL(receipt.pullRequestUrl).protocol !== 'https:') return null; } catch { return null; }
  return { provider: project.repositoryProvider, pullRequestUrl: receipt.pullRequestUrl, pullRequestNumber: receipt.pullRequestNumber, mergeSha: receipt.mergeSha, headSha: receipt.headSha, checks, errorRate: null, rollback: null, dispatched: false };
}

/** Start one chain from recorded evidence. The receipt still does not supply an error rate or a rollback. */
export function openReleaseFollowUp(store: Store, config: Pick<AppConfig, 'projects' | 'billingBoundary'>, input: { receiptId: string; evidenceSourceId: string }): Task {
  const receipt = store.get('receipts', input.receiptId);
  const project = receipt && store.get('projects', receipt.projectId);
  const evidence = store.get('sources', input.evidenceSourceId);
  if (!receipt || !project || !operationsWatch(project, receipt) || !evidence || evidence.status !== 'active' || evidence.projectId !== project.id || evidence.domain !== project.domain || evidence.retention !== 'permanent' || evidence.externalId.startsWith('release:')) throw new DomainError('A merged receipt and one permanent project source are required before another chain can start.', 'release_unready', 409);
  const id = stableId('operations.follow-up', receipt.id);
  const existing = store.get('actions', id);
  const existingTaskId = existing?.kind === 'operations.follow-up' ? existing.payload.taskId : undefined;
  if (typeof existingTaskId === 'string') {
    const task = store.get('tasks', existingTaskId);
    if (task && task.projectId === project.id) return task;
  }
  const task = ingestSource(store, config, { projectId: project.id, kind: 'manual', externalId: `release:${receipt.id}`, revision: receipt.mergeSha, title: evidence.title, content: evidence.content, locator: receipt.pullRequestUrl, authorId: evidence.authorId, retention: 'permanent' } satisfies IngestInput);
  if (!task) throw new DomainError('The release evidence did not open a task.', 'release_unready', 409);
  const payload: Record<string, unknown> = { receiptId: receipt.id, mergeSha: receipt.mergeSha, headSha: receipt.headSha, evidenceSourceId: evidence.id, taskId: task.id, errorRate: null, rollback: null };
  store.save('actions', { id, projectId: project.id, domain: project.domain, taskId: task.id, kind: 'operations.follow-up', status: 'pending', payload, updatedAt: task.updatedAt });
  return task;
}
