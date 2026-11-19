import { useState } from 'react';
import { sourceEntrySchema, vaultConnectionSchema } from '@patrick/contracts/resources';
import { z } from 'zod';
import { asClientError, useScopedSnapshot } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate, type MessageKey } from '../../i18n/locale.js';
import { SettingsChangeWizard } from './SettingsChangeWizard.js';

const sourcePage = z.strictObject({ items: z.array(sourceEntrySchema), next_cursor: z.string().nullable() });
const vaultPage = z.strictObject({ items: z.array(z.strictObject({
  vault_id: z.string().min(1), status: z.string().min(1), data_domain: z.string().min(1),
})) });
const frequencies = ['poll', '30m', '1h', '6h', '24h'] as const;
const facetKeys: Record<string, MessageKey> = {
  ready: 'materials.facetReady', missing: 'materials.facetMissing', stopped: 'materials.facetStopped',
  unknown: 'status.unknown',
};
type Directory = z.infer<typeof sourceEntrySchema>;
type Vault = z.infer<typeof vaultPage>['items'][number];

/** The work materials of the account: the approved work directory and the Vault.
 *
 * The editor and the material are reported separately, so a missing desktop app
 * never reads as a missing library.
 */
export function WorkMaterials() {
  const { t } = useLocale();
  const sources = useScopedSnapshot('listSources', {}, sourcePage.parse);
  const vaults = useScopedSnapshot('listVaults', {}, vaultPage.parse);
  const directories = (sources.data?.data.items ?? []).filter((item) => item.connector_type === 'directory');
  const vault = vaults.data?.data.items[0];
  return <>
    <section className="card" aria-label={t('materials.workDirectory')}>
      <h2>{t('materials.workDirectory')}</h2>
      {sources.error && <LocalizedError code={asClientError(sources.error).code} onRetry={() => { void sources.refetch(); }} />}
      {directories.length === 0 && <p role="status">{t('materials.noWorkDirectory')}</p>}
      {directories.map((directory) => <WorkDirectoryCard key={directory.source_id} directory={directory}
        onChanged={() => { void sources.refetch(); }} />)}
    </section>
    <section className="card" aria-label={t('materials.vault')}>
      <h2>{t('materials.vault')}</h2>
      {vaults.error && <LocalizedError code={asClientError(vaults.error).code} onRetry={() => { void vaults.refetch(); }} />}
      {!vault && <p role="status">{t('materials.noVault')}</p>}
      {vault && <VaultConnectionCard vault={vault} />}
    </section>
  </>;
}

function WorkDirectoryCard({ directory, onChanged }: { directory: Directory; onChanged: () => void }) {
  const { locale, t } = useLocale();
  const [frequency, setFrequency] = useState(directory.frequency);
  const [action, setAction] = useState<'modify' | 'pause' | 'resume' | 'disconnect'>();
  const disconnected = directory.status === 'disconnected';
  return <>
    <p><code>{directory.normalized_target}</code></p>
    <p>{t('collection.frequency')}: {directory.frequency} · {t(directory.status === 'enabled' ? 'collection.enabled'
      : directory.status === 'paused' ? 'status.paused' : 'collection.disconnected')}</p>
    <details>
      <summary>{t('materials.directoryDetails')}</summary>
      <p>{t('materials.sourceId')}: <code>{directory.source_id}</code></p>
      <p>{t('settings.snapshotAsOf')}: <time dateTime={directory.updated_at}>{formatDate(locale, directory.updated_at)}</time></p>
    </details>
    {!disconnected && <div className="actions">
      {(['modify', directory.status === 'enabled' ? 'pause' : 'resume', 'disconnect'] as const).map((next) =>
        <button key={next} type="button" aria-pressed={action === next}
          onClick={() => { setFrequency(directory.frequency); setAction(next); }}>
          {t(next === 'modify' ? 'collection.modify' : next === 'pause' ? 'collection.pause'
            : next === 'resume' ? 'collection.resume' : 'collection.disconnect')}
        </button>)}
    </div>}
    {action === 'modify' && <label>{t('collection.frequency')}
      <select value={frequency} onChange={(event) => setFrequency(event.target.value)}>
        {frequencies.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>}
    {action && <SettingsChangeWizard key={[directory.source_id, directory.config_revision, action, frequency].join(':')}
      operation="change_work_directory"
      targets={[{ target: directory.source_id, device: null, label: directory.normalized_target,
        revision: directory.config_revision,
        input: action === 'modify' ? { action, frequency } : { action } }]}
      entryLabel={action === 'modify' ? 'collection.modify' : action === 'pause' ? 'collection.pause'
        : action === 'resume' ? 'collection.resume' : 'collection.disconnect'}
      onChanged={() => { setAction(undefined); onChanged(); }} />}
  </>;
}

function VaultConnectionCard({ vault }: { vault: Vault }) {
  const { t } = useLocale();
  const connection = useScopedSnapshot('getVaultConnection', { id: vault.vault_id }, vaultConnectionSchema.parse);
  const state = connection.data?.data;
  return <>
    <p><code>{t('materials.vault')}: {vault.vault_id}</code></p>
    {connection.error && <LocalizedError code={asClientError(connection.error).code}
      onRetry={() => { void connection.refetch(); }} />}
    {state && <>
      <p>{t('materials.editor')}: {t(facetKeys[state.editor_status] ?? 'status.unknown')}</p>
      <p>{t('materials.material')}: {t(facetKeys[state.collection_status] ?? 'status.unknown')}</p>
      <p>{t('materials.writeBack')}: {t(facetKeys[state.projection_status] ?? 'status.unknown')}</p>
    </>}
  </>;
}
