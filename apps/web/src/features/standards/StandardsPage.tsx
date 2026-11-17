import { useState } from 'react';
import { asClientError, useScopedSnapshot } from '../../api/query.js';
import { LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { EditDialog, parseEditTarget, type EditRequest } from '../edits/EditDialog.js';
import { integer, may, parseList, record, string, T16Access } from '../edits/support.js';
import { EvaluationEvidence } from './EvaluationEvidence.js';

function parseStandard(value: unknown) {
  const row = record(value);
  return { id: string(row.standard_id), current: row.active_version === null ? null : integer(row.active_version), degraded: row.degraded === true };
}
function parseVersion(value: unknown) {
  const row = record(value);
  return { version: integer(row.version), status: string(row.status), report: typeof row.report_id === 'string' ? row.report_id : undefined };
}
type Standard = ReturnType<typeof parseStandard>;

export function StandardsPage() {
  return <T16Access scoped permission="standards.read">{(operations) => <StandardView operations={operations} />}</T16Access>;
}

function StandardView({ operations }: { operations: readonly string[] }) {
  const { t } = useLocale();
  const list = useScopedSnapshot('listStandards', {}, (value) => parseList(value, parseStandard));
  const [selected, select] = useState<string>();
  const [draft, setDraft] = useState<EditRequest>();
  const items = list.data?.data;
  function startRevision(standard: Standard) {
    if (standard.current === null) return;
    setDraft({ operation: 'revise_standard', standard_id: standard.id, base_version: standard.current, draft_key: crypto.randomUUID() });
  }
  return <>
    <section className="card">
      {list.error && <LocalizedError code={asClientError(list.error).code} onRetry={() => { void list.refetch(); }} />}
      {items?.length === 0 && <p>{t('empty.standards')}</p>}
      {items && items.every((item) => item.current === null) && may(operations, 'edits.write') && may(operations, 'edits.read') &&
        <button type="button" onClick={() => setDraft({ operation: 'create_standard', draft_key: crypto.randomUUID(), expected_active_version: null })}>
          {t('edits.operation.create_standard')}
        </button>}
      {items && <ul>{items.map((item) => <li key={item.id}>
        <button type="button" aria-pressed={selected === item.id} onClick={() => select(item.id)}>{item.id}</button>
        <p>{item.current === null ? t('standards.candidate') : <>{t(item.degraded ? 'standards.degraded' : 'standards.current')} {item.current}</>}</p>
        {item.current !== null && may(operations, 'edits.write') && may(operations, 'edits.read') &&
          <button type="button" onClick={() => startRevision(item)}>{t('edits.operation.revise_standard')}</button>}
      </li>)}</ul>}
    </section>
    {selected && <VersionComparison key={selected} id={selected} />}
    {draft && <StandardDraft draft={draft} onClose={() => {
      setDraft(undefined);
      void list.refetch();
    }} />}
  </>;
}

function StandardDraft({ draft, onClose }: { draft: EditRequest; onClose: () => void }) {
  const id = draft.operation === 'revise_standard' ? draft.standard_id : '';
  const target = useScopedSnapshot('getStandardEditTarget', { id }, parseEditTarget, { enabled: !!id });
  const base = target.data?.data;
  return <EditDialog operation={draft.operation} payload={base ? { ...draft, vault_id: base.vault_id } : draft}
    target={base ? { ...base, obsidian_uri: undefined } : undefined} onClose={onClose} />;
}

function VersionComparison({ id }: { id: string }) {
  const { t } = useLocale();
  const versions = useScopedSnapshot('listStandardVersions', { id }, (value) => ({
    items: parseList(value, parseVersion),
    candidates: parseList({ items: record(value).candidates }, (input) => {
      const candidate = record(input);
      return { id: string(candidate.candidate_id), status: string(candidate.status),
        report: typeof candidate.report_id === 'string' ? candidate.report_id : undefined };
    }),
  }));
  const [reportId, selectReport] = useState('');
  return <section className="card">
    <h2>{t('standards.versions')}</h2>
    {versions.error && <LocalizedError code={asClientError(versions.error).code} />}
    <ul>{versions.data?.data.items.map((version) => <li key={version.version}>
      {t('learning.revision')} {version.version} · {version.status === 'active' ? t('standards.current')
        : version.status === 'candidate' ? t('standards.candidate')
          : version.status === 'withdrawn' ? t('learning.withdrawn') : t('standards.historical')}
      {version.report && <button type="button" onClick={() => selectReport(version.report!)}>{t('standards.evaluation')}</button>}
    </li>)}</ul>
    {versions.data?.data.candidates.length ? <ul>{versions.data.data.candidates.map((candidate) => <li key={candidate.id}>
      {t('standards.candidate')} <code>{candidate.id}</code> · {t(candidate.status === 'stale' ? 'edits.business.stale'
        : candidate.status === 'not_adopted' ? 'edits.business.not_adopted' : 'edits.business.pending')}
      {candidate.report && <button type="button" onClick={() => selectReport(candidate.report!)}>{t('standards.evaluation')}</button>}
    </li>)}</ul> : null}
    {reportId && <EvaluationEvidence id={reportId} />}
    {versions.data?.data.items.every((version) => !version.report) && versions.data.data.candidates.every((candidate) => !candidate.report) &&
      <p className="muted">{t('standards.evidenceUnavailable')}</p>}
  </section>;
}
