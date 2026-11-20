import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { channelTestSchema, feishuConnectionSchema } from '@patrick/contracts/resources';
import type { Json } from '@patrick/contracts';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate } from '../../i18n/locale.js';
import { feishuSetupCopy } from './FeishuSetupCopy.js';
import { SettingsChangeWizard } from './SettingsChangeWizard.js';
import { ClientError } from '../../api/client.js';

const pairingSchema = z.strictObject({
  pairing_id: z.string().nullable(),
  status: z.enum(['open', 'candidate', 'expired', 'consumed']).nullable(),
  expires_at: z.string().nullable(),
  candidate_open_id: z.string().nullable(),
  data_domain: z.string().min(1),
  app_id: z.string().nullable(),
  destination: z.string().nullable(),
  current_test_id: z.string().nullable(),
  code: z.string().regex(/^[A-Za-z0-9_-]{24}$/u).nullable(),
  credential_setup_available: z.boolean(),
  transport_available: z.boolean(),
  owner_actions_available: z.boolean(),
  pairing_start_available: z.boolean().default(false),
  reject_pairing_available: z.boolean().default(false),
});
const sample = 'PAtrick 连接测试，不含业务资料。';

const sessionPermissions = z.object({ operations: z.array(z.string()) });

export function FeishuSetup({ onChanged }: { onChanged: () => void }) {
  const { locale } = useLocale();
  const copy = feishuSetupCopy[locale];
  const id = useId();
  const permissions = useScopedSnapshot('getSession', {}, sessionPermissions.parse);
  const operations = permissions.data?.data.operations;
  if (operations?.some((permission) => permission === 'owner' || permission === 'channels.read')) {
    return <FeishuSetupDetails onChanged={onChanged} />;
  }
  return <section className="receipt" aria-labelledby={id}>
    <h2 id={id}>{copy.title}</h2>
    {permissions.error ? <LocalizedError code={asClientError(permissions.error).code} onRetry={() => { void permissions.refetch(); }} />
      : <p role="status">{operations ? copy.readUnavailable : copy.checking}</p>}
  </section>;
}

function FeishuSetupDetails({ onChanged }: { onChanged: () => void }) {
  const { api, scope, accessGeneration } = useService();
  const { locale } = useLocale();
  const copy = feishuSetupCopy[locale];
  const [rotation, setRotation] = useState<string>();
  const [configuration, setConfiguration] = useState<{ credential_ref: string; app_id: string }>();
  const titleId = useId();
  const connection = useScopedSnapshot('getFeishuChannel', {}, feishuConnectionSchema.parse);
  const pairing = useScopedSnapshot('getFeishuBinding', { id: 'current' }, pairingSchema.parse);
  const details = pairing.data?.data;
  const status = connection.data?.data.status;
  const testId = details?.current_test_id ?? '';
  const report = useScopedSnapshot('getFeishuTest', { id: testId }, channelTestSchema.parse, { enabled: !!testId });
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [pairCode, setPairCode] = useState<{ pairingId: string; code: string; duration: number }>();
  const lifetime = useRef<AbortController | null>(null);
  const action = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [accessGeneration, scope?.account_id, scope?.data_domain, scope?.permission_epoch]);

  useEffect(() => {
    if (!pairCode) return;
    const timer = window.setTimeout(() => setPairCode(undefined), pairCode.duration);
    return () => window.clearTimeout(timer);
  }, [pairCode]);

  function act(run: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || action.current || !scope) return;
    action.current = true;
    setBusy(true);
    setFailure(undefined);
    void run(signal).then(async () => {
      if (signal.aborted) return;
      await Promise.all([connection.refetch(), pairing.refetch()]);
      if (testId) await report.refetch();
      if (!signal.aborted) onChanged();
    }).catch(async (error: unknown) => {
      if (signal.aborted) return;
      setFailure(asClientError(error).code);
      await Promise.allSettled([connection.refetch(), pairing.refetch()]);
    }).finally(() => {
      action.current = false;
      if (!signal.aborted) setBusy(false);
    });
  }

  function command(name: string, signal: AbortSignal, payload: Json = {}, id?: string) {
    return api.command(name, id ? { id } : {}, {
      client_request_id: globalThis.crypto.randomUUID(), expected_revision: null, payload,
    }, { signal });
  }

  function saveCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const appId = form.elements.namedItem('app_id');
    const secret = form.elements.namedItem('app_secret');
    if (!details?.credential_setup_available || window.location.protocol !== 'https:' ||
        !(appId instanceof HTMLInputElement) || !(secret instanceof HTMLInputElement)) return;
    const body = { app_id: appId.value.trim(), app_secret: secret.value };
    secret.value = '';
    act(async (signal) => {
      try {
        // The endpoint only holds the secret. The connection itself is created
        // by a trusted change, so the owner proves the exact configuration.
        const staged = await api.write('putFeishuCredentials', {}, body, { signal }) as { credential_ref?: string };
        if (!staged.credential_ref) throw new ClientError('INVALID_RESPONSE');
        setConfiguration({ credential_ref: staged.credential_ref, app_id: body.app_id });
      } finally { body.app_secret = ''; }
    });
  }

  /** Stages a new app secret and offers the rotation as a trusted change.
   *
   * The secret never reaches a setting draft: the credential endpoint keeps it and
   * hands back a reference, and only that reference travels with the change.
   */
  function stageRotation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const secret = form.elements.namedItem('rotation_secret');
    const channelId = connection.data?.data.connection_id;
    const appId = details?.app_id ?? '';
    if (!details?.credential_setup_available || window.location.protocol !== 'https:' ||
        !(secret instanceof HTMLInputElement) || !channelId) return;
    const body = { app_id: appId, app_secret: secret.value };
    secret.value = '';
    act(async (signal) => {
      try {
        const response = await api.write('putFeishuCredentials', {}, body, { signal });
        const staged = response as { credential_ref?: string };
        if (!staged.credential_ref) throw new ClientError('INVALID_RESPONSE');
        setRotation(staged.credential_ref);
      } finally { body.app_secret = ''; }
    });
  }

  function startPairing(rejectedId?: string) {
    act(async (signal) => {
      setPairCode(undefined);
      const result = rejectedId
        ? await command('rejectFeishuBinding', signal, { pairing_id: rejectedId })
        : await command('createFeishuBinding', signal);
      const id = result.receipt_url.match(/^\/api\/v1\/channels\/feishu\/bindings\/(pair_[a-f0-9]{16})$/u)?.[1];
      if (signal.aborted) return;
      if (!id) throw new Error('Invalid pairing receipt');
      const snapshot = await api.read('getFeishuBinding', { id }, { signal });
      const receipt = pairingSchema.parse(snapshot.data);
      const duration = receipt.expires_at ? Date.parse(receipt.expires_at) - Date.parse(snapshot.as_of) : 0;
      if (signal.aborted) return;
      if (receipt.pairing_id !== id || !receipt.code || !(duration > 0)) throw new Error('Pairing code unavailable');
      setPairCode({ pairingId: id, code: receipt.code, duration });
    });
  }

  const nativeProbeRequired = connection.data?.data.reason_code === 'NATIVE_PROBE_REQUIRED';
  const canConfigure = details?.credential_setup_available && window.location.protocol === 'https:';
  const transportAvailable = details?.transport_available === true;
  const currentTest = report.data?.data;
  const reportedError = connection.error ?? pairing.error ?? report.error;
  const canShowCode = details?.status === 'open' && pairCode?.pairingId === details.pairing_id;
  const checkedStatus = status === 'ready' && !transportAvailable ? copy.activeUnverified
    : status ? copy.connection[status] : copy.checking;
  const active = connection.data?.data.transport_mode === 'active' || connection.data?.data.transport_mode === 'draining';

  return <section className="receipt" aria-labelledby={titleId}>
    <h2 id={titleId}>{copy.title}</h2>
    <p role="status">{checkedStatus}</p>
    {details?.app_id && <p>{copy.appId}: {details.app_id}</p>}
    {details?.destination && <p>{copy.identity}: {details.destination}</p>}
    {connection.data && <p>{copy.lastChecked}: <time dateTime={connection.data.as_of}>{formatDate(locale, connection.data.as_of)}</time></p>}
    {reportedError && <LocalizedError code={asClientError(reportedError).code} onRetry={() => act(async () => {})} />}
    <details open={opened} onToggle={(event) => {
      const open = event.currentTarget.open;
      setOpened(open);
      if (!open) setPairCode(undefined);
    }}>
      <summary>{copy.setup}</summary>
      {opened && <>
        {failure && <LocalizedError code={failure} />}
        <button type="button" disabled={busy} onClick={() => act(async () => {})}>{copy.refresh}</button>
        <h3>{copy.credentialsStage}</h3>
        {status === 'not_configured' && (canConfigure ? <form onSubmit={saveCredentials} autoComplete="off">
          <label>{copy.appId}<input name="app_id" required maxLength={200} autoCapitalize="none" spellCheck={false} /></label>
          <label>{copy.secret}<input name="app_secret" type="password" maxLength={1024} required autoComplete="new-password" /></label>
          <button type="submit" disabled={busy}>{copy.stage}</button>
        </form> : <p>{copy.secureUnavailable}</p>)}
        {configuration && <SettingsChangeWizard operation="set_feishu_connection"
          targets={[{ target: configuration.app_id, device: null, revision: 0,
            input: { credential_ref: configuration.credential_ref, app_id: configuration.app_id } }]}
          entryLabel="settings.feishuConfigure" onChanged={() => {
            setConfiguration(undefined);
            void connection.refetch();
            void pairing.refetch();
            onChanged();
          }} />}
        {nativeProbeRequired && <p>{copy.nativeProbeRequired}</p>}
        {status !== 'not_configured' && connection.data?.data.connection_id && <section>
          <h3>{copy.rotationStage}</h3>
          {!canConfigure ? <p>{copy.secureUnavailable}</p> : !rotation ? <form onSubmit={stageRotation} autoComplete="off">
            <label>{copy.rotationSecret}
              <input name="rotation_secret" type="password" maxLength={1024} required autoComplete="new-password" /></label>
            <button type="submit" disabled={busy}>{copy.rotationStageSecret}</button>
          </form> : <SettingsChangeWizard operation="rotate_feishu_credential"
            targets={[{ target: connection.data.data.connection_id, device: null,
              revision: connection.data.data.config_revision ?? 0, input: { credential_ref: rotation } }]}
            entryLabel="settings.feishuRotate" onChanged={() => {
              setRotation(undefined);
              void connection.refetch();
              void pairing.refetch();
              onChanged();
            }} />}
        </section>}
        {active && <p>{copy.managed}</p>}
        {!active && status !== 'not_configured' && details?.app_id && <>
          <h3>{copy.bindingStage}</h3>
          {status === 'needs_binding' && details.owner_actions_available && (
            details.status === 'candidate' && details.pairing_id && details.candidate_open_id ?
              <div>
                <p>{copy.identity}: {details.candidate_open_id}</p>
                <p>{copy.domain}: {details.data_domain}</p>
                <button type="button" disabled={busy} onClick={() => {
                  act(async (signal) => { await command('confirmFeishuBinding', signal, {}, details.pairing_id ?? undefined); });
                }}>{copy.confirm}</button>
                {details.reject_pairing_available && <button type="button" disabled={busy}
                  onClick={() => { if (details.pairing_id) startPairing(details.pairing_id); }}>{copy.reject}</button>}
              </div> :
              <div>
                {pairCode && canShowCode && <p>{copy.pairingSend}: <code>{pairCode.code}</code></p>}
                {details.status === 'open' && details.expires_at && <p>{copy.expires}: {formatDate(locale, details.expires_at)}</p>}
                <button type="button" disabled={busy || !details.pairing_start_available} onClick={() => startPairing()}>{copy.pairingStart}</button>
              </div>
          )}
          {(status === 'needs_test' || status === 'needs_enable') && details.destination && <>
            <h3>{copy.testStage}</h3>
            {details.owner_actions_available && (!testId || currentTest?.status === 'expired') && status === 'needs_test' && <button type="button" disabled={busy} onClick={() => {
              act(async (signal) => { await command('createFeishuTest', signal, { destination: details.destination }); });
            }}>{copy.preview}</button>}
            {currentTest && <>
              <p>{copy.bot}: {currentTest.app_id}</p>
              <p>{copy.identity}: {currentTest.destination}</p>
              <p>{copy.domain}: {currentTest.data_domain}</p>
              <blockquote>{sample}</blockquote>
              <p role="status">{(!transportAvailable && ['sending', 'sent', 'verified'].includes(currentTest.status)) ||
                (currentTest.status === 'verified' && (!currentTest.message_id || !currentTest.inbound_evidence)) ||
                (currentTest.status === 'sent' && !currentTest.message_id)
                ? copy.unverifiedTransport : copy.test[currentTest.status]}</p>
              {transportAvailable && currentTest.message_id && <p>{copy.messageId}: <code>{currentTest.message_id}</code></p>}
              {currentTest.status === 'previewed' && details.owner_actions_available && <button type="button" disabled={busy || !transportAvailable} onClick={() => {
                act(async (signal) => {
                  const sampleHash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sample));
                  const hex = Array.from(new Uint8Array(sampleHash), (byte) => byte.toString(16).padStart(2, '0')).join('');
                  if (currentTest.preview_hash !== hex || currentTest.destination !== details.destination ||
                      currentTest.app_id !== details.app_id || currentTest.data_domain !== details.data_domain) {
                    setFailure('CONFLICT');
                    return;
                  }
                  await command('sendFeishuTest', signal, { test_id: currentTest.test_id,
                    destination: currentTest.destination, preview_hash: currentTest.preview_hash }, currentTest.test_id);
                });
              }}>{copy.send}</button>}
            </>}
          </>}
        </>}
        {!transportAvailable && <p>{copy.transportUnavailable}</p>}
      </>}
    </details>
  </section>;
}
