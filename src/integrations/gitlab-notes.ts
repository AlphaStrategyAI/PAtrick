import { DomainError, digest, type AppConfig, type Project } from '../domain.js';
import type { IngestInput } from '../intake.js';
import type { Workbench } from '../orchestrator.js';
import type { Store } from '../store.js';

const marker = /PAtrick action |<!-- patrick:/;

/** Notes on a merge request this host already opened stay on that task. */
export async function scanGitlabNotes(store: Store, config: Pick<AppConfig, 'gitlabUrl' | 'gitlabToken'>, project: Project, engine: Pick<Workbench, 'ingest'>, fetcher: typeof fetch = fetch): Promise<'idle' | 'advanced'> {
  if (project.repositoryProvider !== 'gitlab') return 'idle';
  const base = approvedBase(config);
  const notesFor = subscribedRequests(store, project);
  let advanced = false;
  for (const [iid, taskId] of notesFor) {
    if (taskId === 'ambiguous') continue;
    const listed = await api(fetcher, base, config.gitlabToken!, `/api/v4/projects/${encodeURIComponent(project.repository)}/merge_requests/${iid}/notes?per_page=100`);
    if (!Array.isArray(listed) || listed.length > 100) throw new DomainError('GitLab did not return a bounded note page. Nothing new was imported.', 'remote_invalid', 503);
    for (const item of listed) {
      const note = readNote(item);
      if (!note || note.system || marker.test(note.body)) continue;
      const before = store.list('tasks').find(task => task.id === taskId);
      const input: IngestInput = { projectId: project.id, kind: 'gitlab', externalId: `gitlab-note:${project.repository}!${iid}:${note.id}`, revision: digest([note.updatedAt, note.body]), title: note.body.trim().split('\n')[0]!.slice(0, 120) || `评论 ${note.id}`, content: note.body, locator: `${base}/${project.repository}/-/merge_requests/${iid}#note_${note.id}`, authorId: note.author, retention: 'permanent', subscribedTaskId: taskId };
      engine.ingest(input);
      const after = store.list('tasks').find(task => task.id === taskId);
      if (after && before && after.version !== before.version) advanced = true;
    }
  }
  return advanced ? 'advanced' : 'idle';
}

function approvedBase(config: Pick<AppConfig, 'gitlabUrl' | 'gitlabToken'>): string {
  let url: URL;
  try { url = new URL(config.gitlabUrl ?? ''); }
  catch { throw new DomainError('Set an explicitly approved HTTPS GitLab URL before reading merge request notes.', 'delivery_unready', 409); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !config.gitlabToken) throw new DomainError('GitLab notes require an approved HTTPS base URL and token.', 'delivery_unready', 409);
  return url.href.replace(/\/+$/, '');
}

function subscribedRequests(store: Store, project: Project): Map<number, string | 'ambiguous'> {
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

function readNote(item: unknown): { id: number; body: string; updatedAt: string; author: string; system: boolean } | undefined {
  const note = item as { id?: unknown; body?: unknown; updated_at?: unknown; system?: unknown; author?: { username?: unknown } };
  if (!Number.isInteger(note.id) || typeof note.body !== 'string' || !note.body.trim() || typeof note.updated_at !== 'string' || typeof note.author?.username !== 'string' || typeof note.system !== 'boolean') return undefined;
  return { id: note.id as number, body: note.body, updatedAt: note.updated_at, author: note.author.username, system: note.system };
}

async function api(fetcher: typeof fetch, base: string, token: string, path: string): Promise<unknown> {
  let response: Response;
  try { response = await fetcher(`${base}${path}`, { headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
  catch { throw new DomainError('GitLab note scan was interrupted. No note was imported.', 'remote_unavailable', 503); }
  if (!response.ok) throw new DomainError(`GitLab note scan returned ${response.status}. No note was imported.`, response.status === 401 || response.status === 403 ? 'remote_auth' : 'remote_unavailable', response.status === 401 || response.status === 403 ? 403 : 503);
  return response.json();
}
