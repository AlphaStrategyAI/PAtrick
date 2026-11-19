import { Link, useOutletContext } from 'react-router';
import type { ShellHealthContext } from '../../app/AppShell.js';
import { isDemo } from '../../app/demo.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate, type MessageKey } from '../../i18n/locale.js';

const issues: Record<string, MessageKey> = {
  vault_needs_permission: 'settings.overview.vaultPermission',
  vault_degraded: 'settings.overview.vaultDegraded',
  feishu_degraded: 'settings.overview.feishuDegraded',
  edit_requires_attention: 'settings.overview.editAttention',
};

export function SettingsOverview() {
  const { locale, t } = useLocale();
  const { health, connected, projectionCurrent, verifiedAsOf } = useOutletContext<ShellHealthContext>();
  const snapshot = health.data;
  const offline = !isDemo && connected === false;
  const unavailable = !isDemo && !offline && !!health.error;
  const current = !isDemo && !health.error && connected === true && snapshot?.freshness === 'fresh' &&
    snapshot.data.freshness === 'fresh';
  const service = current && snapshot.data.service === 'running' ? 'settings.overview.current'
    : current && snapshot.data.service === 'paused' ? 'settings.overview.paused' : 'settings.overview.unknown';
  const stale = !offline && !unavailable && !!snapshot && (snapshot.freshness === 'stale' || snapshot.data.freshness === 'stale');
  const issue = current && Object.hasOwn(issues, snapshot.data.impact) ? issues[snapshot.data.impact] : undefined;

  return <section className="settings-overview" aria-labelledby="settings-overview-title">
    <div className="settings-overview-copy">
      <h2 id="settings-overview-title">{t('settings.overview.title')}</h2>
      <p className="settings-overview-scope">{t('settings.overview.scope')}</p>
      <p>{t('settings.overview.status')}{locale === 'en' ? ' ' : ''}<strong>{t(service)}</strong></p>
      <p className="settings-overview-evidence">
        <span>{t('settings.overview.device')}</span>
        <span>{verifiedAsOf ? <>{t(projectionCurrent ? 'settings.overview.asOf' : 'settings.overview.lastAsOf')}{' '}
          <time dateTime={verifiedAsOf}>{formatDate(locale, verifiedAsOf)}</time></> : t('settings.overview.noSnapshot')}</span>
      </p>
      {offline && <p>{t('settings.overview.offline')}</p>}
      {unavailable && <p>{t('settings.overview.unavailable')}</p>}
      {stale && <p>{t('settings.overview.stale')}</p>}
      {issue && <p>{t('settings.overview.issue')} {t(issue)}</p>}
    </div>
    <div className="settings-overview-actions">
      <button type="button" disabled={isDemo || health.isFetching} onClick={() => { void health.refetch(); }}>
        {t(health.isFetching ? 'settings.overview.refreshing' : 'settings.overview.refresh')}
      </button>
      <Link to="/system">{t('settings.overview.system')}</Link>
    </div>
  </section>;
}
