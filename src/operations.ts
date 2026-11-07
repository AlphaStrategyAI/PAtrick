import type { DeliveryReceipt, Project } from './domain.js';

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
