import { DomainError, now, stableId, type AppConfig, type Project } from '../domain.js';
import { sourceExpansionPaused } from '../evaluation.js';
import type { Workbench } from '../orchestrator.js';
import type { Store } from '../store.js';

const historyIdPattern = /^\d{1,20}$/;
const messageIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export function gmailCursor(project: Project): string {
  return stableId('gmail-history', project.domain, project.id);
}

function textFromMessage(message: { payload?: { mimeType?: unknown; body?: { data?: unknown } }; snippet?: unknown }): string {
  const data = message.payload?.mimeType === 'text/plain' ? message.payload.body?.data : undefined;
  if (typeof data !== 'string' || !data) throw new DomainError('Gmail did not return the message text. The history cursor stays put.', 'remote_invalid', 503);
  const text = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim();
  if (!text || text.length > 1_000_000) throw new DomainError('Gmail message text is missing or too large. The history cursor stays put.', 'remote_invalid', 503);
  return text;
}

/** Record the current Gmail history id first. Later scans import only messages added after that id. */
export async function scanGmail(store: Store, config: Pick<AppConfig, 'gmailToken'>, project: Project, engine: Pick<Workbench, 'ingest'>, fetcher: typeof fetch = fetch, apiUrl = 'https://gmail.googleapis.com'): Promise<'baselined' | 'idle' | 'imported'> {
  const api = async (path: string): Promise<unknown> => {
    if (!config.gmailToken) throw new DomainError('Save a Gmail token before scanning mail.', 'delivery_unready', 409);
    let response: Response;
    try { response = await fetcher(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${config.gmailToken}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new DomainError('Gmail scan was interrupted. The history cursor stays put.', 'remote_unavailable', 503); }
    if (response.status === 404) throw new DomainError('Gmail no longer has the saved history id. The cursor stays put.', 'gmail_history_gap', 409);
    if (!response.ok) throw new DomainError(`Gmail scan returned ${response.status}. The history cursor stays put.`, response.status === 401 || response.status === 403 ? 'remote_auth' : 'remote_unavailable', response.status === 401 || response.status === 403 ? 403 : 503);
    return response.json();
  };
  const profile = await api('/gmail/v1/users/me/profile') as { emailAddress?: unknown; historyId?: unknown };
  if (typeof profile.emailAddress !== 'string' || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(profile.emailAddress) || typeof profile.historyId !== 'string' || !historyIdPattern.test(profile.historyId)) throw new DomainError('Gmail did not return an account and history id.', 'remote_invalid', 503);
  const cursorId = gmailCursor(project);
  const saved = store.get('cursors', cursorId)?.value;
  if (!saved) {
    store.save('cursors', { id: cursorId, projectId: project.id, domain: project.domain, value: profile.historyId, updatedAt: now() });
    return 'baselined';
  }
  if (!historyIdPattern.test(saved)) throw new DomainError('The saved Gmail history cursor is not a history id.', 'remote_invalid', 503);
  if (saved === profile.historyId) return 'idle';
  const page = await api(`/gmail/v1/users/me/history?startHistoryId=${saved}&historyTypes=messageAdded&maxResults=20`) as { history?: unknown; historyId?: unknown; nextPageToken?: unknown };
  if (page.nextPageToken || typeof page.historyId !== 'string' || !historyIdPattern.test(page.historyId)) throw new DomainError('Gmail history is longer than one page or has no new history id. The cursor stays put.', 'gmail_history_gap', 409);
  const records = Array.isArray(page.history) ? page.history : [];
  const ids: string[] = [];
  for (const record of records) {
    const added = (record as { messagesAdded?: unknown }).messagesAdded;
    if (!Array.isArray(added)) throw new DomainError('Gmail returned a history record without added messages.', 'remote_invalid', 503);
    for (const item of added) {
      const id = (item as { message?: { id?: unknown } }).message?.id;
      if (typeof id !== 'string' || !messageIdPattern.test(id)) throw new DomainError('Gmail returned a message the scan cannot identify.', 'remote_invalid', 503);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  if (ids.length > 20) throw new DomainError('Gmail added more messages than this scan will import. The cursor stays put.', 'gmail_history_gap', 409);
  if (ids.length && !store.list('sources').some(source => source.projectId === project.id && source.domain === project.domain && source.kind === 'email' && source.externalId.startsWith('gmail:')) && sourceExpansionPaused(store, project)) throw new DomainError('Source expansion is paused. The Gmail history cursor stays put.', 'source_expansion_paused', 409);
  for (const id of ids) {
    const message = await api(`/gmail/v1/users/me/messages/${id}?format=full`) as { id?: unknown; payload?: { mimeType?: unknown; headers?: unknown; body?: { data?: unknown } } };
    if (message.id !== id) throw new DomainError('Gmail returned a different message. The history cursor stays put.', 'remote_invalid', 503);
    const content = textFromMessage(message);
    const headers = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
    const subject = headers.find(header => (header as { name?: unknown }).name === 'Subject' && typeof (header as { value?: unknown }).value === 'string') as { value?: string } | undefined;
    const externalId = `gmail:${id}`;
    const current = store.list('sources').find(source => source.projectId === project.id && source.domain === project.domain && source.kind === 'email' && source.status === 'active' && source.externalId === externalId);
    if (current?.content !== content) {
      engine.ingest({ projectId: project.id, kind: 'email', purpose: 'reference', externalId, revision: page.historyId, title: (subject?.value ?? id).slice(0, 80), content, locator: `https://mail.google.com/mail/u/0/#all/${id}`, authorId: profile.emailAddress, retention: 'permanent' });
    }
  }
  store.save('cursors', { id: cursorId, projectId: project.id, domain: project.domain, value: page.historyId, updatedAt: now() });
  return ids.length ? 'imported' : 'idle';
}
