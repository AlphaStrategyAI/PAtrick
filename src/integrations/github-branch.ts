import { DomainError, now, pathAllowed, stableId, type AppConfig, type Project } from '../domain.js';
import type { Workbench } from '../orchestrator.js';
import type { Store } from '../store.js';

const sha = /^[0-9a-f]{40}$/;
const marker = 'PAtrick action ';

export function githubBranchCursor(project: Project): string {
  return stableId('github-branch', project.domain, project.id);
}

/** Follow the default branch. The first scan only records its current commit. Later scans import authorized file edits and skip this program's own delivery commits. */
export async function scanGithubBranch(store: Store, config: Pick<AppConfig, 'githubToken'>, project: Project, engine: Pick<Workbench, 'ingest' | 'withdraw'>, fetcher: typeof fetch = fetch, apiUrl = 'https://api.github.com'): Promise<'baselined' | 'idle' | 'advanced'> {
  if (project.repositoryProvider !== 'github') return 'idle';
  const api = async (path: string): Promise<unknown> => {
    if (!config.githubToken) throw new DomainError('Save a GitHub token before scanning a branch.', 'delivery_unready', 409);
    let response: Response;
    try { response = await fetcher(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new DomainError('GitHub branch scan was interrupted. The commit cursor stays put.', 'remote_unavailable', 503); }
    if (!response.ok) throw new DomainError(`GitHub branch scan returned ${response.status}. The commit cursor stays put.`, response.status === 401 || response.status === 403 ? 'remote_auth' : 'remote_unavailable', response.status === 401 || response.status === 403 ? 403 : 503);
    return response.json();
  };
  const repo = await api(`/repos/${project.repository}`) as { default_branch?: unknown };
  const branch = repo.default_branch;
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]{1,255}$/.test(branch) || branch.startsWith('/') || branch.includes('..')) throw new DomainError('GitHub did not return a usable default branch.', 'remote_invalid', 503);
  const ref = await api(`/repos/${project.repository}/commits/${encodeURIComponent(branch)}`) as { sha?: unknown };
  const head = ref.sha;
  if (typeof head !== 'string' || !sha.test(head)) throw new DomainError('GitHub did not return a commit for the default branch.', 'remote_invalid', 503);
  const cursorId = githubBranchCursor(project);
  const saved = store.get('cursors', cursorId)?.value;
  if (!saved) {
    store.save('cursors', { id: cursorId, projectId: project.id, domain: project.domain, value: head, updatedAt: now() });
    return 'baselined';
  }
  if (!sha.test(saved)) throw new DomainError('The saved GitHub branch cursor is not a commit.', 'remote_invalid', 503);
  if (saved === head) return 'idle';
  const compared = await api(`/repos/${project.repository}/compare/${saved}...${head}`) as { status?: unknown; ahead_by?: unknown; commits?: unknown };
  const commits = Array.isArray(compared.commits) ? compared.commits : undefined;
  if (compared.status !== 'ahead' || !commits || compared.ahead_by !== commits.length || commits.length < 1 || commits.length > 20) throw new DomainError('The default branch is not a short fast-forward from the saved commit. The cursor stays put.', 'github_branch_gap', 409);
  const delivered = new Set(store.list('receipts').filter(receipt => receipt.projectId === project.id && receipt.domain === project.domain).map(receipt => receipt.mergeSha));
  for (const item of commits) {
    const commitSha = (item as { sha?: unknown }).sha;
    const message = (item as { commit?: { message?: unknown } }).commit?.message;
    if (typeof commitSha !== 'string' || !sha.test(commitSha) || typeof message !== 'string') throw new DomainError('GitHub returned a commit the scan cannot identify.', 'remote_invalid', 503);
    if (message.includes(marker) || delivered.has(commitSha)) continue;
    const detail = await api(`/repos/${project.repository}/commits/${commitSha}`) as { sha?: unknown; files?: unknown };
    if (detail.sha !== commitSha || !Array.isArray(detail.files)) throw new DomainError('GitHub commit files do not match the compared commit.', 'remote_invalid', 503);
    for (const file of detail.files) {
      const filename = (file as { filename?: unknown }).filename;
      const status = (file as { status?: unknown }).status;
      if (typeof filename !== 'string' || typeof status !== 'string') throw new DomainError('GitHub returned an unreadable changed file.', 'remote_invalid', 503);
      let allowed = false;
      try { allowed = pathAllowed(filename, project.allowedPaths); } catch { allowed = false; }
      if (!allowed) continue;
      const externalId = `github:${branch}:${filename}`;
      if (status === 'removed') {
        const active = store.list('sources').find(source => source.projectId === project.id && source.domain === project.domain && source.kind === 'github' && source.status === 'active' && source.externalId === externalId);
        if (active) engine.withdraw(active.id);
        continue;
      }
      if (status !== 'added' && status !== 'modified') throw new DomainError('An authorized file changed in a way the scan does not import. The cursor stays put.', 'github_branch_gap', 409);
      const body = await api(`/repos/${project.repository}/contents/${filename.split('/').map(encodeURIComponent).join('/')}?ref=${commitSha}`) as { type?: unknown; encoding?: unknown; content?: unknown };
      if (body.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') throw new DomainError('An authorized file could not be read as text. The cursor stays put.', 'remote_invalid', 503);
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      const current = store.list('sources').find(source => source.projectId === project.id && source.domain === project.domain && source.kind === 'github' && source.status === 'active' && source.externalId === externalId);
      if (current?.content === content) continue;
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || filename.split('/').at(-1) || filename;
      engine.ingest({ projectId: project.id, kind: 'github', externalId, revision: commitSha, title, content, locator: `https://github.com/${project.repository}/blob/${commitSha}/${filename}`, authorId: project.ownerId, retention: 'permanent' });
    }
  }
  store.save('cursors', { id: cursorId, projectId: project.id, domain: project.domain, value: head, updatedAt: now() });
  return 'advanced';
}
