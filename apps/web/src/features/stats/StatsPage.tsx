import { useState } from 'react';
import { Link } from 'react-router';
import { statsSnapshotSchema } from '../../../../../packages/contracts/src/stats.js';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import './stats.css';

const copy = {
  en: {
    restricted: 'Statistics are unavailable for this data scope.',
    range: 'Statistics period', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time',
    activity: 'Activity in this period', stock: 'Current holdings', outstanding: 'Work that needs attention',
    delivered: 'Completed work', owner: 'Owner decisions', auto: 'Automatic decisions',
    standards: 'Active standards', knowledge: 'Knowledge entries', delegations: 'Delegation types',
    live: 'Currently active types', open: 'Ongoing', waiting: 'Awaiting decision', blocked: 'Blocked',
    latest: 'Snapshot', waitingData: 'No verified statistics snapshot yet.',
    stale: 'Showing the last verified snapshot while updates are unavailable.',
    basis: 'How these figures are counted', available: 'Verified since', through: 'through',
    unverified: 'The activity history for this period has not been fully verified.',
    unavailable: 'No verified coverage',
    definition: 'Counted once per verified delivery, authoritative answer, and committed automatic decision. Holdings count active standards, available canonical knowledge, and established delegation types. Suggestions, tests, drafts, and retries are excluded.',
  },
  zh: {
    restricted: '当前资料域无法访问统计。',
    range: '统计周期', '7d': '近 7 天', '30d': '近 30 天', all: '全部时间',
    activity: '这段时间完成了什么', stock: '现在积累了什么', outstanding: '需要关注的任务',
    delivered: '完成任务', owner: '主人决策', auto: '自动决策',
    standards: '生效标准', knowledge: '知识条目', delegations: '委托种类',
    live: '当前生效类型', open: '正在进行', waiting: '等待决策', blocked: '受阻',
    latest: '快照时间', waitingData: '尚未取得已核验的统计快照。',
    stale: '暂时无法更新，保留上次已核验的快照。',
    basis: '统计口径', available: '已核验自', through: '至',
    unverified: '这一周期的活动记录尚未核验完整。',
    unavailable: '暂无已核验覆盖',
    definition: '交付核验、权威答复和已提交的自动决策各按唯一事实计数。存量包含生效标准、去重后的可用知识和已建立的委托类型。建议、测试、草稿和重试不计入。',
  },
} as const;
const periods = ['7d', '30d', 'all'] as const;
type Period = typeof periods[number];

export function StatsPage() {
  const { scopeOperations } = useService();
  const { locale } = useLocale();
  if (!scopeOperations.includes('owner') && !['stats.read', 'work.read'].every((permission) => scopeOperations.includes(permission))) {
    return <p role="status">{copy[locale].restricted}</p>;
  }
  return <AuthorizedStatsPage />;
}

function AuthorizedStatsPage() {
  const { locale } = useLocale();
  const text = copy[locale];
  const [period, setPeriod] = useState<Period>('7d');
  // Presentation locale never changes the query timezone or period.
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const query = useScopedSnapshot('getStats', { period, timezone }, statsSnapshotSchema.parse,
    { projection: true, refetchInterval: 15_000 });
  const snapshot = query.data;
  const data = snapshot?.data;
  const knownSnapshot = snapshot && data?.work.open != null;
  const coverageNames = { delivered_work: text.delivered, owner_decision: text.owner, automatic_decision: text.auto };
  const number = (value?: number | null) => value == null ? '—' : new Intl.NumberFormat(locale).format(value);
  const formatTime = (value: string) => new Intl.DateTimeFormat(locale, { timeZone: timezone,
    dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  return <div className="stats-view">
    <div role="group" aria-label={text.range} className="actions stats-periods">
      {periods.map((value) => <button type="button" key={value} aria-pressed={period === value}
        onClick={() => setPeriod(value)}>{text[value]}</button>)}
    </div>
    {query.error && <LocalizedError code={asClientError(query.error).code} onRetry={() => { void query.refetch(); }} />}
    <p role="status">
      {knownSnapshot ? (
        <>{text.latest}: <time dateTime={snapshot.as_of}>{formatTime(snapshot.as_of)}</time> ({timezone}).
          {snapshot.freshness !== 'fresh' || query.error ? ' ' + text.stale : null}
          {data.coverage.status !== 'complete' ? ' ' + text.unverified : null}</>
      ) : text.waitingData}
    </p>
    <section aria-labelledby="stats-activity"><h2 id="stats-activity">{text.activity}</h2>
      <div className="stats-grid">
        <Metric label={text.delivered} value={number(data?.activity.delivered_work)} />
        <Metric label={text.owner} value={number(data?.activity.owner_decisions)} />
        <Metric label={text.auto} value={number(data?.activity.automatic_decisions)} />
      </div>
    </section>
    <section aria-labelledby="stats-stock"><h2 id="stats-stock">{text.stock}</h2>
      <div className="stats-grid">
        <Metric label={text.standards} value={number(data?.stock.active_standards)} to="/standards" />
        <Metric label={text.knowledge} value={number(data?.stock.knowledge_entries)} to="/knowledge" />
        <Metric label={text.delegations} value={number(data?.stock.delegation_types)} to="/delegations"
          note={text.live + ': ' + number(data?.stock.active_delegation_types)} />
      </div>
    </section>
    <nav aria-label={text.outstanding} className="actions stats-work">
      <Link to="/work?state=open">{text.open}: {number(data?.work.open)}</Link>
      <Link to="/work?state=awaiting_answer">{text.waiting}: {number(data?.work.awaiting_answer)}</Link>
      <Link to="/work?state=blocked">{text.blocked}: {number(data?.work.blocked)}</Link>
    </nav>
    <details><summary>{text.basis}</summary><p>{text.definition}</p>
      {data && <ul>{Object.entries(data.coverage.by_activity).map(([key, metric]) => (
        <li key={key}>{coverageNames[key as keyof typeof coverageNames]}: {metric.available_since && metric.through
          ? <>{text.available} <time dateTime={metric.available_since}>{formatTime(metric.available_since)}</time> {text.through}{' '}
              <time dateTime={metric.through}>{formatTime(metric.through)}</time></>
          : text.unavailable}</li>
      ))}</ul>}
    </details>
  </div>;
}

function Metric({ label, value, to, note }: { label: string; value: string; to?: string; note?: string }) {
  return <article className="card stats-metric"><h3>{to ? <Link to={to}>{label}</Link> : label}</h3>
    <p className="stats-count">{value}</p>{note && <p>{note}</p>}
  </article>;
}
