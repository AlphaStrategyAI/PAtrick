import { DomainError, now, stableId, type AppConfig, type Project } from '../domain.js';
import { sourceExpansionPaused } from '../evaluation.js';
import { openLearning } from '../learning.js';
import type { Workbench } from '../orchestrator.js';
import type { Store } from '../store.js';

const snowflake = /^\d{1,25}$/;

export function xBookmarkCursor(project: Project): string {
  return stableId('x-bookmarks', project.domain, project.id);
}

interface Bookmark { id: string; text: string; revision: string }

/** Read the newest page of the owner's X bookmarks. The first scan does not walk older pages, and a failed page leaves the cursor put. */
export async function scanXBookmarks(store: Store, config: Pick<AppConfig, 'xToken'>, project: Project, engine: Pick<Workbench, 'ingest'>, fetcher: typeof fetch = fetch, apiUrl = 'https://api.x.com'): Promise<'imported' | 'idle'> {
  const api = async (path: string): Promise<unknown> => {
    if (!config.xToken) throw new DomainError('Save an X bookmark token before scanning bookmarks.', 'delivery_unready', 409);
    let response: Response;
    try { response = await fetcher(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${config.xToken}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new DomainError('X bookmark scan was interrupted. The bookmark cursor stays put.', 'remote_unavailable', 503); }
    if (!response.ok) throw new DomainError(`X bookmark scan returned ${response.status}. The bookmark cursor stays put.`, response.status === 401 || response.status === 403 ? 'remote_auth' : 'remote_unavailable', response.status === 401 || response.status === 403 ? 403 : 503);
    return response.json();
  };
  const me = await api('/2/users/me') as { data?: { id?: unknown; username?: unknown } };
  const userId = me.data?.id;
  const username = me.data?.username;
  if (typeof userId !== 'string' || !snowflake.test(userId) || typeof username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new DomainError('X did not return the bookmark owner.', 'remote_invalid', 503);
  const page = await api(`/2/users/${userId}/bookmarks?max_results=20&tweet.fields=text,edit_history_tweet_ids`) as { data?: unknown; meta?: { result_count?: unknown } };
  const rows = Array.isArray(page.data) ? page.data : page.data === undefined ? [] : undefined;
  if (!rows || rows.length > 20) throw new DomainError('X returned a bookmark page the scan cannot read.', 'remote_invalid', 503);
  const bookmarks: Bookmark[] = rows.map(row => {
    const id = (row as { id?: unknown }).id;
    const text = (row as { text?: unknown }).text;
    const edits = (row as { edit_history_tweet_ids?: unknown }).edit_history_tweet_ids;
    if (typeof id !== 'string' || !snowflake.test(id) || typeof text !== 'string' || !text.trim() || text.length > 25_000) throw new DomainError('X returned a bookmark without a usable id or text.', 'remote_invalid', 503);
    if (edits !== undefined && (!Array.isArray(edits) || edits.some(item => typeof item !== 'string' || !snowflake.test(item)) || !edits.includes(id))) throw new DomainError('X returned a bookmark edit history that does not include the bookmark.', 'remote_invalid', 503);
    const revision = Array.isArray(edits) ? String(edits.at(-1)) : id;
    return { id, text: text.trim(), revision };
  });
  const cursorId = xBookmarkCursor(project);
  const saved = store.get('cursors', cursorId)?.value;
  const boundary = saved && saved !== 'none' ? rows.findIndex(row => (row as { id?: unknown }).id === saved) : bookmarks.length;
  if (saved && saved !== 'none' && boundary < 0) throw new DomainError('The newest bookmark page no longer contains the saved bookmark. The cursor stays put.', 'x_bookmark_gap', 409);
  const fresh = bookmarks.slice(0, boundary).reverse();
  if (fresh.length && !store.list('sources').some(source => source.projectId === project.id && source.domain === project.domain && source.kind === 'reading' && source.externalId.startsWith('x-bookmark:')) && sourceExpansionPaused(store, project)) throw new DomainError('Source expansion is paused. The X bookmark cursor stays put.', 'source_expansion_paused', 409);
  for (const bookmark of fresh) {
    const externalId = `x-bookmark:${bookmark.id}`;
    const current = store.list('sources').find(source => source.projectId === project.id && source.domain === project.domain && source.kind === 'reading' && source.status === 'active' && source.externalId === externalId);
    if (current?.content !== bookmark.text) {
      engine.ingest({ projectId: project.id, kind: 'reading', purpose: 'reference', externalId, revision: bookmark.revision, title: bookmark.text.split('\n')[0]!.slice(0, 80), content: bookmark.text, locator: `https://x.com/i/web/status/${bookmark.id}`, authorId: `x:${username}`, retention: 'permanent' });
    }
    const source = store.list('sources').find(source => source.projectId === project.id && source.domain === project.domain && source.kind === 'reading' && source.status === 'active' && source.externalId === externalId && source.revision === bookmark.revision);
    if (!source || source.id !== stableId('source', { projectId: project.id, domain: project.domain }, 'reading', externalId, bookmark.revision)) throw new DomainError('The bookmark was not stored under its X id.', 'revision_conflict', 409);
    openLearning(store, source, bookmark.id);
  }
  const newest = bookmarks[0]?.id ?? 'none';
  if (saved === newest) return 'idle';
  store.save('cursors', { id: cursorId, projectId: project.id, domain: project.domain, value: newest, updatedAt: now() });
  return fresh.length ? 'imported' : 'idle';
}
