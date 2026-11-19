import { useEffect, useRef, useState } from 'react';
import { delegationProposalSchema } from '@patrick/contracts/resources';
import { ClientError } from '../../api/client.js';
import { useService } from '../../api/query.js';
import { Dialog, LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate } from '../../i18n/locale.js';
import { record, string } from '../edits/support.js';

type Prepared = ReturnType<typeof delegationProposalSchema.parse>;
type Scope = {
  type_id: string;
  actions: string;
  resources: string;
  effects: string;
  domains: string;
  risk: string;
  level: 'L0' | 'L1' | 'L2' | 'L3';
  budget_micros: string;
  expires_at: string;
};

const empty: Scope = {
  type_id: '', actions: '', resources: '', effects: '', domains: '',
  risk: 'low', level: 'L0', budget_micros: '0', expires_at: '',
};

const list = (value: string) => value.split(',').map((entry) => entry.trim()).filter(Boolean);

/** Proposes a new delegation scope and applies it through the trusted control flow.
 *
 * The proposal is staged with the owner's one-time challenge, read back for its
 * exact hash, confirmed, and only then applied. Nothing here changes a delegation
 * on its own: the server owns the scope, the mandate and the receipt.
 */
export function DelegationCreate({ domain, onClose, onApplied }: {
  domain: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { api } = useService();
  const { t, locale } = useLocale();
  const [scope, setScope] = useState<Scope>(empty);
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

  function update(patch: Partial<Scope>) {
    setScope((prior) => ({ ...prior, ...patch }));
  }

  async function explicitly(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    const lifecycle = new AbortController();
    abort.current?.abort();
    abort.current = lifecycle;
    try {
      await action(lifecycle.signal);
    } catch (cause) {
      if (!lifecycle.signal.aborted) setError(cause instanceof ClientError ? cause.code : 'UNAVAILABLE');
    } finally {
      if (!lifecycle.signal.aborted) setBusy(false);
      pending.current = false;
    }
  }

  async function read(id: string, signal: AbortSignal) {
    const response = await api.read('getDelegationProposal', { id }, { signal });
    const result = delegationProposalSchema.parse(response.data);
    if (result.proposal_id !== id || result.change.action !== 'create') throw new ClientError('INVALID_RESPONSE');
    return result;
  }

  async function stage(signal: AbortSignal) {
    const keys = exact.current;
    if (!keys.challenge) {
      keys.challenge = string(record(await api.write('createAuthChallenge', {}, { rp_id: window.location.hostname }, { signal })).challenge_id);
    }
    const accepted = await api.command('createDelegationProposal', {}, {
      client_request_id: keys.stage ??= crypto.randomUUID(),
      expected_revision: null,
      payload: {
        type_id: scope.type_id,
        actions: list(scope.actions),
        resources: list(scope.resources),
        effects: list(scope.effects),
        domains: list(scope.domains),
        risk: scope.risk,
        level: scope.level,
        budget_micros: Number(scope.budget_micros),
        expires_at: new Date(scope.expires_at).toISOString(),
        challenge_id: keys.challenge,
      },
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
      client_request_id: keys.confirm ??= crypto.randomUUID(),
      expected_revision: prepared.base_revision,
      payload: { proposal_hash: prepared.proposal_hash, challenge_id: challenge },
    }, { signal });
    const confirmation = record((await api.read('getCommand', { id: accepted.command_id }, { signal })).data);
    const controlReceiptId = string(confirmation.control_receipt_id);
    if (confirmation.command_id !== accepted.command_id || confirmation.resource_id !== prepared.proposal_id ||
        confirmation.operation !== 'confirmControlProposal') throw new ClientError('INVALID_RESPONSE');
    await api.command('applyDelegationProposal', { id: prepared.proposal_id }, {
      client_request_id: keys.apply ??= crypto.randomUUID(),
      expected_revision: prepared.mandate_revision,
      payload: { control_receipt_id: controlReceiptId },
    }, { signal });
    const applied = await read(prepared.proposal_id, signal);
    if (applied.state !== 'applied' || applied.result?.control_receipt_id !== controlReceiptId) {
      throw new ClientError('INVALID_RESPONSE');
    }
    signal.throwIfAborted();
    setPrepared(applied);
    onApplied();
  }

  return <Dialog title={t('delegations.create')} onClose={() => { if (!pending.current) onClose(); }}>
    {error && <LocalizedError code={error} />}
    {!prepared && <form onSubmit={(event) => {
      event.preventDefault();
      void explicitly(stage);
    }}>
      <label>{t('delegations.typeId')}
        <input required maxLength={160} value={scope.type_id}
          onChange={(event) => update({ type_id: event.target.value })} /></label>
      <label>{t('delegations.actions')}
        <input maxLength={1600} value={scope.actions}
          onChange={(event) => update({ actions: event.target.value })} /></label>
      <label>{t('delegations.resources')}
        <input maxLength={1600} value={scope.resources}
          onChange={(event) => update({ resources: event.target.value })} /></label>
      <label>{t('delegations.effects')}
        <input maxLength={1600} value={scope.effects}
          onChange={(event) => update({ effects: event.target.value })} /></label>
      <label>{t('delegations.domains')}
        <input required maxLength={1600} value={scope.domains}
          onChange={(event) => update({ domains: event.target.value })} /></label>
      <label>{t('delegations.risk')}
        <input required maxLength={100} value={scope.risk}
          onChange={(event) => update({ risk: event.target.value })} /></label>
      <label>{t('delegations.level')}
        <select value={scope.level} onChange={(event) => update({ level: event.target.value as Scope['level'] })}>
          {(['L0', 'L1', 'L2', 'L3'] as const).map((level) => <option key={level} value={level}>{level}</option>)}
        </select></label>
      <label>{t('delegations.budget')}
        <input required type="number" min={0} step={1} value={scope.budget_micros}
          onChange={(event) => update({ budget_micros: event.target.value })} /></label>
      <label>{t('delegations.expires')}
        <input required type="datetime-local" value={scope.expires_at}
          onChange={(event) => update({ expires_at: event.target.value })} /></label>
      <p>{t('delegations.scopeDomain')}: <code>{domain}</code></p>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>{t('delegations.stage')}</button>
        <button type="button" disabled={busy} onClick={onClose}>{t('button.cancel')}</button>
      </div>
    </form>}
    {prepared && <>
      <p>{t('delegations.exactProposal')} <code data-testid="delegation-proposal-hash">{prepared.proposal_hash}</code></p>
      <p>{t('delegations.expires')} <time dateTime={prepared.expires_at}>{formatDate(locale, prepared.expires_at)}</time></p>
      {prepared.state === 'expired' && <p role="status">{t('delegations.expired')}</p>}
      {prepared.result && <>
        <p role="status">{t('delegations.applied')}{t('delegations.active')}</p>
        <p>{t('delegations.controlReceipt')} <code data-testid="delegation-control-receipt">{prepared.result.control_receipt_id}</code></p>
      </>}
      <div className="actions">
        {prepared.state === 'staged' && <button type="button" className="primary" disabled={busy}
          onClick={() => { void explicitly(confirmAndApply); }}>{t('delegations.confirmApply')}</button>}
        <button type="button" disabled={busy} onClick={onClose}>{t('button.cancel')}</button>
      </div>
    </>}
  </Dialog>;
}
