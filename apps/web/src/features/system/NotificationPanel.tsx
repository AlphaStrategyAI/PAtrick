import { useEffect, useRef, useState } from 'react';
import { snapshotEnvelope, type Snapshot } from '@patrick/contracts/envelope';
import { notificationPreviewSchema, notificationSummarySchema } from '@patrick/contracts/resources';
import { ClientError } from '../../api/client.js';
import { sameScope } from '../../api/events.js';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate } from '../../i18n/locale.js';
import { safeEnvelope } from '../settings/envelope.js';

const previewSnapshot = snapshotEnvelope(notificationPreviewSchema);
type Preview = ReturnType<typeof notificationPreviewSchema.parse>;
const statuses = ['pending', 'quiet', 'digest', 'checking', 'retrying', 'blocked'] as const;
const kinds = ['decision', 'blocker', 'delivered', 'progress'] as const;
const copy = {
  en: {
    title: 'Notifications', detail: 'Review pending notices and the digest for this workspace.',
    loading: 'Loading notifications…', empty: 'No pending notifications.', refresh: 'Refresh notifications',
    preview: 'Preview digest', preparing: 'Preparing digest…', previewTitle: 'Digest preview',
    emptyPreview: 'There are no digest items.', local: 'This preview is local and sends no messages.', asOf: 'As of',
    statuses: { pending: 'Pending', quiet: 'Held by quiet hours', digest: 'In the digest', checking: 'Sending or verifying delivery',
      retrying: 'Waiting to retry', blocked: 'Delivery blocked' },
    kinds: { decision: 'Decisions', blocker: 'Blockers', delivered: 'Delivered work', progress: 'Progress updates' },
  },
  zh: {
    title: '通知', detail: '查看当前资料域的待处理通知和摘要。',
    loading: '正在读取通知…', empty: '暂无待处理通知。', refresh: '刷新通知',
    preview: '预览通知摘要', preparing: '正在生成摘要…', previewTitle: '通知摘要预览',
    emptyPreview: '摘要暂无内容。', local: '仅在本机预览，不会发送消息。', asOf: '截至',
    statuses: { pending: '待处理', quiet: '免打扰期间暂缓', digest: '已归入摘要', checking: '正在发送或核验投递',
      retrying: '等待重试', blocked: '投递受阻' },
    kinds: { decision: '待决事项', blocker: '阻塞事项', delivered: '已交付工作', progress: '进展更新' },
  },
};

export function NotificationPanel() {
  const { scope, callerId, scopeOperations, accessGeneration } = useService();
  if (!scope || !callerId || !scopeOperations.includes('owner')) return null;
  return <ScopedNotifications key={JSON.stringify([scope, callerId, accessGeneration])} />;
}

function ScopedNotifications() {
  const { api, scope, callerId } = useService();
  const { locale } = useLocale();
  const strings = copy[locale];
  const counts = useScopedSnapshot('getNotificationSummary', {}, notificationSummarySchema.parse);
  const [preview, setPreview] = useState<Snapshot<Preview>>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);

  async function showPreview() {
    if (!scope || !callerId || request.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    request.current = controller;
    setPending(true);
    setPreview(undefined);
    setError(undefined);
    try {
      const body = await safeEnvelope({ request_scope: { ...scope, caller_id: callerId } }, null);
      signal.throwIfAborted();
      const response = await api.write('previewNotification', {}, body, { signal });
      signal.throwIfAborted();
      const checked = previewSnapshot.safeParse(response);
      if (!checked.success) throw new ClientError('INVALID_RESPONSE');
      if (!sameScope(scope, checked.data.scope)) {
        api.revoke();
        throw new ClientError('FORBIDDEN', 403);
      }
      setPreview(checked.data);
    } catch (cause) {
      if (!signal.aborted) setError(asClientError(cause).code);
    } finally {
      if (request.current === controller) request.current = null;
      if (!signal.aborted) setPending(false);
    }
  }

  const summary = counts.error ? undefined : counts.data?.data;
  const count = new Intl.NumberFormat(locale);
  const hasItems = summary && statuses.some((status) => summary[status] > 0);
  const foundDigest = preview && kinds.some((kind) => preview.data[kind] > 0);
  return <section className="card" aria-label={strings.title}>
    <h2>{strings.title}</h2>
    <p>{strings.detail}</p>
    {counts.isPending && <p role="status">{strings.loading}</p>}
    {counts.error && <LocalizedError code={asClientError(counts.error).code} onRetry={() => { void counts.refetch(); }} />}
    {summary && (hasItems ? <dl>
      {statuses.map((status) => <div key={status}><dt>{strings.statuses[status]}</dt><dd>{count.format(summary[status])}</dd></div>)}
    </dl> : <p>{strings.empty}</p>)}
    <button type="button" className="secondary" disabled={counts.isFetching || pending} onClick={() => {
      setPreview(undefined);
      setError(undefined);
      void counts.refetch();
    }}>{strings.refresh}</button>
    <button type="button" className="secondary" disabled={pending} onClick={() => { void showPreview(); }}>
      {pending ? strings.preparing : strings.preview}
    </button>
    {error && <LocalizedError code={error} />}
    {preview && <section aria-label={strings.previewTitle} aria-live="polite">
      <h3>{strings.previewTitle}</h3>
      <p>{strings.local}</p>
      <p>{strings.asOf} <time dateTime={preview.as_of}>{formatDate(locale, preview.as_of)}</time></p>
      {foundDigest ? <dl>
        {kinds.filter((kind) => preview.data[kind] > 0).map((kind) =>
          <div key={kind}><dt>{strings.kinds[kind]}</dt><dd>{count.format(preview.data[kind])}</dd></div>)}
      </dl> : <p>{strings.emptyPreview}</p>}
    </section>}
  </section>;
}
