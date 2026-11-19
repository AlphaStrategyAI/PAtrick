import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sourceEntrySchema, sourcePreviewSchema, sourceReaderCapabilitiesSchema, sourceReceiptSchema } from '@patrick/contracts/resources';
import type { Snapshot } from '@patrick/contracts/envelope';
import { z } from 'zod';
import { ClientError, scopedQueryKey } from '../../api/client.js';
import { sameScope } from '../../api/events.js';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate, type MessageKey } from '../../i18n/locale.js';
import type { Json } from '@patrick/contracts';
import { ChangeReceipt } from '../settings/SettingsGroup.js';
import { SettingsChangeWizard } from '../settings/SettingsChangeWizard.js';
import { RssHistoryPanel, RssHistoryReceiptFromUrl } from './RssHistoryPanel.js';
import { safeEnvelope } from '../settings/envelope.js';

const sourcePage = z.strictObject({ items: z.array(sourceEntrySchema), next_cursor: z.string().nullable() });
const receipts = z.strictObject({ items: z.array(sourceReceiptSchema) });
const options = ['poll', '30m', '1h', '6h', '24h'] as const;
const labels: Record<string, MessageKey> = {
  rss: 'collection.rss', webpage: 'collection.webpage', directory: 'collection.directory', github: 'collection.github',
  enabled: 'collection.enabled', paused: 'status.paused', disconnected: 'collection.disconnected', offline: 'status.offline',
  placeholder: 'collection.placeholder', enable: 'collection.enable', first_collection: 'collection.first',
  success: 'collection.success', failure: 'status.failed', pause: 'collection.pause', resume: 'collection.resume',
  disconnect: 'collection.disconnect', modify: 'collection.modify', withdraw: 'collection.withdraw',
};
type Source = z.infer<typeof sourceEntrySchema>;
type Preview = z.infer<typeof sourcePreviewSchema>;
type Edit = 'modify' | 'pause' | 'resume' | 'disconnect';
const readerLifetimeMs = 30_000;
const readerRefreshMs = 10_000;

/** A capability response is current only for a bounded interval from request start. */
function useDirectoryReader(enabled: boolean) {
  const { api, scope, accessGeneration } = useService();
  const generation = useRef(0);
  const instance = useRef(Symbol('directory-reader'));
  const [requiredGeneration, setRequiredGeneration] = useState(0);
  const query = useQuery({
    queryKey: scope ? [...scopedQueryKey(scope, 'getSourceReaderCapabilities', {}), accessGeneration]
      : ['patrick:locked', 'getSourceReaderCapabilities'],
    enabled: !!scope && enabled,
    retry: false,
    staleTime: 0,
    refetchInterval: readerRefreshMs,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const startedAt = Date.now();
      const startedMonotonic = performance.now();
      const requestGeneration = generation.current;
      const result = await api.read('getSourceReaderCapabilities', {}, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(readerLifetimeMs)]),
      });
      const elapsed = Date.now() - startedAt;
      const monotonicElapsed = performance.now() - startedMonotonic;
      if (elapsed < 0 || monotonicElapsed < 0 || elapsed >= readerLifetimeMs || monotonicElapsed >= readerLifetimeMs) {
        throw new ClientError('UNAVAILABLE');
      }
      return { data: sourceReaderCapabilitiesSchema.parse(result.data), startedAt, startedMonotonic,
        generation: requestGeneration, instance: instance.current };
    },
  });
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [, checkExpiry] = useState(0);
  const refetch = query.refetch;

  useEffect(() => {
    function invalidate() {
      const next = ++generation.current;
      setRequiredGeneration(next);
    }
    function revalidate() {
      invalidate();
      if (!enabled || !navigator.onLine || document.visibilityState !== 'visible') return;
      void refetch();
    }
    function visibilityChanged() {
      const next = document.visibilityState === 'visible';
      setVisible(next);
      if (next) revalidate();
      else invalidate();
    }
    function wentOffline() { setOnline(false); invalidate(); }
    function wentOnline() { setOnline(true); revalidate(); }
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('offline', wentOffline);
    window.addEventListener('online', wentOnline);
    return () => {
      generation.current++;
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('offline', wentOffline);
      window.removeEventListener('online', wentOnline);
    };
  }, [enabled, refetch]);

  useEffect(() => {
    if (!query.data) return;
    const remaining = Math.min(readerLifetimeMs - (Date.now() - query.data.startedAt),
      readerLifetimeMs - (performance.now() - query.data.startedMonotonic));
    if (remaining <= 0) { checkExpiry((n) => n + 1); return; }
    const timer = window.setTimeout(() => checkExpiry((n) => n + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [query.data]);

  const wallAge = query.data ? Date.now() - query.data.startedAt : -1;
  const monotonicAge = query.data ? performance.now() - query.data.startedMonotonic : -1;
  const fresh = visible && online && !query.error && query.data?.instance === instance.current
    && query.data.generation >= requiredGeneration && wallAge >= 0 && wallAge < readerLifetimeMs
    && monotonicAge >= 0 && monotonicAge < readerLifetimeMs;
  return { ...query, fresh };
}

export function CollectionPage() {
  const { scope, callerId, accessGeneration, scopeOperations } = useService();
  const { t } = useLocale();
  if (!scope || !callerId) return null;
  if (!scopeOperations.includes('owner') && !scopeOperations.includes('sources.read')) return <p role="status">{t('collection.restricted')}</p>;
  return <ScopedCollection key={JSON.stringify([scope, callerId, accessGeneration])} />;
}

function ScopedCollection() {
  const { t, locale } = useLocale();
  const { api, scope, callerId, scopeOperations } = useService();
  const owner = scopeOperations.includes('owner');
  const canPreview = owner || scopeOperations.includes('sources.detect');
  const [target, setTarget] = useState('');
  const [type, setType] = useState<'rss' | 'webpage' | 'github'>('rss');
  const [github, setGithub] = useState({ repo: '', branch: 'main', path: '' });
  const [token, setToken] = useState('');
  const [credentialRef, setCredentialRef] = useState<string>();
  const [frequency, chooseFrequency] = useState<string>('poll');
  const [preview, showPreview] = useState<Preview>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [selectedId, select] = useState<string>();
  const [operation, edit] = useState<Edit>();
  const active = useRef<AbortController | null>(null);
  const attempt = useRef<{ type: string; url: string; id: string } | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  const sources = useScopedSnapshot('listSources', { cursor }, sourcePage.parse);
  const detail = useScopedSnapshot('getSource', { id: selectedId }, sourceEntrySchema.parse, { enabled: !!selectedId });
  const source = detail.data?.data;
  const hasDirectory = !!source && source.connector_type === 'directory'
    || !!sources.data?.data.items.some((item) => item.connector_type === 'directory');
  const reader = useDirectoryReader(hasDirectory);
  const log = useScopedSnapshot('getSourceReceipts', { id: source?.source_id }, receipts.parse,
    { enabled: !!source, refetchInterval: 10_000 });

  function changeType(next: 'rss' | 'webpage' | 'github') { setType(next); clearPreview(); }

  /** Stages the GitHub token so the secret never travels with the change. */
  async function stageToken() {
    if (!token.trim() || loading) return;
    setLoading(true);
    setFailure(undefined);
    try {
      const staged = await api.write('putSourceCredential', {}, { token }) as { credential_ref?: string };
      if (!staged.credential_ref) throw new ClientError('INVALID_RESPONSE');
      setCredentialRef(staged.credential_ref);
      setToken('');
    } catch (error) {
      setFailure(asClientError(error).code);
    } finally {
      setLoading(false);
    }
  }
  function clearPreview() { showPreview(undefined); setFailure(undefined); attempt.current = null; }

  async function detect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!scope || !callerId || !target.trim() || active.current) return;
    showPreview(undefined);
    setFailure(undefined);
    setLoading(true);
    const pending = new AbortController();
    active.current = pending;
    const url = target.trim();
    if (!attempt.current || attempt.current.type !== type || attempt.current.url !== url) {
      attempt.current = { type, url, id: crypto.randomUUID() };
    }
    try {
      const draft: Json = type === 'github'
        ? { type, target: url, repo: github.repo, branch: github.branch, path: github.path, credential_ref: credentialRef ?? '' }
        : { type, target: url };
      const intent = await safeEnvelope({ ...draft, request_scope: { ...scope, caller_id: callerId } }, null, attempt.current.id);
      pending.signal.throwIfAborted();
      const result = await api.write('detectSources', {}, intent, { signal: pending.signal }) as Snapshot<Preview>;
      pending.signal.throwIfAborted();
      if (!sameScope(result.scope, scope)) throw new ClientError('INVALID_RESPONSE');
      attempt.current = null;
      showPreview(result.data);
    } catch (error) {
      if (!pending.signal.aborted) setFailure(asClientError(error).code);
    } finally {
      if (active.current === pending) active.current = null;
      if (!pending.signal.aborted) setLoading(false);
    }
  }

  function refresh() { void sources.refetch(); if (selectedId) void detail.refetch(); if (source) void log.refetch(); if (hasDirectory) void reader.refetch(); }
  function page(next: string | undefined) { setCursor(next); select(undefined); edit(undefined); }
  function sourceLabel(row: Source) { return t(labels[row.status] ?? 'status.unknown'); }
  function directoryReaderLabel() {
    if (!reader.fresh) return t('collection.directoryReaderUnknown');
    return reader.data?.data.directory.state === 'blocked'
      ? t('collection.directoryReaderBlocked') : t('collection.directoryReaderReady');
  }
  return <>
    {canPreview && <section className="card">
      <h2>{t('collection.add')}</h2>
      <p>{t('collection.previewHint')}</p>
      <form onSubmit={(event) => { void detect(event); }}>
        <label>{t('collection.type')}
          <select value={type} disabled={loading}
            onChange={(event) => changeType(event.target.value === 'webpage' ? 'webpage' : event.target.value === 'github' ? 'github' : 'rss')}>
            <option value="rss">{t('collection.rss')}</option><option value="webpage">{t('collection.webpage')}</option>
            <option value="github">{t('collection.github')}</option>
          </select>
        </label>
        {type === 'github' ? <>
          <label>{t('collection.repo')}
            <input required maxLength={200} value={github.repo} disabled={loading}
              onChange={(event) => { setGithub({ ...github, repo: event.target.value }); clearPreview(); }} />
          </label>
          <label>{t('collection.branch')}
            <input required maxLength={200} value={github.branch} disabled={loading}
              onChange={(event) => { setGithub({ ...github, branch: event.target.value }); clearPreview(); }} />
          </label>
          <label>{t('collection.path')}
            <input required maxLength={1024} value={github.path} disabled={loading}
              onChange={(event) => { setGithub({ ...github, path: event.target.value }); clearPreview(); }} />
          </label>
          <label>{t('collection.token')}
            <input type="password" maxLength={4096} value={token} disabled={loading} autoComplete="new-password"
              onChange={(event) => setToken(event.target.value)} />
          </label>
          <button type="button" disabled={loading || !token.trim()} onClick={() => { void stageToken(); }}>
            {t('collection.stageToken')}
          </button>
          {credentialRef && <p role="status">{t('collection.tokenStaged')}</p>}
        </> : <label>{t('collection.url')}
          <input type="url" required maxLength={2048} value={target} disabled={loading}
            onChange={(event) => { setTarget(event.target.value); clearPreview(); }} />
        </label>}
        <button className="primary" type="submit" disabled={loading || !target.trim()
          || type === 'github' && (!github.repo.trim() || !github.branch.trim() || !github.path.trim() || !credentialRef)}>
          {t('collection.preview')}
        </button>
      </form>
      {failure && <LocalizedError code={failure} />}
      {preview && <section className="receipt" aria-label={t('collection.preview')}>
        <h3>{t('collection.preview')}</h3>
        <p><code>{preview.target}</code></p>
        <p>{t('settings.validationExpiry')}: {formatDate(locale, preview.expires_at)}</p>
        <p>{t('collection.allowedScope')}</p>
        <ul>{preview.allowed_urls.map((url) => <li key={url}><code>{url}</code></li>)}</ul>
        <p>{t('collection.samples')}: {preview.samples.length}</p>
        {preview.samples.length > 0 && <ul>{preview.samples.map(({ locator, byteLength }) =>
          <li key={locator}><code>{locator}</code> · {byteLength} bytes</li>)}</ul>}
        {preview.duplicate_source_id
          ? <p>{t('collection.duplicate')} <button type="button" onClick={() => { select(preview.duplicate_source_id!); edit(undefined); }}>
            {t('collection.showExisting')}
          </button></p>
          : owner && <>
            <label>{t('collection.frequency')}
              <Frequency value={frequency} onChange={chooseFrequency} />
            </label>
            {type === 'github' && credentialRef ? <SettingsChangeWizard key={[preview.preview_id, credentialRef].join(':')}
              operation="enable_github_source"
              targets={[{ target: preview.target, label: preview.target, device: null, revision: 0,
                input: { credential_ref: credentialRef, repo: github.repo, branch: github.branch, path: github.path } }]}
              entryLabel="collection.enable" onChanged={() => { clearPreview(); page(undefined); refresh(); }} />
              : <SettingsChangeWizard key={[preview.preview_id, frequency].join(':')} operation="enable_http_source"
                targets={[{ target: preview.preview_id, label: preview.target, device: null, revision: 0, input: { frequency } }]}
                entryLabel="collection.enable" onChanged={() => { clearPreview(); page(undefined); refresh(); }} />}
          </>}
      </section>}
    </section>}

    <section className="card">
      <h2>{t('collection.sources')}</h2>
      <button type="button" className="secondary" onClick={refresh}>{t('button.refreshStatus')}</button>
      {sources.error && <LocalizedError code={asClientError(sources.error).code} onRetry={refresh} />}
      {sources.data?.data.items.length === 0 && <p>{t('collection.empty')}</p>}
      {sources.data?.data.items.length ? <ul>{sources.data.data.items.map((row) =>
        <li key={row.source_id}>
          <button type="button" onClick={() => { select(row.source_id); edit(undefined); }} aria-pressed={selectedId === row.source_id}>
            {row.normalized_target}
          </button>{' · '}{t(labels[row.connector_type] ?? 'status.unknown')}{' · '}{sourceLabel(row)}
          {row.connector_type === 'directory' && <> · <span role="status">{directoryReaderLabel()}</span></>}
        </li>)}</ul> : null}
      {!!cursor && <button type="button" onClick={() => page(undefined)}>{t('collection.firstPage')}</button>}
      {sources.data?.data.next_cursor && <button type="button" onClick={() => page(sources.data!.data.next_cursor!)}>{t('collection.nextPage')}</button>}
    </section>

    {detail.error && <LocalizedError code={asClientError(detail.error).code} onRetry={() => { void detail.refetch(); }} />}
    {source && <section className="card" aria-label={t('collection.details')}>
      <h2>{t('collection.details')}</h2>
      <p><code>{source.normalized_target}</code></p>
      <p>{sourceLabel(source)} · {t('collection.frequency')}: {source.frequency}</p>
      {source.connector_type === 'directory' && <p role="status">{directoryReaderLabel()}
        {reader.fresh && reader.data?.data.directory.state === 'blocked' && <> {t('collection.directoryReaderNext')}</>}
      </p>}
      {owner && ['rss', 'webpage'].includes(source.connector_type) && source.status !== 'disconnected' &&
        <div>{(['modify', source.status === 'enabled' ? 'pause' : 'resume', 'disconnect'] as const).map((action) =>
          <button key={action} type="button" onClick={() => { chooseFrequency(source.frequency); edit(action); }}
            aria-pressed={operation === action}>{t(labels[action])}</button>)}</div>}
      {operation && source.status !== 'disconnected' && <>
        {operation === 'modify' && <label>{t('collection.frequency')}<Frequency value={frequency} onChange={chooseFrequency} /></label>}
        <SettingsChangeWizard key={[source.source_id, source.config_revision, operation, frequency].join(':')}
          operation={operation + '_http_source'} targets={[{ target: source.source_id,
            device: null, label: source.normalized_target, revision: source.config_revision,
            input: operation === 'modify' ? { frequency } : null }]} entryLabel={labels[operation]}
          onChanged={() => { edit(undefined); refresh(); }} />
      </>}
      {owner && source.connector_type === 'rss' && source.status === 'enabled' &&
        <RssHistoryPanel key={[source.source_id, source.config_revision].join(':')} sourceId={source.source_id}
          revision={source.config_revision} label={source.normalized_target} />}
      <h3>{t('collection.receipts')}</h3>
      {log.error && <LocalizedError code={asClientError(log.error).code} onRetry={() => { void log.refetch(); }} />}
      {log.data?.data.items.length === 0 && <p>{t('collection.noReceipts')}</p>}
      {!!log.data?.data.items.length && <ul>{log.data.data.items.map((item) => <li key={item.event_id}>
        {t(labels[item.kind] ?? 'status.unknown')} · {formatDate(locale, item.observed_at)}
        {item.accepted && ['first_collection', 'success'].includes(item.kind) && <> · {t('collection.objects')}: {item.object_count}</>}
        {item.reason && <> · <code>{item.reason}</code></>}
      </li>)}</ul>}
    </section>}
    <RssHistoryReceiptFromUrl />
    <ChangeReceipt />
  </>;
}

function Frequency({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useLocale();
  return <select value={value} onChange={(event) => onChange(event.target.value)}>
    {options.map((item) => <option key={item} value={item}>{item === 'poll' ? t('collection.defaultFrequency') : item}</option>)}
  </select>;
}
