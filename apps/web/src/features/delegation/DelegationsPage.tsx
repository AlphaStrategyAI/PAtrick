import { useState } from 'react';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { LocalizedError, ScopePreview } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { formatDate } from '../../i18n/locale.js';
import { integer, may, parseList, record, string, strings, T16Access } from '../edits/support.js';

import { ControlPreview, type Preview } from './ControlPreview.js';
import { DelegationCreate } from './DelegationCreate.js';

function parseDelegation(data: unknown) {
  const item = record(data);
  return {
    id: string(item.mandate_id), status: string(item.status), level: string(item.level), revision: integer(item.revision),
    expires: string(item.expires_at), risk: string(item.risk), budget: integer(item.budget_micros),
    scope: [
      ['delegations.actions', strings(item.actions)],
      ['delegations.resources', strings(item.resources)],
      ['delegations.effects', strings(item.effects)],
      ['delegations.domains', strings(item.domains)],
    ] as const,
  };
}

export function DelegationsPage() {
  return <T16Access permission="delegations.read" scoped>{(operations) => <DelegationsView operations={operations} />}</T16Access>;
}

function DelegationsView({ operations }: { operations: readonly string[] }) {
  const { t, locale } = useLocale();
  const { scope } = useService();
  const list = useScopedSnapshot('listDelegations', {}, (value) => parseList(value, parseDelegation));
  const [id, select] = useState('');
  const [preview, propose] = useState<Preview>();
  const [creating, create] = useState(false);
  const selected = useScopedSnapshot('getDelegation', { id }, parseDelegation, { enabled: !!id });
  const current = selected.data?.data.id === id ? selected.data.data : undefined;
  function showPreview(requested: Preview['requested']) {
    if (current?.status === 'active' || current?.status === 'paused') {
      propose({ id: current.id, status: current.status, revision: current.revision, requested });
    }
  }
  function status(value: string) {
    return value === 'active' ? t('delegations.active') : value === 'paused' ? t('delegations.paused')
      : value === 'stopped' ? t('delegations.stopped') : t('status.unknown');
  }
  return <>
    <section className="card">
      {list.error && <LocalizedError code={asClientError(list.error).code} />}
      {list.data?.data.length === 0 && <p>{t('empty.delegations')}</p>}
      {list.data?.data.length === 0 && may(operations, 'owner') && <div className="actions">
        <button type="button" className="primary" onClick={() => create(true)}>{t('delegations.create')}</button>
      </div>}
      <ul>{list.data?.data.map((item) => <li key={item.id}>
        <button type="button" aria-pressed={id === item.id} onClick={() => { select(item.id); propose(undefined); }}>{item.id}</button>
        {' · '}{status(item.status)}
      </li>)}</ul>
    </section>
    {selected.error && <LocalizedError code={asClientError(selected.error).code} />}
    {current && <section className="card">
      <h2>{current.id}</h2>
      <p>{status(current.status)} · {current.level}</p>
      <p>{t('learning.revision')} {current.revision}</p>
      <p>{t('delegations.expires')} <time dateTime={current.expires}>{formatDate(locale, current.expires)}</time></p>
      <p>{t('delegations.risk')} {current.risk}</p>
      <p>{t('delegations.budget')} {new Intl.NumberFormat(locale).format(current.budget)}</p>
      <ScopePreview><dl>{current.scope.map(([key, items]) => <div key={key}><dt>{t(key)}</dt>
        <dd>{items.length ? items.join('、') : t('delegations.none')}</dd></div>)}</dl></ScopePreview>
      {may(operations, 'owner') && current.status !== 'stopped' && <div className="actions">
        {current.status === 'active' && <button type="button" onClick={() => showPreview('paused')}>{t('delegations.previewPause')}</button>}
        {current.status === 'paused' && <button type="button" onClick={() => showPreview('active')}>{t('delegations.previewResume')}</button>}
        <button type="button" onClick={() => showPreview('stopped')}>{t('delegations.previewStop')}</button>
      </div>}
    </section>}
    {preview && <ControlPreview preview={preview} onClose={() => propose(undefined)}
      onApplied={() => { void list.refetch(); void selected.refetch(); }} />}
    {creating && <DelegationCreate domain={scope?.data_domain ?? ''} onClose={() => create(false)}
      onApplied={() => { void list.refetch(); void selected.refetch(); }} />}
  </>;
}
