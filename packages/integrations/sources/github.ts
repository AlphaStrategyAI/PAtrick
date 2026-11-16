import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Local fixture reader. This task does not call the live GitHub network. */
export const GITHUB_LIVE_NETWORK = 'not-used' as const;

export type GithubScope = {
  repo: string;
  branch: string;
  path: string;
};

export type GithubChange = {
  path: string;
  kind: 'create' | 'modify' | 'delete';
};

export type ClassifiedGithub = {
  origin: 'source' | 'review' | 'bot_output';
  repo: string;
  branch: string;
  changes: GithubChange[];
};

export function verifyGithubSignature(rawBody: Uint8Array, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const given = signatureHeader.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/.test(given)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

export function classifyGithubPayload(payload: unknown): ClassifiedGithub {
  if (!payload || typeof payload !== 'object') throw new Error('GITHUB_PAYLOAD_INVALID');
  const body = payload as Record<string, unknown>;
  const repository = body.repository;
  const repo = repository && typeof repository === 'object' && typeof (repository as { full_name?: unknown }).full_name === 'string'
    ? (repository as { full_name: string }).full_name
    : '';
  const branch = typeof body.ref === 'string' && body.ref.startsWith('refs/heads/')
    ? body.ref.slice('refs/heads/'.length)
    : '';
  const origin = originOf(body, branch);
  return { origin, repo, branch, changes: origin === 'source' ? changesOf(body) : [] };
}

export function approvedGithubPath(scope: GithubScope, change: { repo: string; branch: string; path: string }): string | null {
  if (change.repo !== scope.repo || change.branch !== scope.branch) return null;
  const relative = normalizeGithubPath(change.path);
  const prefix = normalizeGithubPath(scope.path);
  if (!relative || !prefix) return null;
  if (relative === prefix || relative.startsWith(`${prefix}/`)) return relative;
  return null;
}

export function normalizeGithubPath(input: string): string | null {
  if (input.startsWith('/') || input.includes('\\') || input.includes('\0') || input.includes('://')) return null;
  const parts = input.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    stack.push(part);
  }
  return stack.length === 0 ? null : stack.join('/');
}

export function readApprovedGithubObject(fixtureRoot: string, scope: GithubScope, relativePath: string): Uint8Array {
  const approved = approvedGithubPath(scope, { repo: scope.repo, branch: scope.branch, path: relativePath });
  if (!approved) throw new Error('GITHUB_PATH_NOT_APPROVED');
  const base = resolve(fixtureRoot, scope.repo, scope.branch, scope.path);
  const target = resolve(fixtureRoot, scope.repo, scope.branch, approved);
  if (!isInside(base, target)) throw new Error('GITHUB_PATH_NOT_APPROVED');
  const baseReal = realpathSync(base);
  const targetReal = realpathSync(target);
  if (!isInside(baseReal, targetReal)) throw new Error('GITHUB_PATH_NOT_APPROVED');
  return new Uint8Array(readFileSync(targetReal));
}

function originOf(body: Record<string, unknown>, branch: string): ClassifiedGithub['origin'] {
  if (body.review && typeof body.review === 'object') return 'review';
  const sender = body.sender;
  if (sender && typeof sender === 'object') {
    const record = sender as { type?: unknown; login?: unknown };
    if (record.type === 'Bot') return 'bot_output';
    if (typeof record.login === 'string' && record.login.endsWith('[bot]')) return 'bot_output';
  }
  if (branch === 'dependabot' || branch.startsWith('dependabot/')) return 'bot_output';
  return 'source';
}

function changesOf(body: Record<string, unknown>): GithubChange[] {
  if (!Array.isArray(body.commits)) return [];
  const changes: GithubChange[] = [];
  for (const commit of body.commits) {
    if (!commit || typeof commit !== 'object') continue;
    const record = commit as Record<string, unknown>;
    for (const path of strings(record.added)) changes.push({ path, kind: 'create' });
    for (const path of strings(record.modified)) changes.push({ path, kind: 'modify' });
    for (const path of strings(record.removed)) changes.push({ path, kind: 'delete' });
  }
  return changes;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function isInside(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(prefix);
}
