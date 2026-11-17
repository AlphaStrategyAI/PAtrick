import { useState } from 'react';
import { Link } from 'react-router';
import { asClientError, useScopedSnapshot } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useT15 } from './messages.js';
import { parseWorkList } from './contracts.js';
import { decisionPath } from '../decisions/paths.js';

const filters = ['open', 'awaiting_answer', 'blocked', 'delivered', 'all'] as const;
type Filter = typeof filters[number];

export function WorkPage() {
  const t = useT15();
  const [filter, setFilter] = useState<Filter>('open');
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const work = useScopedSnapshot('listWork', { state: filter, cursor }, parseWorkList, { projection: !cursor });
  const snapshot = work.data;
  return <section aria-label={t.open}>
    <label>{t.filter}{' '}
      <select value={filter} onChange={(event) => { setFilter(event.target.value as Filter); setCursors([]); }}>
        {filters.map((value) => <option key={value} value={value}>{t[value]}</option>)}
      </select>
    </label>
    {work.isPending && <p role="status">{t.unknown}</p>}
    {work.error && <LocalizedError code={asClientError(work.error).code}
      onRetry={() => { if (cursor) setCursors([]); else void work.refetch(); }} />}
    {snapshot && <>
      {snapshot.freshness !== 'fresh' && <p role="status">{snapshot.freshness === 'unknown' ? t.unknown : t.snapshot}</p>}
      {snapshot.data.items.length === 0 && snapshot.freshness === 'fresh' && <p>{t.emptyWork}</p>}
      {snapshot.data.items.map((item) => <article key={item.work_id} className="card">
        <h2><Link to={'/work/' + encodeURIComponent(item.work_id)}>{item.work_id}</Link></h2>
        <p>{t[item.state]}</p>
        {item.question_id && item.state === 'awaiting_answer' &&
          <Link to={decisionPath(item.question_id, item.work_id)}>{t.originalQuestion} {item.question_id}</Link>}
      </article>)}
      <div className="actions">
        {cursor && <button type="button" onClick={() => setCursors((prior) => prior.slice(0, -1))}>{t.newer}</button>}
        {snapshot.data.next_cursor && <button type="button" onClick={() => {
          const next = snapshot.data.next_cursor;
          if (next) setCursors((prior) => [...prior, next]);
        }}>{t.older}</button>}
      </div>
    </>}
  </section>;
}
