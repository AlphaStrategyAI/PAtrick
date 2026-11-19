import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { asClientError, useScopedSnapshot } from '../../api/query.js';
import { LocalizedError, SafeMarkdown } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { EditDialog, parseEditTarget, type EditRequest } from '../edits/EditDialog.js';
import { integer, may, parseList, record, string, T16Access } from '../edits/support.js';

function parseKnowledge(data: unknown) {
  const row = record(data);
  return { id: string(row.knowledge_id), canonical: string(row.canonical_id), revision: integer(row.revision), status: string(row.status),
    title: typeof row.title === 'string' ? row.title : undefined };
}
function parseEvidence(data: unknown) {
  return parseList(data, (value) => {
    const row = record(value);
    return { id: string(row.evidence_id), document: string(row.document_id), revision: string(row.revision_id),
      status: string(row.status), source: typeof row.source_id === 'string' ? row.source_id : undefined, citation: typeof row.source_citation === 'string' ? row.source_citation : undefined };
  });
}
type Knowledge = ReturnType<typeof parseKnowledge>;

export function KnowledgePage() {
  return <T16Access scoped permission="knowledge.read">{(operations) => <KnowledgeView operations={operations} />}</T16Access>;
}

function KnowledgeView({ operations }: { operations: readonly string[] }) {
  const { t } = useLocale();
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [selected, select] = useState<Knowledge>();
  const list = useScopedSnapshot('listKnowledge', { q: query || undefined }, (value) => parseList(value, parseKnowledge));
  const results = list.data?.data;
  return <>
    <section className="card">
      <form className="actions" onSubmit={(event) => { event.preventDefault(); select(undefined); setQuery(filter.trim()); }}>
        <label>{t('learning.search')} <input type="search" maxLength={160} value={filter}
          onChange={(event) => setFilter(event.target.value)} /></label>
        <button type="submit">{t('learning.submitSearch')}</button>
      </form>
      {list.error && <LocalizedError code={asClientError(list.error).code} onRetry={() => { void list.refetch(); }} />}
      {results?.length === 0 && <p>{t(query ? 'learning.noMatches' : 'empty.knowledge')}</p>}
      {results?.length === 0 && !query && <div className="actions">
        <Link to="/settings/materials">{t('learning.connectSource')}</Link>
      </div>}
      {results && <ul>{results.map((item) => <li key={item.id}>
        <button type="button" aria-pressed={selected?.id === item.id} onClick={() => select(item)}>{item.title ?? item.id}</button>
      </li>)}</ul>}
    </section>
    {selected && <KnowledgeDetail key={selected.id} item={selected} operations={operations} />}
  </>;
}

function KnowledgeDetail({ item, operations }: { item: Knowledge; operations: readonly string[] }) {
  const { t } = useLocale();
  const [operation, setOperation] = useState<'edit_original' | 'supplement_knowledge'>();
  const [source, selectSource] = useState<{ id: string; revision: string }>();
  const origin = useScopedSnapshot('getSourceRevision', { id: source?.id ?? '', rev: source?.revision ?? '' }, (data) => {
    const value = record(data);
    return { revision: string(value.revision_id), path: string(value.relative_path) };
  }, { enabled: !!source });
  const evidence = useScopedSnapshot('getKnowledgeEvidence', { id: item.id }, parseEvidence);
  const original = useScopedSnapshot('getKnowledgeEditTarget', { id: item.id }, parseEditTarget, {
    enabled: operation === 'edit_original' && may(operations, 'edits.read'),
  });
  const target = original.data?.data;
  const payload = useMemo<EditRequest | null>(() => {
    if (operation === 'edit_original' && target &&
      evidence.data?.data.some((proof) => proof.document === target.document_id && (proof.status === 'supported' || proof.status === 'disputed'))) {
      return { operation, knowledge_id: item.id, document_id: target.document_id, vault_id: target.vault_id, expected_source_revision: target.observed_seq };
    }
    if (operation === 'supplement_knowledge') return {
      operation, knowledge_id: item.id, expected_knowledge_revision: item.revision, draft_key: crypto.randomUUID(),
    };
    return null;
  }, [operation, item.id, item.revision, target, evidence.data]);
  return <section className="card">
    <h2>{item.title ?? item.id}</h2>
    <p>{t('learning.revision')} <b>{item.revision}</b></p>
    {item.status === 'conflict' && <p role="status">{t('learning.conflict')}</p>}
    <h3>{t('learning.evidence')}</h3>
    {evidence.error && <LocalizedError code={asClientError(evidence.error).code} />}
    {evidence.data?.data.length === 0 && <p>{t('learning.noEvidence')}</p>}
    <ul>{evidence.data?.data.map((proof) => <li key={proof.id}>
      <code>{proof.document}</code>{' · '}<code>{proof.revision}</code>
      {proof.status === 'retracted' && <p>{t('learning.withdrawn')}</p>}
      {proof.status === 'disputed' && <p>{t('learning.conflict')}</p>}
      {proof.citation && <SafeMarkdown>{proof.citation}</SafeMarkdown>}
      {proof.source && (proof.status === 'supported' || proof.status === 'disputed') && may(operations, 'sources.read') &&
        <button type="button" onClick={() => selectSource({ id: proof.source!, revision: proof.revision })}>{t('learning.sourceLocation')}</button>}
    </li>)}</ul>
    {source && origin.data?.data.revision === source.revision && <p><code>{origin.data.data.path}</code></p>}
    {source && origin.error && <LocalizedError code={asClientError(origin.error).code} />}
    {may(operations, 'edits.write') && may(operations, 'edits.read') && <div className="actions">
      <button type="button" onClick={() => setOperation('edit_original')}>{t('edits.operation.edit_original')}</button>
      <button type="button" onClick={() => setOperation('supplement_knowledge')}>{t('edits.operation.supplement_knowledge')}</button>
    </div>}
    {operation && <EditDialog operation={operation} payload={payload} target={target} onClose={() => setOperation(undefined)} />}
  </section>;
}
