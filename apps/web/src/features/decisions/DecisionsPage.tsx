import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { asClientError, useScopedSnapshot } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useCommands } from '../work/CommandSession.js';
import { parseQuestion, parseWorkList, safeResource } from '../work/contracts.js';
import { useT15 } from '../work/messages.js';
import { DecisionCard } from './DecisionCard.js';

type CardRef = { questionId: string; workId: string };

export function DecisionsPage() {
  const [params] = useSearchParams();
  const t = useT15();
  const commands = useCommands();
  const list = useScopedSnapshot('listWork', { state: 'awaiting_answer' }, parseWorkList, { projection: true, refetchInterval: 10_000 });
  const [retained, setRetained] = useState<CardRef[]>([]);
  const selected = safeResource(params.get('question'));
  const selectedWork = safeResource(params.get('work'));
  const known = new Map<string, CardRef>();
  for (const { work_id, question_id } of list.data?.data.items ?? []) {
    if (question_id) known.set(question_id, { questionId: question_id, workId: work_id });
  }
  for (const reference of retained) known.set(reference.questionId, reference);
  for (const { intent } of Object.values(commands.attempts)) {
    if (intent.operation !== 'submitAnswer' || typeof intent.command.payload !== 'object' || !intent.command.payload) continue;
    const payload = intent.command.payload as { question_id?: string; work_id?: string };
    const questionId = safeResource(payload.question_id);
    const workId = safeResource(payload.work_id);
    if (questionId && workId) known.set(questionId, { questionId, workId });
  }
  if (selected && selectedWork && !known.has(selected)) known.set(selected, { questionId: selected, workId: selectedWork });
  const cards = [...known.values()].sort((a, b) => Number(b.questionId === selected) - Number(a.questionId === selected));
  return <>
    {list.error && <LocalizedError code={asClientError(list.error).code} onRetry={() => void list.refetch()} />}
    {list.isPending && <p role="status">{t.unknown}</p>}
    {list.data && list.data.freshness !== 'fresh' && <p role="status">{t.snapshot}</p>}
    {list.data?.freshness === 'fresh' && !cards.length && <p>{t.noDecisions}</p>}
    {cards.map(({ questionId, workId }) => <BoundDecision key={questionId} questionId={questionId} workId={workId}
      retain={() => setRetained((prior) => prior.some((reference) => reference.questionId === questionId)
        ? prior : [...prior, { questionId, workId }])} />)}
  </>;
}

function BoundDecision({ questionId, workId, retain }: CardRef & { retain: () => void }) {
  const t = useT15();
  const question = useScopedSnapshot('getQuestion', { id: questionId }, parseQuestion, { refetchInterval: 8_000 });
  if (question.error) return <LocalizedError code={asClientError(question.error).code} onRetry={() => void question.refetch()} />;
  const card = question.data?.data;
  if (!card) return <p role="status">{t.unknown}</p>;
  if (card.question_id !== questionId || card.work_id !== workId) return <LocalizedError code="INVALID_RESPONSE" />;
  return <DecisionCard card={card} retain={retain} refresh={() => void question.refetch()}
    stale={question.data?.freshness !== 'fresh'} />;
}
