import { settingsDashboardSchema } from '@patrick/contracts/resources';
import { useScopedSnapshot } from '../../api/query.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import type { MessageKey } from '../../i18n/locale.js';

const groupKeys: Record<string, MessageKey> = {
  collection: 'settings.collection', materials: 'settings.materials', execution: 'settings.execution',
  operation: 'settings.operation', interaction: 'settings.interaction', preferences: 'settings.preferences',
};

/** Shows where each entry on the settings page comes from.
 *
 * An entry PAtrick found on this machine reads as detected, one that is still
 * missing is suggested, one the owner chose is theirs, and one that comes from
 * the host or the platform is inherited. Entries this installation does not have
 * are left out.
 */
export function SettingsReadiness() {
  const { t } = useLocale();
  const settings = useScopedSnapshot('getSettings', {}, settingsDashboardSchema.parse);
  if (!settings.data) return null;
  return <ul className="settings-readiness" data-testid="settings-readiness">
    <li className="settings-readiness-label">{t('settings.readiness')}</li>
    {settings.data.data.groups.map((group) => {
      const origins = [...new Set(group.operations.filter((operation) => operation.registered)
        .map((operation) => operation.origin))];
      if (origins.length === 0) return null;
      return <li key={group.id}>
        <span>{t(groupKeys[group.id] ?? 'status.unknown')}</span>
        {origins.map((origin) => <span key={origin} className="settings-origin" data-origin={origin}>
          {t(`settings.origin.${origin}` as MessageKey)}</span>)}
      </li>;
    })}
  </ul>;
}
