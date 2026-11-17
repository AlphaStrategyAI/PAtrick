import { useState } from 'react';
import { workControlReceiptSchema, workControlViewSchema, type workControlActionSchema } from '@patrick/contracts/resources';
import { asClientError, useScopedSnapshot } from '../../api/query.js';
import { Dialog, LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { useCommands } from './CommandSession.js';
import { useT15 } from './messages.js';

type Action = ReturnType<typeof workControlActionSchema.parse>;
export function WorkControls({ workId, generation, refreshWork }: { workId: string; generation: number; refreshWork: () => void }) {
  const t = useT15();
  const { t: common } = useLocale();
  const access = useScopedSnapshot('getWorkControl', { id: workId }, workControlViewSchema.parse);
  const current = access.data?.data;
  const available = current?.work_id === workId && current.generation === generation ? current : undefined;
  const commands = useCommands();
  const key = `work-controls:${workId}:${generation}`;
  const attempt = commands.attempts[key];
  const [review, setReview] = useState<{ action: Action; revision: number }>();
  const receiptId = attempt?.phase === 'received' ? matchReceipt(attempt.receiptUrl, workId) : undefined;
  const receiptQuery = useScopedSnapshot('getWorkControlReceipt', { id: workId, receiptId }, workControlReceiptSchema.parse,
    { enabled: !!receiptId, refetchInterval: 2500 });
  const result = receiptQuery.data?.data;
  const sent = attempt?.intent.command.payload;
  const valid = result && result.receipt_id === receiptId && result.work_id === workId && result.generation === generation &&
    sent && typeof sent === 'object' && !Array.isArray(sent) && result.type === sent.type;
  const actionLabels = { pause: t.pauseWork, resume: t.resumeWork, stop: t.stopWork };
  const states = { running: t.controlRunning, paused: t.paused, processing: t.controlStopping, stopped: t.controlStopped,
    denied: t.controlDenied };

  if (!available && !attempt) return access.error ? <LocalizedError code={asClientError(access.error).code} /> : null;
  if (!attempt && !available?.actions.length) return null;

  return <section aria-label={t.workControls}>
    {!attempt && available && <div className="actions">
      {available.actions.map((action) => <button type="button" key={action}
        onClick={() => setReview({ action, revision: available.control_revision })}>{actionLabels[action]}</button>)}
    </div>}
    {review && <Dialog title={actionLabels[review.action]} onClose={() => setReview(undefined)}>
      <p>{t.reviewWorkControl} <code>{workId}</code></p>
      <div className="actions">
        <button type="button" onClick={() => setReview(undefined)}>{common('button.cancel')}</button>
        <button type="button" className="primary" disabled={!available?.actions.includes(review.action) || available.control_revision !== review.revision}
          onClick={() => {
            commands.start(key, { operation: 'controlWork', parameters: { id: workId },
              command: { expected_revision: review.revision, payload: { generation, type: review.action } } });
            setReview(undefined);
          }}>{common('button.confirm')}</button>
      </div>
    </Dialog>}
    {attempt?.phase === 'sending' && <p role="status">{t.received}</p>}
    {(attempt?.phase === 'retry' || attempt?.phase === 'declined') && <LocalizedError code={attempt.error.code}
      onRetry={attempt.phase === 'retry' ? () => commands.retry(key) : () => {
        commands.clear(key); void access.refetch(); refreshWork();
      }} />}
    {attempt?.phase === 'received' && <section className="receipt" data-testid="work-control-receipt">
      <h3>{t.workControlReceipt}</h3>
      {!receiptId || (result && !valid) ? <LocalizedError code="INVALID_RESPONSE" />
        : receiptQuery.error ? <LocalizedError code={asClientError(receiptQuery.error).code} onRetry={() => { void receiptQuery.refetch(); }} />
          : <p role="status">{valid ? states[result.state] : t.received}</p>}
      {valid && result.state !== 'processing' && <button type="button" onClick={() => { void access.refetch().then(() => {
        commands.clear(key); refreshWork();
      }); }}>{t.readUpdatedWork}</button>}
    </section>}
  </section>;
}

function matchReceipt(url: string, workId: string) {
  const base = '/api/v1/work/' + encodeURIComponent(workId) + '/controls/';
  if (!url.startsWith(base)) return undefined;
  const id = url.slice(base.length);
  return /^wcr_[a-f0-9-]{36}$/u.test(id) ? id : undefined;
}
