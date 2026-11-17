import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { settingsControlSchema, settingsValidationSchema } from '@patrick/contracts/resources';
import { asClientError, useService } from '../../api/query.js';
import { ConnectionWizard, LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate, type MessageKey } from '../../i18n/locale.js';
import { safeEnvelope } from './envelope.js';

type Target = { target: string; device: string | null; status: string; revision: number };
type Proof = ReturnType<typeof settingsValidationSchema.parse>;
type Proposal = ReturnType<typeof settingsControlSchema.parse> & { challengeId: string };
const steps = ['settings.stepTarget', 'settings.stepValidation', 'settings.stepConfirmation'] as const satisfies readonly MessageKey[];

export function SettingsChangeWizard({ operation, targets, entryLabel, onChanged }: {
  operation: string; targets: Target[]; entryLabel: MessageKey; onChanged: () => void;
}) {
  const { api, scope, accessGeneration } = useService();
  const { t, locale } = useLocale();
  const [, setSearch] = useSearchParams();
  const [step, setStep] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [proof, setProof] = useState<Proof>();
  const [proposal, setProposal] = useState<Proposal>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const finalIds = useRef<{ confirm: string; apply: string } | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [accessGeneration]);
  const selected = targets.find((target) => targetKey(target) === selectedId);
  const draft = selected && scope ? { operation, domain: scope.data_domain, target: selected.target,
    input: selected.device ? { device_id: selected.device } : null } : undefined;

  function reset(next = 0) {
    if (running.current) return;
    setStep(next);
    setProposal(undefined);
    setError(undefined);
    finalIds.current = undefined;
    if (!next) setProof(undefined);
  }

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current?.signal;
    if (running.current || !signal || signal.aborted) return;
    running.current = true;
    setError(undefined);
    setBusy(true);
    try { await action(signal); }
    catch (cause: unknown) {
      if (!signal.aborted) setError(asClientError(cause).code);
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  async function validate(signal: AbortSignal) {
    if (!draft || !selected) return;
    const payload = await safeEnvelope(draft, selected.revision);
    const data = await api.write('validateSettings', {}, payload, { signal }) as { data: Proof };
    signal.throwIfAborted();
    setProof(data.data);
    setStep(1);
  }

  async function prepare(signal: AbortSignal) {
    if (!proof?.valid || !draft) return;
    const auth = await api.write('createAuthChallenge', {}, { rp_id: window.location.hostname }, { signal }) as { challenge_id: string };
    const payload = await safeEnvelope({ draft, validation_id: proof.validation_id, challenge_id: auth.challenge_id }, proof.base_revision);
    const prepared = await api.write('prepareSettingsControl', {}, payload, { signal }) as { data: ReturnType<typeof settingsControlSchema.parse> };
    signal.throwIfAborted();
    finalIds.current = { confirm: crypto.randomUUID(), apply: crypto.randomUUID() };
    setProposal({ ...prepared.data, challengeId: auth.challenge_id });
    setStep(2);
  }

  async function confirm(signal: AbortSignal) {
    const ids = finalIds.current;
    if (!proposal || !proof || !draft || !ids) return;
    const accepted = await api.command('confirmControlProposal', { id: proposal.proposal_id }, {
      client_request_id: ids.confirm, expected_revision: proposal.base_revision,
      payload: { proposal_hash: proposal.proposal_hash, challenge_id: proposal.challengeId },
    }, { signal });
    const confirmation = await api.read('getCommand', { id: accepted.command_id }, { signal });
    const receiptId = confirmation.data && typeof confirmation.data === 'object' && 'control_receipt_id' in confirmation.data
      ? confirmation.data.control_receipt_id : undefined;
    if (typeof receiptId !== 'string') throw new Error('Malformed control receipt');
    const change = await api.command('applySettingsChanges', {}, {
      client_request_id: ids.apply, expected_revision: proposal.object_revision,
      payload: { draft, validation_id: proof.validation_id, control_receipt_id: receiptId },
    }, { signal });
    signal.throwIfAborted();
    setSearch((previous) => { const next = new URLSearchParams(previous); next.set('change', change.command_id); return next; });
    finalIds.current = undefined;
    setStep(0);
    setSelectedId('');
    setProof(undefined);
    setProposal(undefined);
    onChanged();
  }

  return <ConnectionWizard steps={steps} current={step} canContinue={!busy && (step === 0 ? !!selected : !!proof?.valid && !!selected)}
    onStep={(next) => {
      if (next < step) reset(next);
      else if (!step) void run(validate);
      else if (step === 1) void run(prepare);
    }}>
    <h3>{t(entryLabel)}</h3>
    {error && <LocalizedError code={error} />}
    {!step && <label>{t('settings.selectTarget')}
      <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={busy}>
        <option value="">{t('settings.chooseTarget')}</option>
        {targets.map((target) => <option key={targetKey(target)} value={targetKey(target)}>
          {target.target}{target.device ? ' · ' + target.device : ''}
        </option>)}
      </select>
    </label>}
    {step > 0 && proof && <>
      <p>{t('settings.selectTarget')}: <code>{selected?.target}</code></p>
      <p>{t(proof.valid ? 'settings.validationPassed' : 'settings.validationFailed')}</p>
      <p>{t('settings.validationExpiry')}: {formatDate(locale, proof.expires_at)}</p>
    </>}
    {step === 2 && proposal && <>
      <p>{t('settings.reviewExactChange')}</p>
      <p><code>{proposal.proposal_hash}</code></p>
      <button type="button" className="primary" disabled={busy || !selected} onClick={() => { void run(confirm); }}>
        {t('settings.confirmApply')}
      </button>
    </>}
  </ConnectionWizard>;
}

const targetKey = ({ target, device }: Target) => JSON.stringify([target, device]);
