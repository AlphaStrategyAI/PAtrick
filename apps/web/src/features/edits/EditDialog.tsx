import type { Json } from '@patrick/contracts/envelope';
import { editIntentRequestSchema, editReceiptSchema } from '@patrick/contracts/resources';
import { useRef, useState } from 'react';
import { ClientError } from '../../api/client.js';
import { asClientError, useScopedSnapshot, useService } from '../../api/query.js';
import { Dialog, LocalizedError } from '../../components/shared.js';
import { useLocale } from '../../i18n/LocaleProvider.js';
import { EvaluationEvidence } from '../standards/EvaluationEvidence.js';
import { EditProgress } from './EditProgress.js';
import { integer, record, string } from './support.js';

export type EditRequest = ReturnType<typeof editIntentRequestSchema.parse>;
export type EditTarget = {
  vault_id: string; document_id: string; observed_seq: number; relative_path: string; obsidian_uri?: string;
};

export function parseEditTarget(value: unknown): EditTarget {
  const row = record(value);
  const path = string(row.relative_path);
  if (/[:\\\p{Cc}]/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ClientError('INVALID_RESPONSE');
  }
  let uri: string | undefined;
  if (typeof row.obsidian_uri === 'string') {
    const target = URL.parse(row.obsidian_uri);
    const vault = target?.searchParams.get('vault');
    if (target?.protocol === 'obsidian:' && target.host === 'open' && !target.pathname && !target.username && !target.password && !target.hash &&
      vault && !/[/\\:\p{Cc}]/u.test(vault) && target.searchParams.get('file') === path &&
      [...target.searchParams].length === 2) uri = target.href;
  }
  return { vault_id: string(row.vault_id), document_id: string(row.document_id), observed_seq: integer(row.observed_seq), relative_path: path, obsidian_uri: uri };
}

export function EditDialog({ operation, payload, target, onClose }: {
  operation: EditRequest['operation']; payload: EditRequest | null; target?: EditTarget; onClose: () => void;
}) {
  const { t } = useLocale();
  const { api } = useService();
  const [editId, setEditId] = useState('');
  const [error, setError] = useState<ClientError>();
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const request = useRef<{ id: string; payload: EditRequest } | null>(null);
  const receipt = useScopedSnapshot('getEdit', { id: editId }, editReceiptSchema.parse, { enabled: !!editId });
  const destination = useScopedSnapshot('getEditDestination', { id: editId }, parseEditTarget, { enabled: !!editId });
  const location = destination.data?.data ?? target;
  const read = receipt.data?.data;
  const retryRequest = useRef<{ id: string; revision: number; intentId: string; projectionRevision: number } | undefined>(undefined);
  const canRetry = read?.edit_id === editId && read?.business.state === 'adopted' && read.projection.state === 'failed' &&
    read.projection.intent_id !== null && read.projection.projection_revision !== null;

  async function retry() {
    if (!canRetry || locked.current || !read || read.projection.intent_id === null || read.projection.projection_revision === null) return;
    const revision = read.receipt_revision;
    const intentId = read.projection.intent_id;
    const projectionRevision = read.projection.projection_revision;
    if (!retryRequest.current || retryRequest.current.revision !== revision || retryRequest.current.intentId !== intentId ||
      retryRequest.current.projectionRevision !== projectionRevision) retryRequest.current = {
      id: crypto.randomUUID(), revision, intentId, projectionRevision,
    };
    locked.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.command('retryEditProjection', { id: editId }, {
        client_request_id: retryRequest.current.id, expected_revision: revision,
        payload: { expected_revision: revision, intent_id: intentId, projection_revision: projectionRevision },
      });
      if (result.receipt_url !== `/api/v1/edits/${editId}`) throw new ClientError('INVALID_RESPONSE');
      await receipt.refetch();
      retryRequest.current = undefined;
    } catch (cause) { setError(asClientError(cause)); }
    finally { locked.current = false; setBusy(false); }
  }

  const checkRequest = useRef<{ id: string; revision: number } | undefined>(undefined);
  async function check() {
    if (!read || read.edit_id !== editId || locked.current) return;
    if (!checkRequest.current || checkRequest.current.revision !== read.receipt_revision) {
      checkRequest.current = { id: crypto.randomUUID(), revision: read.receipt_revision };
    }
    locked.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.command('checkEdit', { id: editId }, {
        client_request_id: checkRequest.current.id, expected_revision: checkRequest.current.revision, payload: {},
      });
      if (result.receipt_url !== `/api/v1/edits/${editId}`) throw new ClientError('INVALID_RESPONSE');
      await receipt.refetch();
      checkRequest.current = undefined;
    } catch (cause) { setError(asClientError(cause)); }
    finally { locked.current = false; setBusy(false); }
  }

  async function register() {
    if (!payload || editId || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    const submitted = request.current ??= { id: crypto.randomUUID(), payload };
    try {
      const result = await api.command('createEdit', {}, {
        client_request_id: submitted.id, expected_revision: null, payload: submitted.payload as Json,
      });
      const match = /^\/api\/v1\/edits\/([A-Za-z0-9_-]+)$/.exec(result.receipt_url);
      if (!match) throw new ClientError('INVALID_RESPONSE');
      setEditId(match[1]);
    } catch (cause) { setError(asClientError(cause)); }
    finally { locked.current = false; setBusy(false); }
  }

  const actionPending = editId ? receipt.isFetching : busy;
  return <Dialog title={t(`edits.operation.${operation}`)} onClose={() => { if (!locked.current) onClose(); }}>
    <p>{t(`edits.preview.${operation}`)}</p>
    {location ? <p><code>{location.relative_path}</code></p> : <p className="muted">{t('edits.targetUnavailable')}</p>}
    {payload && <ScopeDetails request={payload} />}
    {error && <LocalizedError code={error.code} />}
    {receipt.error && <LocalizedError code={asClientError(receipt.error).code} />}
    {read && read.edit_id === editId && <>
      <EditProgress receipt={read} />
      {(operation === 'create_standard' || operation === 'revise_standard') && read.business.candidate_id && read.business.result_ref &&
        (read.business.state === 'adopted' || read.business.state === 'not_adopted') &&
        <EvaluationEvidence id={read.business.result_ref} candidate={read.business.candidate_id} />}
      {location?.obsidian_uri && read.file.state === 'awaiting_save' && <a className="primary" href={location.obsidian_uri}>{t('edits.openObsidian')}</a>}
      {canRetry
        ? <button type="button" disabled={busy} onClick={() => { void retry(); }}>{t('edits.retryProjection')}</button>
        : read.business.state === 'adopted' && read.projection.state === 'failed' && <p>{t('edits.retryUnavailable')}</p>}
      {read.business.state === 'stale' && <p>{t('edits.staleAction')}</p>}
      {read.file.state === 'conflict' && <p>{t('edits.conflictAction')}</p>}
      {location && (read.file.state === 'awaiting_save' || read.file.state === 'invalid') &&
        <button type="button" onClick={() => { void check(); }} disabled={busy}>{t('edits.check')}</button>}
      <p className="muted">{t('edits.receiptId')} <code>{read.edit_id}</code></p>
    </>}
    <div className="actions">
      {/* Keep the same focusable action while registration becomes a receipt read. */}
      {(editId || payload) && <button type="button" className={editId ? undefined : 'primary'}
        disabled={!editId && error?.code === 'CONFLICT'} aria-disabled={actionPending || undefined}
        style={actionPending ? { opacity: 0.6, cursor: 'default' } : undefined}
        onClick={() => {
          if (actionPending) return;
          if (editId) void receipt.refetch();
          else void register();
        }}>{t(editId ? 'edits.refresh' : 'edits.register')}</button>}
      <button type="button" disabled={busy} onClick={onClose}>{t('button.cancel')}</button>
    </div>
  </Dialog>;
}

function ScopeDetails({ request }: { request: EditRequest }) {
  const { t } = useLocale();
  return <dl className="edit-progress">
    {'knowledge_id' in request && <div><dt>{t('nav.knowledge')}</dt><dd>{request.knowledge_id}</dd></div>}
    {'document_id' in request && <div><dt>{t('learning.document')}</dt><dd>{request.document_id}</dd></div>}
    {'standard_id' in request && <div><dt>{t('nav.standards')}</dt><dd>{request.standard_id}</dd></div>}
    {'base_version' in request && <div><dt>{t('learning.revision')}</dt><dd>{request.base_version}</dd></div>}
    {'expected_knowledge_revision' in request && <div><dt>{t('learning.revision')}</dt><dd>{request.expected_knowledge_revision}</dd></div>}
    {'expected_source_revision' in request && <div><dt>{t('learning.revision')}</dt><dd>{request.expected_source_revision}</dd></div>}
  </dl>;
}
