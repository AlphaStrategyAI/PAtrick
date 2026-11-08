import { DomainError, digest, type AppConfig, type Project } from '../domain.js';
import type { IngestInput } from '../intake.js';
import type { Workbench } from '../orchestrator.js';
import type { Store } from '../store.js';

const marker = /PAtrick action |<!-- patrick:/;

/** Comments on a pull request this host already opened stay on that task. */
export async function scanGithubComments(store: Store, config: Pick<AppConfig, 'githubToken'>, project: Project, engine: Pick<Workbench, 'ingest' | 'withdraw'>, fetcher: typeof fetch = fetch, apiUrl = 'https://api.github.com'): Promise<'idle' | 'advanced'> {
  if (project.repositoryProvider !== 'github') return 'idle';
  if (!config.githubToken) throw new DomainError('Save a GitHub token before reading pull request comments.', 'delivery_unready', 409);
  const pulls = subscribedPulls(store, project);
  let advanced = false;
  for (const [number, taskId] of pulls) {
    if (taskId === 'ambiguous') continue;
    const listed = await api(fetcher, apiUrl, config.githubToken, `/repos/${project.repository}/issues/${number}/comments?per_page=100`);
    if (!Array.isArray(listed) || listed.length > 100) throw new DomainError('GitHub did not return a bounded comment page. Nothing new was imported.', 'remote_invalid', 503);
    const comments = listed.flatMap(item => { const comment = readComment(item); return comment ? [comment] : []; });
    const complete = comments.length === listed.length && listed.length < 100;
    for (const comment of comments) {
      if (marker.test(comment.body)) continue;
      const before = store.list('tasks').find(task => task.id === taskId);
      const input: IngestInput = { projectId: project.id, kind: 'github', externalId: `github-comment:${project.repository}#${number}:${comment.id}`, revision: digest([comment.updatedAt, comment.body]), title: comment.body.trim().split('\n')[0]!.slice(0, 120) || `评论 ${comment.id}`, content: comment.body, locator: comment.url, authorId: comment.author, retention: 'permanent', subscribedTaskId: taskId };
      engine.ingest(input);
      const after = store.list('tasks').find(task => task.id === taskId);
      if (after && before && after.version !== before.version) advanced = true;
      if (!before) advanced = true;
    }
    if (complete) for (const source of store.list('sources')) {
      const prefix = `github-comment:${project.repository}#${number}:`;
      if (source.projectId !== project.id || source.domain !== project.domain || source.kind !== 'github' || source.status !== 'active' || !source.externalId.startsWith(prefix)) continue;
      const commentId = Number(source.externalId.slice(prefix.length));
      if (!comments.some(comment => comment.id === commentId)) { engine.withdraw(source.id); advanced = true; }
    }
  }
  return advanced ? 'advanced' : 'idle';
}

function subscribedPulls(store: Store, project: Project): Map<number, string | 'ambiguous'> {
  const found = new Map<number, Set<string>>();
  const add = (number: number, taskId: string) => {
    if (!Number.isInteger(number) || number < 1 || !taskId) return;
    const tasks = found.get(number) ?? new Set<string>();
    tasks.add(taskId);
    found.set(number, tasks);
  };
  for (const receipt of store.list('receipts')) if (receipt.projectId === project.id && receipt.domain === project.domain && receipt.repository === project.repository) add(receipt.pullRequestNumber, receipt.taskId);
  for (const action of store.list('actions')) if (action.kind === 'repository_delivery' && action.projectId === project.id && action.domain === project.domain && action.taskId && typeof action.payload.pullRequestNumber === 'number') add(action.payload.pullRequestNumber, action.taskId);
  return new Map([...found].map(([number, tasks]) => [number, tasks.size === 1 ? [...tasks][0]! : 'ambiguous']));
}

function readComment(item: unknown): { id: number; body: string; updatedAt: string; url: string; author: string } | undefined {
  const comment = item as { id?: unknown; body?: unknown; updated_at?: unknown; html_url?: unknown; user?: { login?: unknown } };
  if (!Number.isInteger(comment.id) || typeof comment.body !== 'string' || !comment.body.trim() || typeof comment.updated_at !== 'string' || typeof comment.html_url !== 'string' || typeof comment.user?.login !== 'string') return undefined;
  return { id: comment.id as number, body: comment.body, updatedAt: comment.updated_at, url: comment.html_url, author: comment.user.login };
}

async function api(fetcher: typeof fetch, apiUrl: string, token: string, path: string): Promise<unknown> {
  let response: Response;
  try { response = await fetcher(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
  catch { throw new DomainError('GitHub comment scan was interrupted. No comment was imported.', 'remote_unavailable', 503); }
  if (!response.ok) throw new DomainError(`GitHub comment scan returned ${response.status}. No comment was imported.`, response.status === 401 || response.status === 403 ? 'remote_auth' : 'remote_unavailable', response.status === 401 || response.status === 403 ? 403 : 503);
  return response.json();
}
