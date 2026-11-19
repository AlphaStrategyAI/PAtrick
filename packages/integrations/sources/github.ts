import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** The GitHub REST version this reader speaks. */
export const GITHUB_API_VERSION = '2022-11-28' as const;

export type GithubTreeEntry = {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size: number;
};

export type GithubApiPort = {
  /** Lists every object under the branch, so the reader never sees a partial tree. */
  listTree(input: { repo: string; branch: string; token: string }): Promise<GithubTreeEntry[]>;
  readBlob(input: { repo: string; sha: string; token: string }): Promise<Uint8Array>;
};

export type GithubApiOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxEntries?: number;
  maxBlobBytes?: number;
};

/** Reads objects from the live GitHub API.
 *
 * The token only ever travels in the Authorization header, the base URL is fixed,
 * and every response is bounded in size and time. A tree the API had to truncate
 * is refused rather than read as if it were complete.
 */
export function createGithubApi(options: GithubApiOptions = {}): GithubApiPort {
  const baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/u, '');
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxEntries = options.maxEntries ?? 20_000;
  const maxBlobBytes = options.maxBlobBytes ?? 4 * 1024 * 1024;

  async function request(path: string, token: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'patrick-source-reader',
          'x-github-api-version': GITHUB_API_VERSION,
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`GITHUB_API_STATUS_${response.status}`);
      const text = await response.text();
      if (text.length > maxBlobBytes * 4) throw new Error('GITHUB_RESPONSE_TOO_LARGE');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error('GITHUB_RESPONSE_INVALID');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listTree({ repo, branch, token }) {
      const body = await request(`/repos/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token);
      if (!body || typeof body !== 'object') throw new Error('GITHUB_RESPONSE_INVALID');
      const record = body as { tree?: unknown; truncated?: unknown };
      if (record.truncated === true) throw new Error('GITHUB_TREE_TRUNCATED');
      if (!Array.isArray(record.tree)) throw new Error('GITHUB_RESPONSE_INVALID');
      if (record.tree.length > maxEntries) throw new Error('GITHUB_TREE_TOO_LARGE');
      const entries: GithubTreeEntry[] = [];
      for (const entry of record.tree) {
        if (!entry || typeof entry !== 'object') throw new Error('GITHUB_RESPONSE_INVALID');
        const row = entry as { path?: unknown; type?: unknown; sha?: unknown; size?: unknown };
        if (typeof row.path !== 'string' || typeof row.sha !== 'string') throw new Error('GITHUB_RESPONSE_INVALID');
        if (row.type !== 'blob' && row.type !== 'tree') continue;
        entries.push({ path: row.path, type: row.type, sha: row.sha, size: typeof row.size === 'number' ? row.size : 0 });
      }
      return entries;
    },
    async readBlob({ repo, sha, token }) {
      const body = await request(`/repos/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`, token);
      if (!body || typeof body !== 'object') throw new Error('GITHUB_RESPONSE_INVALID');
      const record = body as { content?: unknown; encoding?: unknown };
      if (record.encoding !== 'base64' || typeof record.content !== 'string') throw new Error('GITHUB_RESPONSE_INVALID');
      const bytes = Buffer.from(record.content, 'base64');
      if (bytes.length > maxBlobBytes) throw new Error('GITHUB_BLOB_TOO_LARGE');
      return new Uint8Array(bytes);
    },
  };
}

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
