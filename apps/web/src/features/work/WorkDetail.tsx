import { Link } from 'react-router';
import { asClientError, useScopedSnapshot } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate } from '../../i18n/locale.js';
import { decisionPath } from '../decisions/paths.js';
import { parseTimeline, parseWork } from './contracts.js';
import { useT15 } from './messages.js';
import { WorkControls } from './WorkControls.js';

const activity = {
  'work.requested': 'workRequested', 'question.bound': 'questionBound', 'answer.verified': 'answerVerified',
  'evidence.ready': 'evidenceReady', 'effect.uncertain': 'effectUncertain', 'work.delivered': 'delivered',
  'outcome.observed': 'outcomeObserved',
} as const;

export function WorkDetail({ workId }: { workId: string }) {
  const t = useT15();
  const { locale } = useLocale();
  const work = useScopedSnapshot('getWork', { id: workId }, parseWork, { projection: true, refetchInterval: 2000 });
  const current = work.data?.data;
  const matches = current?.work_id === workId;
  const timeline = useScopedSnapshot('getWorkTimeline', { id: workId }, parseTimeline, { projection: true, enabled: matches });
  if (work.error) return <LocalizedError code={asClientError(work.error).code} onRetry={() => void work.refetch()} />;
  if (!current) return <p role="status">{t.unknown}</p>;
  if (!matches) return <LocalizedError code="INVALID_RESPONSE" />;
  return <>
    <section className="card" aria-label={t.viewWork}>
      <h2 data-testid="work-id">{current.work_id}</h2>
      <p>{t[current.state]}</p>
      {work.data?.freshness !== 'fresh' && <p role="status">{t.snapshot}</p>}
      <dl>
        <dt>{t.generation}</dt><dd>{current.generation}</dd>
        {current.attempt_ids.length > 0 && <><dt>{t.attempts}</dt><dd>{current.attempt_ids.join(', ')}</dd></>}
        {current.delivery_id && <><dt>{t.delivery}</dt><dd>{current.delivery_id}</dd></>}
      </dl>
      {current.state !== 'delivered' && <WorkControls workId={workId} generation={current.generation}
        refreshWork={() => { void work.refetch(); void timeline.refetch(); }} />}
      {current.question_id && <Link to={decisionPath(current.question_id, current.work_id)}>
        {t.originalQuestion} {current.question_id}
      </Link>}
    </section>
    <section className="card">
      <h2>{t.timeline}</h2>
      {timeline.error && <LocalizedError code={asClientError(timeline.error).code} onRetry={() => void timeline.refetch()} />}
      {timeline.data && (timeline.data.data.items.length > 0 ? <ol>
        {timeline.data.data.items.map((entry) => <li key={entry.event_id}>
          {Object.hasOwn(activity, entry.type) ? t[activity[entry.type as keyof typeof activity]] : t.unknownEvent}
          {' · '}<time dateTime={entry.at}>{formatDate(locale, entry.at)}</time>
        </li>)}
      </ol> : <p>{t.emptyTimeline}</p>)}
    </section>
  </>;
}
