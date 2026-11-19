import { useId, useState } from 'react';
import { Dialog, LocalizedError, SafeMarkdown } from '../../components/shared.js';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { browserDrafts } from '../../state/browserDrafts.js';
import type { DraftKey } from '../../state/drafts.js';
import { useCommands } from '../work/CommandSession.js';
import { parseConsultation, parseMessages, parseWork, receiptResource, safeResource } from '../work/contracts.js';
import { useT15 } from '../work/messages.js';

const createKey = 'consultation.create';

export function ConsultationPanel({ sourceRoute, returnTo, demoDraft }: {
  sourceRoute: string;
  returnTo: () => void;
  demoDraft?: DraftKey;
}) {
  const { t } = useLocale();
  const { scope } = useService();
  return <Dialog title={t('consult.title')} className="t15-consultation" onClose={returnTo}>
    {demoDraft ? <DemoConsultation draftKey={demoDraft} />
      : scope ? <LiveConsultation sourceRoute={sourceRoute} />
        : <p>{t('session.required')}</p>}
  </Dialog>;
}

function DemoConsultation({ draftKey }: { draftKey: DraftKey }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(() => browserDrafts.read(draftKey) ?? '');
  const [unsaved, setUnsaved] = useState(false);
  function change(value: string) {
    setDraft(value);
    setUnsaved(!browserDrafts.write(draftKey, value));
  }
  return <>
    <p>{t('consult.sample')}</p>
    <textarea aria-label={t('aria.question')} rows={5} value={draft} onChange={(event) => change(event.target.value)} />
    {unsaved && <p role="status">{t('consult.unsaved')}</p>}
    <footer className="actions"><button type="button" disabled={!draft} onClick={() => change('')}>{t('button.clearDraft')}</button></footer>
  </>;
}

function LiveConsultation({ sourceRoute }: { sourceRoute: string }) {
  const { t: shared } = useLocale();
  const t = useT15();
  const { scope } = useService();
  const commands = useCommands();
  const label = useId();
  const workId = workFromRoute(sourceRoute);
  const work = useScopedSnapshot('getWork', { id: workId }, parseWork, { enabled: !!workId, projection: true });
  const approved = !!workId && work.data?.data.work_id === workId && !work.error;
  const [linkWork, setLinkWork] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const draftKey: DraftKey | undefined = scope ? { account: scope.account_id, domain: scope.data_domain,
    conversation: 'global-consultation', resource: 'global', version: 0, kind: 'consultation' } : undefined;
  const [draft, setDraft] = useState(() => (draftKey && browserDrafts.read(draftKey)) ?? '');
  const attempt = commands.attempts[createKey];
  const resolvedId = attempt?.phase === 'received' ? receiptResource(attempt.receiptUrl, '/api/v1/consultations/') : undefined;
  const consultation = useScopedSnapshot('getConsultation', { id: resolvedId }, parseConsultation, {
    enabled: !!resolvedId, refetchInterval: 2000,
  });
  const observed = consultation.data?.data;
  const expectedWork = attempt?.intent.command.payload as { parent_work_id?: string | null } | undefined;
  const actual = observed?.request_id === resolvedId && observed?.parent_work_id === expectedWork?.parent_work_id ? observed : undefined;
  const terminal = actual && ['answered', 'cancelled', 'failed'].includes(actual.status);
  const editable = !attempt || attempt.phase === 'declined';
  const cancelKey = resolvedId ? 'consultation.cancel:' + resolvedId : '';
  const pendingCancel = commands.attempts[cancelKey];

  function change(value: string) {
    setDraft(value);
    if (draftKey) setUnsaved(!browserDrafts.write(draftKey, value));
  }
  return <>
    <p>{t.noImplicitLink}</p>
    {editable && <form onSubmit={(event) => {
      event.preventDefault();
      if (!draft.trim() || !scope || (linkWork && !approved)) return;
      commands.start(createKey, { operation: 'createConsultation', parameters: {},
        command: { expected_revision: null, payload: { text: draft, parent_work_id: linkWork && approved ? workId : null } } });
    }}>
      <label htmlFor={label}>{shared('aria.question')}</label>
      <textarea id={label} rows={5} value={draft} onChange={(event) => change(event.target.value)} />
      {approved && <label className="check-control">
        <input type="checkbox" checked={linkWork} onChange={(event) => setLinkWork(event.target.checked)} />
        {t.linkWork} {workId}
      </label>}
      {unsaved && <p role="status">{t.draftUnsaved}</p>}
      <footer className="actions">
        <button type="submit" className="primary" disabled={!draft.trim() || (linkWork && !approved)}>{t.ask}</button>
        <button type="button" onClick={() => change('')} disabled={!draft}>{shared('button.clearDraft')}</button>
      </footer>
    </form>}
    {attempt?.phase === 'sending' && <p role="status">{shared('status.received')}</p>}
    {(attempt?.phase === 'declined' || attempt?.phase === 'retry') && <LocalizedError code={attempt.error.code}
      onRetry={attempt.phase === 'retry' ? () => commands.retry(createKey) : undefined} />}
    {attempt?.phase === 'received' && <>
      {consultation.error && <LocalizedError code={asClientError(consultation.error).code} onRetry={() => void consultation.refetch()} />}
      {actual ? <section>
        <p role="status">{t[actual.status]}</p>
        {actual.parent_work_id && <p>{t.relatedWork}: {actual.parent_work_id}</p>}
        {actual.status === 'answered' && actual.final_result && <SafeMarkdown>{actual.final_result.text}</SafeMarkdown>}
        {actual.status !== 'answered' && actual.partial_text && <SafeMarkdown>{actual.partial_text}</SafeMarkdown>}
        {(actual.status === 'pending' || actual.status === 'waiting_user') && <button type="button"
          disabled={!!pendingCancel && pendingCancel.phase !== 'declined'} onClick={() => {
            commands.start(cancelKey, { operation: 'cancelConsultation', parameters: { id: actual.request_id },
              command: { expected_revision: actual.result_version, payload: {} } });
          }}>{t.cancelConsultation}</button>}
        {(pendingCancel?.phase === 'declined' || pendingCancel?.phase === 'retry') && <LocalizedError code={pendingCancel.error.code}
          onRetry={pendingCancel.phase === 'retry' ? () => commands.retry(cancelKey) : undefined} />}
        <Conversation conversationId={actual.conversation_id} />
        {terminal && <button type="button" onClick={() => {
          change(''); setLinkWork(false); commands.clear(createKey);
        }}>{t.newConsultation}</button>}
      </section> : <p role="status">{(!resolvedId || observed) ? t.unexpectedReceipt : t.received}</p>}
    </>}
  </>;
}

function Conversation({ conversationId }: { conversationId: string }) {
  const t = useT15();
  const { scope } = useService();
  const commands = useCommands();
  const label = useId();
  const commandKey = 'consultation.message:' + conversationId;
  const draftKey: DraftKey | undefined = scope ? { account: scope.account_id, domain: scope.data_domain, conversation: conversationId,
    resource: conversationId, version: 0, kind: 'message' } : undefined;
  const [draft, setDraft] = useState(() => (draftKey && browserDrafts.read(draftKey)) ?? '');
  const [cleared, setCleared] = useState('');
  const attempt = commands.attempts[commandKey];
  const reading = useScopedSnapshot('listMessages', { id: conversationId }, parseMessages, { refetchInterval: 2500 });
  const receiptId = attempt?.phase === 'received' ? receiptResource(attempt.receiptUrl, '/api/v1/conversations/', '/messages') : undefined;
  const haveReply = receiptId === conversationId;
  const canType = !attempt || attempt.phase === 'declined' || (haveReply && cleared === attempt.intent.requestId);
  function change(text: string) {
    setDraft(text);
    if (draftKey) browserDrafts.write(draftKey, text);
  }
  return <section>
    <h3>{t.conversation}</h3>
    <p>{t.ordinaryNote}</p>
    {reading.error && <LocalizedError code={asClientError(reading.error).code} onRetry={() => void reading.refetch()} />}
    {reading.data && <ol>{reading.data.data.items.map((message) => <li key={message.message_id}>
      <strong>{message.role === 'user' ? t.authorUser : t.authorAssistant}</strong>
      <SafeMarkdown>{message.raw_text}</SafeMarkdown>
    </li>)}</ol>}
    {attempt?.phase === 'received' && !haveReply && <p role="status">{t.unexpectedReceipt}</p>}
    {haveReply && attempt?.phase === 'received' && !canType && <button type="button" onClick={() => {
      setCleared(attempt.intent.requestId); change(''); commands.clear(commandKey); void reading.refetch();
    }}>{t.newMessage}</button>}
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!canType || !draft.trim()) return;
      commands.start(commandKey, { operation: 'postMessage', parameters: { id: conversationId },
        command: { expected_revision: null, payload: { text: draft } } });
    }}>
      {canType && <>
        <label htmlFor={label}>{t.newMessage}</label>
        <textarea id={label} value={draft} rows={3} onChange={(event) => change(event.target.value)} />
        <button type="submit" disabled={!draft.trim()}>{t.chat}</button>
      </>}
      {attempt?.phase === 'sending' && <p role="status">{t.received}</p>}
      {(attempt?.phase === 'declined' || attempt?.phase === 'retry') && <LocalizedError code={attempt.error.code}
        onRetry={attempt.phase === 'retry' ? () => commands.retry(commandKey) : undefined} />}
    </form>
  </section>;
}

function workFromRoute(route: string): string | undefined {
  const [pathname, search] = route.split('?', 2);
  if (pathname === '/decisions') {
    const query = new URLSearchParams(search);
    return safeResource(query.get('question')) ? safeResource(query.get('work')) : undefined;
  }
  const match = /^\/work\/([^/]+)$/u.exec(pathname);
  try { return match ? safeResource(decodeURIComponent(match[1])) : undefined; } catch { return undefined; }
}
