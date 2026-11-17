import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import type { Snapshot } from '@patrick/contracts/envelope';
import { rssHistoryViewSchema } from '@patrick/contracts/resources';
import { ClientError } from '../../api/client.js';
import { sameScope } from '../../api/events.js';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate } from '../../i18n/locale.js';
import { SettingsChangeWizard } from '../settings/SettingsChangeWizard.js';
import { safeEnvelope } from '../settings/envelope.js';

type History = ReturnType<typeof rssHistoryViewSchema.parse>;
const copy = {
  en: { heading: 'Import RSS history', explanation: 'Choose the exact UTC range and limits. Preview uses only the last verified feed response already stored. It does not read linked pages.',
    from: 'From (UTC, inclusive)', until: 'Until (UTC, exclusive)', items: 'Maximum items', bytes: 'Maximum bytes',
    target: 'Approved address', response: 'Stored response address', selected: 'Items selected', total: 'Total bytes including evidence',
    evidenceBytes: 'Bytes of stored evidence', selectedBytes: 'Bytes of selected items', eligible: 'Items in range', eligibleBytes: 'Bytes of items in range',
    outside: 'Outside range', omitted: 'Excluded by limits', unknown: 'Omitted without a verified publication date', requests: 'Additional network requests',
    plan: 'Plan digest', preview: 'Preview history', imported: 'Imported items', existing: 'Existing items kept',
    receipt: 'Import receipt', stale: 'This preview is no longer current. Review a new plan before importing.' },
  zh: { heading: '导入 RSS 历史', explanation: '选择精确的 UTC 时间范围和上限。预览只使用已经保存的最近一次核验响应，不会读取链接页面。',
    from: '开始（UTC，含）', until: '结束（UTC，不含）', items: '对象数上限', bytes: '字节数上限',
    target: '获准地址', response: '已保存响应的地址', selected: '待导入对象', total: '总字节数（含证据）',
    evidenceBytes: '已保存证据的字节数', selectedBytes: '选中对象的字节数', eligible: '范围内对象', eligibleBytes: '范围内对象的字节数',
    outside: '范围外对象', omitted: '因超出预算省略', unknown: '因发布日期无法核实省略', requests: '新增联网次数',
    plan: '计划摘要', preview: '预览历史', imported: '已导入对象', existing: '保留已有对象',
    receipt: '导入回执', stale: '这份预览已失效，请重新预览后再导入。' },
} as const;

export function RssHistoryPanel({ sourceId, revision, label }: { sourceId: string; revision: number; label: string }) {
  const { api, scope, callerId } = useService();
  const { locale, t } = useLocale();
  const text = copy[locale];
  const [plan, setPlan] = useState<History>();
  const [readBack, setReadBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | undefined>(undefined);
  const pending = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  useEffect(() => () => active.current?.abort(), []);
  const view = plan;

  function invalidate() { setPlan(undefined); setReadBack(false); setError(undefined); pending.current = undefined; }
  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!scope || !callerId || active.current) return;
    setError(undefined);
    setPlan(undefined);
    setReadBack(false);
    const form = new FormData(event.currentTarget);
    const from = new Date(String(form.get('from')) + 'Z');
    const until = new Date(String(form.get('until')) + 'Z');
    if (!Number.isFinite(+from) || !Number.isFinite(+until) || from >= until) { setError('INVALID_REQUEST'); return; }
    const payload = { from: from.toISOString(), until: until.toISOString(), max_objects: Number(form.get('items')),
      max_bytes: Number(form.get('bytes')), request_scope: { ...scope, caller_id: callerId } };
    const fingerprint = JSON.stringify(payload);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: crypto.randomUUID() };
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const envelope = await safeEnvelope(payload, revision, pending.current.id);
      const result = await api.write('previewRssHistory', { id: sourceId }, envelope, { signal: controller.signal }) as Snapshot<History>;
      controller.signal.throwIfAborted();
      if (!sameScope(result.scope, scope) || result.data.source_id !== sourceId || result.data.config_revision !== revision) {
        throw new ClientError('INVALID_RESPONSE');
      }
      pending.current = undefined;
      setPlan(result.data);
    } catch (cause) {
      if (!controller.signal.aborted) setError(asClientError(cause).code);
    } finally {
      if (active.current === controller) active.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <details>
    <summary>{text.heading}</summary>
    <p>{text.explanation}</p>
    <form onSubmit={(event) => { void preview(event); }} onChange={invalidate}>
      <label>{text.from}<input type="datetime-local" step="60" name="from" required disabled={busy} /></label>
      <label>{text.until}<input type="datetime-local" step="60" name="until" required disabled={busy} /></label>
      <label>{text.items}<input type="number" min="1" max="500" defaultValue="50" name="items" required disabled={busy} /></label>
      <label>{text.bytes}<input type="number" min="1" max={4 * 1024 * 1024} defaultValue={1024 * 1024} name="bytes" required disabled={busy} /></label>
      <button className="secondary" type="submit" disabled={busy}>{text.preview}</button>
    </form>
    {error && <LocalizedError code={error} />}
    {view && <div className="receipt">
      <p>{text.target}: <code>{view.target}</code></p>
      <p>{text.response}: <code>{view.response_url}</code></p>
      <p><time>{view.range.from}</time> – <time>{view.range.until}</time></p>
      <p>{text.selected}: {view.cost.selected_objects} / {view.budget.max_objects}</p>
      <p>{text.total}: {view.cost.total_bytes} / {view.budget.max_bytes} ({text.evidenceBytes}: {view.cost.evidence_bytes};
        {' '}{text.selectedBytes}: {view.cost.selected_bytes})</p>
      <p>{text.eligible}: {view.cost.eligible_objects} · {text.eligibleBytes}: {view.cost.eligible_bytes} · {text.outside}: {view.cost.outside_range_objects}</p>
      <p>{text.omitted}: {view.cost.omitted_objects} · {text.unknown}: {view.cost.unknown_date_objects}</p>
      <p>{text.requests}: {view.cost.additional_network_requests}</p>
      <p>{text.plan}: <code>{view.plan_hash}</code></p>
      <p>{t('settings.validationExpiry')}: {formatDate(locale, view.expires_at)}</p>
      {!readBack && view.state === 'pending' && view.cost.selected_objects > 0 && <SettingsChangeWizard key={view.plan_id}
        operation="import_rss_history" targets={[{ target: view.plan_id, revision, label, device: null,
          input: { plan_hash: view.plan_hash } }]} entryLabel="collection.historyImport" receiptQuery={{ historySource: sourceId, historyPlan: view.plan_id }} onChanged={() => setReadBack(true)} />}
      {(view.state === 'expired' || view.state === 'stale') && <p role="status">{text.stale}</p>}
    </div>}
  </details>;
}

export function RssHistoryReceiptFromUrl() {
  const [query] = useSearchParams();
  const { locale } = useLocale();
  const text = copy[locale];
  const { scopeOperations } = useService();
  const id = query.get('historySource') ?? '';
  const planId = query.get('historyPlan') ?? '';
  const enabled = scopeOperations.includes('owner') && /^src_[a-f0-9]{24}$/u.test(id) && /^history_[a-f0-9]{64}$/u.test(planId);
  const report = useScopedSnapshot('getRssHistory', { id, planId }, rssHistoryViewSchema.parse, { enabled });
  if (!enabled) return null;
  const receipt = report.data?.data.receipt;
  return <section className="receipt" aria-label={text.receipt}>
    {report.error && <LocalizedError code={asClientError(report.error).code} onRetry={() => { void report.refetch(); }} />}
    {receipt && <p role="status">{text.receipt}: <code>{receipt.receipt_id}</code> · {text.imported}: {receipt.imported_objects}
      {' · '}{text.existing}: {receipt.existing_objects}</p>}
  </section>;
}
