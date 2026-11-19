import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { settingsDashboardSchema, settingsInspectionSchema, settingsReceiptSchema, settingsRecoveryOfferSchema } from '@patrick/contracts/resources';
import { ClientError } from '../../api/client.js';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate, type MessageKey } from '../../i18n/locale.js';
import { FeishuSetup } from './FeishuSetup.js';
import { SettingsChangeWizard } from './SettingsChangeWizard.js';

const effectKeys: Record<string, MessageKey> = {
  vault_connection: 'settings.connectVault', feishu_mode: 'settings.enableFeishu',
  feishu_draining: 'settings.feishuDraining', feishu_disabled: 'settings.feishuDisabled',
  feishu_rebind: 'settings.feishuRebind', feishu_credential: 'settings.feishuRotate',
};
const operationKeys: Record<string, MessageKey> = {
  configure_source: 'settings.configureSource', connect_vault: 'settings.connectVault', change_vault: 'settings.changeVault',
  enable_work_directory: 'materials.workDirectory', change_work_directory: 'materials.workDirectory',
  rebind_feishu: 'settings.feishuRebind', rotate_feishu_credential: 'settings.feishuRotate',
  inspect_executor: 'settings.executorCheck', inspect_host: 'settings.hostCheck', repair_network: 'settings.repairNetwork', start_backup: 'settings.startBackup',
  start_restore: 'settings.startRestore', enable_feishu: 'settings.enableFeishu', disable_feishu: 'settings.disableFeishu',
};

export function SettingsGroup({ group }: { group: string }) {
  const { locale, t } = useLocale();
  const { api } = useService();
  const settings = useScopedSnapshot('getSettings', {}, settingsDashboardSchema.parse);
  const snapshot = settings.data;
  const current = snapshot?.data.groups.find((entry) => entry.id === group);
  const [records, setRecords] = useState<Array<{ target: string; observed: string }>>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  async function runChecks() {
    setChecking(true);
    setCheckError(undefined);
    try {
      const response = await api.submit('inspectSettings', {}, {
        client_request_id: crypto.randomUUID(), expected_revision: null, payload: {},
      });
      setRecords(settingsInspectionSchema.parse((response as { data: unknown }).data).records);
    } catch (error) {
      setCheckError(error instanceof ClientError ? error.code : 'UNAVAILABLE');
    } finally {
      setChecking(false);
    }
  }
  return <section className="card">
    {settings.error && <LocalizedError code={asClientError(settings.error).code} onRetry={() => { void settings.refetch(); }} />}
    {!settings.error && !current && <p role="status">{t('status.unknown')}</p>}
    {snapshot && current && <>
      {group === 'interaction' && <FeishuSetup key={JSON.stringify(snapshot.scope)} onChanged={() => { void settings.refetch(); }} />}
      <ul>
        {current.operations.map(({ operation, registered, kind, targets }) => <li key={operation}>
          {t(operationKeys[operation] ?? 'status.unknown')}: {t(registered ? 'settings.registered' : 'settings.notConfigured')}
          {registered && kind === 'change' && targets.length > 0 && <SettingsChangeWizard operation={operation} targets={targets}
            entryLabel={operationKeys[operation] ?? 'status.unknown'} onChanged={() => { void settings.refetch(); }} />}
          {registered && kind === 'inspect' && <button type="button" disabled={checking}
            onClick={() => { void runChecks(); }}>{t(checking ? 'status.refreshing' : 'settings.runChecks')}</button>}
        </li>)}
      </ul>
      {checkError && <LocalizedError code={checkError} onRetry={() => { void runChecks(); }} />}
      {records && <ul data-testid="settings-inspection-records">
        {records.map((record) => <li key={record.target}><code>{record.target}</code>: {record.observed}</li>)}
      </ul>}
      <p>{t('settings.snapshotAsOf')}: <time dateTime={snapshot.as_of}>{formatDate(locale, snapshot.as_of)}</time></p>
      <ChangeReceipt />
    </>}
  </section>;
}

export function ChangeReceipt({ system = false }: { system?: boolean }) {
  const { locale, t } = useLocale();
  const [search] = useSearchParams();
  const requested = search.get('change') ?? '';
  const id = /^settings_[a-f0-9-]{36}$/u.test(requested) ? requested : '';
  const result = useScopedSnapshot(system ? 'getSystemIncident' : 'getSettingsChange', { id }, settingsReceiptSchema.parse, {
    enabled: !!id, refetchInterval: 5000,
  });
  if (!id) return requested ? <LocalizedError code="INVALID_REQUEST" /> : null;
  const receipt = result.data?.data;
  return <section data-testid="settings-change-receipt" className="receipt">
    <h2>{t('settings.changeReceipt')}</h2>
    {result.error && <LocalizedError code={asClientError(result.error).code} onRetry={() => { void result.refetch(); }} />}
    {receipt && <>
      <p><code>{receipt.change_id}</code></p>
      <p role="status">{t(receipt.verified ? 'settings.recheckVerified'
        : receipt.phase === 'observed' ? 'settings.recheckFailed' : receipt.phase === 'uncertain' ? 'settings.applyUncertain' : 'settings.applying')}</p>
      {receipt.applied_revision != null && <p>{t('settings.appliedRevision')}: {receipt.applied_revision}</p>}
      {receipt.effects.length > 0 && <ul>{receipt.effects.filter(({ item }) => !item.startsWith('network:operation:') && !item.startsWith('recovery:operation:')).map((effect) => <li key={effect.item}>
        {effect.item.startsWith('network:') ? <NetworkEffect item={effect.item} />
          : <>{t(effectKeys[effect.item] ?? 'settings.effect')}: {t(`settings.effect.${effect.outcome}`)}</>}
      </li>)}</ul>}
      {receipt.checked_at && <p>{t('settings.lastChecked')}:{' '}
        <time dateTime={receipt.checked_at}>{formatDate(locale, receipt.checked_at)}</time></p>}
      {['start_backup', 'start_restore'].includes(receipt.operation) && !receipt.verified &&
        <NetworkRecovery changeId={id} recoveryOperation onChanged={() => { void result.refetch(); }} />}
      {receipt.operation === 'repair_network' && !receipt.verified && (receipt.phase !== 'observed' ||
        receipt.effects.some(({ item }) => ['network:unresolved', 'network:in_progress', 'network:repaired'].includes(item))) &&
        <NetworkRecovery changeId={id} onChanged={() => { void result.refetch(); }} />}
      {system ? <Link to={`/settings/${receipt.operation.includes('vault') ? 'materials'
        : ['repair_network', 'inspect_host', 'start_backup', 'start_restore'].includes(receipt.operation) ? 'operation' : 'interaction'}?change=${id}`}>{t('nav.settings')}</Link>
        : <Link to={`/system?change=${id}`}>{t('nav.system')}</Link>}
    </>}
  </section>;
}

function NetworkRecovery({ changeId, onChanged, recoveryOperation = false }: { changeId: string; onChanged: () => void; recoveryOperation?: boolean }) {
  const { t } = useLocale();
  const result = useScopedSnapshot('getSettingsRecovery', { id: changeId }, settingsRecoveryOfferSchema.parse);
  const offer = result.data?.data;
  if (!offer) return result.error ? <LocalizedError code={asClientError(result.error).code} onRetry={() => { void result.refetch(); }} /> : null;
  if (offer.status === 'unavailable') {
    const reasons: Record<string, MessageKey> = {
      owner_required: 'network.recoveryOwner', network_intent_unavailable: 'network.recoveryIntent',
      network_effect_unsettled: 'network.recoveryUnsettled', network_provenance: 'network.recoveryChanged',
      recovery_unregistered: 'network.recoveryUnavailable',
    };
    return <p role="status">{t(recoveryOperation ? 'settings.recoveryUnavailable' : reasons[offer.reason] ?? 'network.recoveryUnavailable')}</p>;
  }
  const recoveryLabel = offer.action === 'reconcile_network' ? 'network.recoveryAction' : 'settings.recoveryAction';
  return <section>
    <h3>{t(recoveryLabel)}</h3>
    <p>{t(offer.action === 'reconcile_network' ? 'network.recoveryReadOnly' : 'settings.recoveryReadOnly')}</p>
    <SettingsChangeWizard operation={offer.action} targets={[offer.target]} recoveryChangeId={changeId}
      entryLabel={recoveryLabel} onChanged={() => { onChanged(); void result.refetch(); }} />
  </section>;
}

const networkStates: Record<string, MessageKey> = {
  repaired: 'network.repaired', already_healthy: 'network.healthy', needs_login: 'network.login',
  mfa_required: 'network.mfa', needs_permission: 'network.permission', rate_limited: 'network.backoff',
  unavailable: 'network.unavailable', unresolved: 'network.unresolved', deadline: 'network.deadline',
  reverted: 'network.reverted', not_repaired: 'network.notRepaired', not_applicable: 'network.notApplicable',
  peer_unavailable: 'network.peerUnavailable', busy: 'network.busy', in_progress: 'network.busy',
  stale_epoch: 'network.changed', superseded: 'network.changed', not_confirmed: 'network.notConfirmed',
};
const networkProblems: Record<string, MessageKey> = {
  healthy: 'network.healthy', interface: 'network.interface', route: 'network.route', dns: 'network.dns',
  proxy: 'network.proxy', tcp: 'network.tcp', tls: 'network.tls', identity: 'network.login',
  rate_limit: 'network.backoff', target: 'network.target', peer: 'network.peerUnavailable',
  permission: 'network.permission', mfa: 'network.mfa', unknown: 'status.unknown',
};

function NetworkEffect({ item }: { item: string }) {
  const { locale, t } = useLocale();
  const parts = item.split(':');
  if ((parts[1] === 'verify' || parts[1] === 'rollback') && parts.length === 4) {
    return <>{t(parts[1] === 'verify' ? 'network.verification' : 'network.rollback')}: {parts[2]}
      {' · '}{t(networkProblems[parts[3]] ?? 'status.unknown')}</>;
  }
  if (parts[1] === 'retry_at' && parts.length === 3) {
    const timestamp = Number(parts[2]);
    return <>{t('network.retryAt')}: {Number.isSafeInteger(timestamp) && timestamp > 0 &&
      timestamp <= 8_640_000_000_000_000 ? formatDate(locale, new Date(timestamp).toISOString()) : t('status.unknown')}</>;
  }
  if (parts[1] === 'question' && parts.length === 3 && /^[a-f0-9-]{36}$/u.test(parts[2])) {
    return <>{t('network.question')}: {parts[2]}{' · '}
      <Link to={'/settings/operation?network_question=' + encodeURIComponent(parts[2])}>{t('network.mfaAction')}</Link></>;
  }
  return <>{t(networkStates[parts[1]] ?? 'status.unknown')}</>;
}
