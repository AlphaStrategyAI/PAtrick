import { useEffect, useRef, useState } from 'react';
import { diagnosticsExportRequest, diagnosticsPreviewSchema,
  type DiagnosticsExportRequest, type DiagnosticsPreview } from '../../../../../packages/contracts/src/diagnostics.js';
import { ClientError, type ApiClient } from '../../api/client.js';
import { asClientError, useService } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate } from '../../i18n/locale.js';
import { safeEnvelope } from '../settings/envelope.js';
import { saveDiagnosticsBytes, verifiedDiagnosticsBytes } from './diagnostics-download.js';

type AttachmentWriter = (api: ApiClient, request: DiagnosticsExportRequest, signal: AbortSignal) =>
  Promise<{ response: Response; signal: AbortSignal }>;
type Props = { writeAttachment: AttachmentWriter };

const copy = {
  en: {
    title: 'Diagnostics', detail: 'Preview a redacted summary for this workspace. You can then download it to this device.',
    prepare: 'Preview diagnostics', refresh: 'Create a new preview', preparing: 'Preparing preview…',
    preview: 'Included in the download', download: 'Download diagnostics', downloading: 'Verifying download…',
    started: 'Download started.', changed: 'This preview changed or expired. Create a new preview to download.',
    freshness: 'Projection status', asOf: 'Observed at', expires: 'Preview expires at', work: 'Open work',
    awaiting: 'Awaiting an answer', blocked: 'Blocked or paused', editsPending: 'Pending edits',
    editsFailed: 'Edits requiring attention', vault: 'Vault', feishu: 'Feishu',
  },
  zh: {
    title: '诊断', detail: '先预览当前资料域的脱敏摘要，再选择是否下载到此设备。',
    prepare: '预览诊断', refresh: '重新生成预览', preparing: '正在生成预览…',
    preview: '下载内容', download: '下载诊断', downloading: '正在核验下载内容…',
    started: '已开始下载。', changed: '预览已失效或过期。请重新生成预览后下载。',
    freshness: '投影状态', asOf: '观测时间', expires: '预览到期时间', work: '待完成工作',
    awaiting: '等待答复', blocked: '阻塞或暂停', editsPending: '待处理编辑',
    editsFailed: '需要关注的编辑', vault: 'Vault', feishu: '飞书',
  },
};
const statusText = {
  fresh: ['Current', '当前'], stale: ['Last available snapshot', '上次快照'], syncing: ['Syncing', '同步中'],
  unknown: ['Unknown', '未知'], not_connected: ['Not connected', '未连接'], checking: ['Checking', '正在检查'],
  needs_install: ['Installation required', '需要安装'], needs_permission: ['Permission required', '需要权限'],
  awaiting_confirmation: ['Awaiting confirmation', '待确认'], connected: ['Connected', '已连接'],
  degraded: ['Degraded', '运行受限'], not_configured: ['Not configured', '未配置'],
  needs_binding: ['Pairing required', '需要配对'], needs_test: ['Test required', '需要测试'],
  needs_enable: ['Enablement required', '待启用'], ready: ['Ready', '就绪'], draining: ['Draining', '正在排空'],
  disabled: ['Disabled', '已停用'], requires_reauthorization: ['Reauthorization required', '需要重新授权'],
} as const;

export function DiagnosticsPanel(props: Props) {
  const { scope, callerId, scopeOperations, accessGeneration } = useService();
  if (!scope || !callerId || !scopeOperations.includes('owner')) return null;
  return <ScopedDiagnostics key={JSON.stringify([scope, callerId, accessGeneration])} {...props} />;
}

function ScopedDiagnostics({ writeAttachment }: Props) {
  const { api, scope, callerId } = useService();
  const { locale } = useLocale();
  const strings = copy[locale];
  const [preview, setPreview] = useState<DiagnosticsPreview>();
  const [pending, setPending] = useState<'preview' | 'download'>();
  const [result, setResult] = useState<{ kind: 'started' | 'changed' } | { kind: 'error'; code: string }>();
  const active = useRef<AbortController | null>(null);
  const previewAttempt = useRef<string | null>(null);
  const downloadAttempt = useRef<string | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);

  async function run(kind: 'preview' | 'download') {
    if (!scope || !callerId || active.current || (kind === 'download' && !preview)) return;
    const controller = new AbortController();
    active.current = controller;
    const { signal } = controller;
    const request_scope = { ...scope, caller_id: callerId };
    setPending(kind);
    setResult(undefined);
    try {
      if (kind === 'preview') {
        setPreview(undefined);
        downloadAttempt.current = null;
        previewAttempt.current ??= crypto.randomUUID();
        const body = await safeEnvelope({ request_scope }, null, previewAttempt.current);
        signal.throwIfAborted();
        const response = await api.write('previewDiagnostics', {}, body, { signal });
        signal.throwIfAborted();
        const parsed = diagnosticsPreviewSchema.safeParse(response);
        if (!parsed.success) throw new ClientError('INVALID_RESPONSE');
        previewAttempt.current = null;
        setPreview(parsed.data);
      } else if (preview) {
        downloadAttempt.current ??= crypto.randomUUID();
        const payload = { request_scope, preview_id: preview.preview_id, manifest_hash: preview.manifest_hash, watermark: preview.watermark };
        const body = diagnosticsExportRequest.parse(await safeEnvelope(payload, preview.revision, downloadAttempt.current));
        signal.throwIfAborted();
        const attachment = await writeAttachment(api, body, signal);
        const access = AbortSignal.any([signal, attachment.signal]);
        const bytes = await verifiedDiagnosticsBytes(attachment.response, preview, access);
        access.throwIfAborted();
        saveDiagnosticsBytes(bytes);
        downloadAttempt.current = null;
        setResult({ kind: 'started' });
      }
    } catch (cause) {
      if (signal.aborted) return;
      const error = asClientError(cause);
      if (error.code === 'CONFLICT' || error.code === 'VALIDATION_STALE') {
        previewAttempt.current = null;
        downloadAttempt.current = null;
        setPreview(undefined);
        setResult({ kind: 'changed' });
      } else setResult({ kind: 'error', code: error.code });
    } finally {
      if (active.current === controller) active.current = null;
      if (!signal.aborted) setPending(undefined);
    }
  }

  const projection = preview?.report.projection;
  const status = (value: keyof typeof statusText) => statusText[value][locale === 'zh' ? 1 : 0];
  const countFormat = new Intl.NumberFormat(locale);
  const number = (value: number | undefined) => value === undefined ? status('unknown') : countFormat.format(value);
  return <section className="card" aria-label={strings.title}>
    <h2>{strings.title}</h2>
    <p>{strings.detail}</p>
    <button type="button" className="secondary" disabled={!!pending} onClick={() => { void run('preview'); }}>
      {pending === 'preview' ? strings.preparing : preview || result?.kind === 'changed' ? strings.refresh : strings.prepare}
    </button>
    {preview && projection && <section aria-label={strings.preview}>
      <h3>{strings.preview}</h3>
      <dl>
        <dt>{strings.freshness}</dt><dd>{status(projection.freshness)}</dd>
        <dt>{strings.asOf}</dt><dd>{projection.as_of ? <time dateTime={projection.as_of}>{formatDate(locale, projection.as_of)}</time> : status('unknown')}</dd>
        <dt>{strings.work}</dt><dd>{number(projection.work?.open)}</dd>
        <dt>{strings.awaiting}</dt><dd>{number(projection.work?.awaiting_answer)}</dd>
        <dt>{strings.blocked}</dt><dd>{number(projection.work?.blocked)}</dd>
        <dt>{strings.vault}</dt><dd>{status(projection.connections.vault)}</dd>
        <dt>{strings.feishu}</dt><dd>{status(projection.connections.feishu)}</dd>
        <dt>{strings.editsPending}</dt><dd>{number(projection.edits?.pending)}</dd>
        <dt>{strings.editsFailed}</dt><dd>{number(projection.edits?.failed)}</dd>
        <dt>{strings.expires}</dt><dd><time dateTime={preview.expires_at}>{formatDate(locale, preview.expires_at)}</time></dd>
      </dl>
      <button type="button" className="primary" disabled={!!pending} onClick={() => { void run('download'); }}>
        {pending === 'download' ? strings.downloading : strings.download}
      </button>
    </section>}
    {result?.kind === 'changed' && <p role="alert">{strings.changed}</p>}
    {result?.kind === 'started' && <p role="status">{strings.started}</p>}
    {result?.kind === 'error' && <LocalizedError code={result.code} />}
  </section>;
}
