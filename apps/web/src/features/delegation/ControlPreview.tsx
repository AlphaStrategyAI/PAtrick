import { useEffect, useRef, useState } from 'react';
import { delegationProposalSchema } from '@patrick/contracts/resources';
import { ClientError } from '../../api/client.js';
import { asClientError, useService } from '../../api/query.js';
import { Dialog, LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate } from '../../i18n/locale.js';
import { record, string } from '../edits/support.js';

type Status = 'active' | 'paused' | 'stopped';
export type Preview = { id: string; revision: number; status: Status; requested: Status };
type Prepared = ReturnType<typeof delegationProposalSchema.parse>;
const actions = { active: 'resume', paused: 'pause', stopped: 'stop' } as const;
const statusKeys = { active: 'delegations.active', paused: 'delegations.paused', stopped: 'delegations.stopped' } as const;

export function ControlPreview({ preview, onClose, onApplied }: { preview: Preview; onClose: () => void; onApplied: () => void }) {
  const { api } = useService();
  const { t, locale } = useLocale();
  const [prepared, setPrepared] = useState<Prepared>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const exact = useRef<{ challenge?: string; stage?: string; confirm?: string; apply?: string }>({});
  const abort = useRef<AbortController>(null);
  useEffect(() => {
    const lifecycle = new AbortController();
    abort.current = lifecycle;
    return () => lifecycle.abort();
  }, []);

  async function explicitly(action: (signal: AbortSignal) => Promise<void>) {
    const signal = abort.current?.signal;
    if (!signal || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try { await action(signal); } catch (cause) {
      if (!signal.aborted) setError(asClientError(cause).code);
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  async function read(id: string, signal: AbortSignal) {
    const response = await api.read('getDelegationProposal', { id }, { signal });
    const result = delegationProposalSchema.parse(response.data);
    if (result.proposal_id !== id || result.mandate_id !== preview.id || result.mandate_revision !== preview.revision ||
        result.before !== preview.status || result.change.action !== actions[preview.requested]) {
      throw new ClientError('INVALID_RESPONSE');
    }
    return result;
  }

  async function stage(signal: AbortSignal) {
    const keys = exact.current;
    if (!keys.challenge) keys.challenge = string(record(await api.write('createAuthChallenge', {}, { rp_id: window.location.hostname }, { signal })).challenge_id);
    const accepted = await api.command('controlDelegation', { id: preview.id }, {
      client_request_id: keys.stage ??= crypto.randomUUID(), expected_revision: preview.revision,
      payload: { type: actions[preview.requested], challenge_id: keys.challenge },
    }, { signal });
    const path = /^\/api\/v1\/delegation-proposals\/(dprop_[0-9a-f-]+)$/u.exec(accepted.receipt_url);
    if (!path) throw new ClientError('INVALID_RESPONSE');
    const staged = await read(path[1], signal);
    signal.throwIfAborted();
    setPrepared(staged);
  }

  async function confirmAndApply(signal: AbortSignal) {
    const keys = exact.current;
    const challenge = keys.challenge;
    if (!prepared || !challenge || prepared.state !== 'staged') return;
    const accepted = await api.command('confirmControlProposal', { id: prepared.proposal_id }, {
      client_request_id: keys.confirm ??= crypto.randomUUID(), expected_revision: prepared.base_revision,
      payload: { proposal_hash: prepared.proposal_hash, challenge_id: challenge },
    }, { signal });
    const confirmation = record((await api.read('getCommand', { id: accepted.command_id }, { signal })).data);
    const controlReceiptId = string(confirmation.control_receipt_id);
    if (confirmation.command_id !== accepted.command_id || confirmation.resource_id !== prepared.proposal_id ||
        confirmation.operation !== 'confirmControlProposal') throw new ClientError('INVALID_RESPONSE');
    await api.command('applyDelegationProposal', { id: prepared.proposal_id }, {
      client_request_id: keys.apply ??= crypto.randomUUID(), expected_revision: preview.revision,
      payload: { control_receipt_id: controlReceiptId },
    }, { signal });
    const applied = await read(prepared.proposal_id, signal);
    if (applied.state !== 'applied' || applied.result?.control_receipt_id !== controlReceiptId || applied.result.status !== preview.requested) {
      throw new ClientError('INVALID_RESPONSE');
    }
    signal.throwIfAborted();
    setPrepared(applied);
    onApplied();
  }

  return <Dialog title={t('delegations.preview')} onClose={() => { if (!pending.current) onClose(); }}>
    <p><code>{preview.id}</code> · {t('learning.revision')} {preview.revision}</p>
    <p>{t(statusKeys[preview.status])} → {t(statusKeys[preview.requested])}</p>
    {error && <LocalizedError code={error} />}
    {!prepared && <p>{t('delegations.confirmationUnavailable')}</p>}
    {prepared && <>
      <p>{t('delegations.exactProposal')} <code data-testid="delegation-proposal-hash">{prepared.proposal_hash}</code></p>
      <p>{t('delegations.expires')} <time dateTime={prepared.expires_at}>{formatDate(locale, prepared.expires_at)}</time></p>
      {prepared.state === 'expired' && <p role="status">{t('delegations.expired')}</p>}
      {prepared.result && <>
        <p role="status">{t('delegations.applied')}{t(statusKeys[prepared.result.status])}</p>
        <p>{t('delegations.controlReceipt')} <code data-testid="delegation-control-receipt">{prepared.result.control_receipt_id}</code></p>
      </>}
    </>}
    <div className="actions">
      {!prepared && <button type="button" className="primary" disabled={busy}
        onClick={() => { void explicitly(stage); }}>{t('delegations.stage')}</button>}
      {prepared?.state === 'staged' && <button type="button" className="primary" disabled={busy}
        onClick={() => { void explicitly(confirmAndApply); }}>{t('delegations.confirmApply')}</button>}
      <button type="button" disabled={busy} onClick={onClose}>{t('button.cancel')}</button>
    </div>
  </Dialog>;
}
