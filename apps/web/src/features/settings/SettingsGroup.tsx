import { Link, useSearchParams } from 'react-router';
import { settingsDashboardSchema, settingsReceiptSchema } from '@patrick/contracts/resources';
import { asClientError, useScopedSnapshot } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate, type MessageKey } from '../../i18n/locale.js';
import { FeishuSetup } from './FeishuSetup.js';
import { SettingsChangeWizard } from './SettingsChangeWizard.js';

const effectKeys: Record<string, MessageKey> = {
  vault_connection: 'settings.connectVault', feishu_mode: 'settings.enableFeishu',
  feishu_draining: 'settings.feishuDraining', feishu_disabled: 'settings.feishuDisabled',
};
const operationKeys: Record<string, MessageKey> = {
  configure_source: 'settings.configureSource', connect_vault: 'settings.connectVault', change_vault: 'settings.changeVault',
  inspect_executor: 'settings.executorCheck', inspect_host: 'settings.hostCheck', start_backup: 'settings.startBackup',
  start_restore: 'settings.startRestore', enable_feishu: 'settings.enableFeishu', disable_feishu: 'settings.disableFeishu',
};

export function SettingsGroup({ group }: { group: string }) {
  const { locale, t } = useLocale();
  const settings = useScopedSnapshot('getSettings', {}, settingsDashboardSchema.parse);
  const current = settings.data?.data.groups.find((entry) => entry.id === group);
  return <section className="card">
    {settings.error && <LocalizedError code={asClientError(settings.error).code} onRetry={() => { void settings.refetch(); }} />}
    {!settings.error && !current && <p role="status">{t('status.unknown')}</p>}
    {current && <>
      {group === 'interaction' && <FeishuSetup key={JSON.stringify(settings.data!.scope)} onChanged={() => { void settings.refetch(); }} />}
      <ul>
        {current.operations.map(({ operation, registered, targets }) => <li key={operation}>
          {t(operationKeys[operation] ?? 'status.unknown')}: {t(registered ? 'settings.registered' : 'settings.notConfigured')}
          {registered && targets.length > 0 && <SettingsChangeWizard operation={operation} targets={targets}
            entryLabel={operationKeys[operation] ?? 'status.unknown'} onChanged={() => { void settings.refetch(); }} />}
        </li>)}
      </ul>
      <p>{t('settings.lastChecked')}: {formatDate(locale, settings.data!.as_of)}</p>
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
      {receipt.effects.length > 0 && <ul>{receipt.effects.map((effect) => <li key={effect.item}>
        {t(effectKeys[effect.item] ?? 'settings.effect')}: {t(`settings.effect.${effect.outcome}`)}
      </li>)}</ul>}
      {receipt.checked_at && <p>{t('settings.lastChecked')}: {formatDate(locale, receipt.checked_at)}</p>}
      {system ? <Link to={`/settings/${receipt.operation.includes('vault') ? 'materials' : 'interaction'}?change=${id}`}>{t('nav.settings')}</Link>
        : <Link to={`/system?change=${id}`}>{t('nav.system')}</Link>}
    </>}
  </section>;
}
