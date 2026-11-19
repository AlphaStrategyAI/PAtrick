import { useState } from 'react';
import { settingsInspectionSchema } from '@patrick/contracts/resources';
import { ClientError } from '../../api/client.js';
import { useService } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import type { MessageKey } from '../../i18n/locale.js';

type Record = { target: string; observed: string };

const CATEGORIES: Array<{ id: string; label: MessageKey; members: string[] }> = [
  { id: 'network', label: 'system.category.network', members: ['network'] },
  { id: 'executor', label: 'system.category.executor', members: ['executor:codex', 'executor:grok', 'executor:dsh'] },
  { id: 'sources', label: 'system.category.sources', members: ['sources'] },
  { id: 'recovery', label: 'system.category.recovery', members: ['recovery'] },
  { id: 'host', label: 'system.category.host', members: ['host', 'backup'] },
];

/** Shows the service status per category, so the biggest problem is visible first.
 *
 * The records come from the same inspection the Settings page runs, so the two
 * never disagree about what the service observed.
 */
export function SystemCategories() {
  const { api } = useService();
  const { t } = useLocale();
  const [records, setRecords] = useState<Record[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.submit('inspectSettings', {}, {
        client_request_id: crypto.randomUUID(), expected_revision: null, payload: {},
      });
      setRecords(settingsInspectionSchema.parse((response as { data: unknown }).data).records);
    } catch (cause) {
      setError(cause instanceof ClientError ? cause.code : 'UNAVAILABLE');
    } finally {
      setBusy(false);
    }
  }

  const byTarget = new Map((records ?? []).map((record) => [record.target, record.observed]));

  return <section className="card" data-testid="system-categories">
    <h3>{t('system.categories')}</h3>
    <button type="button" disabled={busy} onClick={() => { void run(); }}>
      {t(busy ? 'status.refreshing' : 'settings.runChecks')}
    </button>
    {error && <LocalizedError code={error} onRetry={() => { void run(); }} />}
    {records && <dl>
      {CATEGORIES.map((category) => <div key={category.id}>
        <dt>{t(category.label)}</dt>
        <dd>{category.members.map((member) => byTarget.get(member)).filter((value): value is string => !!value)
          .map((value) => <span key={value}>{value}</span>)}</dd>
      </div>)}
    </dl>}
  </section>;
}
