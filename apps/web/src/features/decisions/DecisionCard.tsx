import { useId, useState } from 'react';
import { Link } from 'react-router';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { LocalizedError, SafeMarkdown } from '../../components/shared.js';
import { browserDrafts } from '../../state/browserDrafts.js';
import type { DraftKey } from '../../state/drafts.js';
import { useCommands } from '../work/CommandSession.js';
import { parseAnswerReceipt, receiptResource } from '../work/contracts.js';
import type { Question } from '../work/contracts.js';
import { useT15 } from '../work/messages.js';
import { decisionPath } from './paths.js';

export type CardAnswer = { kind: 'option'; option_id: string } | { kind: 'custom'; raw_text: string };

export function answerPayload(card: Question, answer: CardAnswer) {
  const { work_id, generation, question_id, question_version, proposal_revision, options_hash } = card;
  return { work_id, generation, question_id, question_version, proposal_revision, options_hash, answer };
}

type LocalDraft = { binding: string; text: string; selected?: { kind: 'custom' } | { kind: 'option'; id: string } };

export function DecisionCard({ card, refresh, retain }: { card: Question; refresh: () => void; retain: () => void }) {
  const t = useT15();
  const { scope } = useService();
  const commands = useCommands();
  const group = useId();
  const draftKey: DraftKey | null = scope ? {
    account: scope.account_id, domain: scope.data_domain, conversation: card.question_id,
    resource: JSON.stringify([card.work_id, card.generation, card.proposal_revision, card.options_hash]),
    version: card.question_version, kind: 'decision',
  } : null;
  const binding = JSON.stringify([card.generation, card.question_version, card.proposal_revision, card.options_hash]);
  const initial = (): LocalDraft => ({ binding, text: (draftKey && browserDrafts.read(draftKey)) ?? '' });
  const [draft, setDraft] = useState<LocalDraft>(initial);
  const [oldText, setOldText] = useState('');
  const [unsaved, setUnsaved] = useState(false);
  const changed = draft.binding !== binding;
  const current = changed ? initial() : draft;
  const held = changed ? draft.text || oldText : oldText;
  const commandKey = JSON.stringify(['decision', card.work_id, card.question_id, binding]);
  const inProgress = Object.entries(commands.attempts).find(([, { intent, phase }]) =>
    intent.operation === 'submitAnswer' && intent.parameters.id === card.question_id && (phase === 'retry' || phase === 'sending'));
  const originalKey = commands.attempts[commandKey] ? commandKey : inProgress?.[0];
  const attempt = originalKey ? commands.attempts[originalKey] : undefined;
  const receiptId = attempt?.phase === 'received' ? receiptResource(attempt.receiptUrl, '/api/v1/answers/') : undefined;
  const receipt = useScopedSnapshot('getAnswerReceipt', { receiptId }, parseAnswerReceipt, {
    enabled: !!receiptId, refetchInterval: 3000,
  });
  const observed = receipt.data?.data;
  const result = observed?.receipt_id === receiptId && observed?.question_id === card.question_id ? observed : undefined;
  const expired = card.expires_at !== null && (!(Date.parse(card.expires_at) > Date.now()));
  const open = card.status === 'open' && !expired;
  const resolved = result && ['deferred', 'clarification_required', 'rejected', 'stale'].includes(result.validity);
  const frozen = !!attempt && attempt.phase !== 'declined';
  const acceptOption = current.selected?.kind === 'option' ? current.selected.id : undefined;
  const answer: CardAnswer | undefined = current.selected?.kind === 'custom' && card.custom_allowed && current.text.trim()
    ? { kind: 'custom', raw_text: current.text }
    : acceptOption && card.options.some((option) => option.option_id === acceptOption)
      ? { kind: 'option', option_id: acceptOption } : undefined;
  const successor = result?.successor_question_id ?? card.successor_question_id;

  function choose(next: LocalDraft['selected'], value = current.text, typing = false) {
    if (changed && draft.text) setOldText(draft.text);
    setDraft({ ...current, text: value, selected: next });
    if (typing && draftKey) {
      if (value) retain();
      setUnsaved(!browserDrafts.write(draftKey, value));
    }
  }
  return <article className="card t15-decision" data-testid={'decision-' + card.question_id}>
    <h2>{t.decision} {card.question_id}</h2>
    <Link to={'/work/' + encodeURIComponent(card.work_id)}>{t.viewWork} {card.work_id}</Link>
    {!open && <p role="status">{expired ? t.stale : t.closeQuestion}</p>}
    {open && !card.custom_allowed && card.options.length === 0 && <p role="status">{t.noChoices}</p>}
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!scope || !open || !answer || frozen) return;
      commands.start(commandKey, { operation: 'submitAnswer', parameters: { id: card.question_id },
        command: { expected_revision: card.proposal_revision, payload: answerPayload(card, answer) } });
    }}>
      <fieldset disabled={!open || frozen}>
        <legend>{t.answerGroup}</legend>
        {card.options.map((option) => <label className="check-control" key={option.option_id}>
          <input type="radio" name={group} value={option.option_id} checked={acceptOption === option.option_id}
            onChange={() => choose({ kind: 'option', id: option.option_id })} /> {option.label}
        </label>)}
        {card.custom_allowed && <>
          <label className="check-control">
            <input type="radio" name={group} value={group + '-custom-option'} checked={current.selected?.kind === 'custom'}
              onChange={() => choose({ kind: 'custom' })} /> {t.custom}
          </label>
          <textarea aria-label={t.custom} rows={4} value={current.text}
            onChange={(event) => choose({ kind: 'custom' }, event.target.value, true)} />
        </>}
        {open && <button type="submit" className="primary" disabled={!answer || frozen}>{t.submit}</button>}
      </fieldset>
    </form>
    {held && <label>{t.staleDraft}<textarea rows={3} readOnly value={held} /></label>}
    {unsaved && <p role="status">{t.draftUnsaved}</p>}
    {attempt?.phase === 'sending' && <p role="status">{t.received}</p>}
    {(attempt?.phase === 'retry' || attempt?.phase === 'declined') && <>
      <LocalizedError code={attempt.error.code} />
      {attempt.phase === 'retry' && originalKey && <button type="button" onClick={() => commands.retry(originalKey)}>{t.retryOriginal}</button>}
    </>}
    {attempt?.phase === 'received' && <section aria-label={t.receipt} data-testid={'answer-receipt-' + card.question_id}>
      {result ? <>
        <p role="status">{t[result.validity]}</p>
        {result.difference && <SafeMarkdown>{result.difference}</SafeMarkdown>}
        {result.missing.length > 0 && <ul>{result.missing.map((item, index) => <li key={index}>{item}</li>)}</ul>}
        {resolved && open && originalKey && !successor && <button type="button" onClick={() => {
          commands.clear(originalKey); choose(undefined);
        }}>{t.showDecision}</button>}
      </> : <p role="status">{!receiptId || observed ? t.unexpectedReceipt : t.received}</p>}
      {receipt.error && <LocalizedError code={asClientError(receipt.error).code} />}
      {receiptId && !result && <button type="button" onClick={() => void receipt.refetch()}>{t.readReceipt}</button>}
    </section>}
    {successor && <Link to={decisionPath(successor, card.work_id)}>{t.viewSuccessor}</Link>}
    {!frozen && <button type="button" onClick={refresh}>{t.showDecision}</button>}
  </article>;
}
