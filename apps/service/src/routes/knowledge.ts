import type { Context, Hono } from 'hono';
import { withDeferredTransaction, type SqliteDatabase } from '@patrick/storage';
import { queryEvidenceSnapshot } from '../../../../packages/domain/src/evidence.js';
import { snapshot, type Principal } from '../auth.js';
import { ApiError } from '../errors.js';
import { handle, requirePermission, routeId } from './http.js';
import { learningDomain, queryParameter, vaultRelativePath } from './learning-scope.js';

type Ready = () => { db: SqliteDatabase; now: () => Date };
type KnowledgeRow = { knowledge_id: string; canonical_id: string; revision: number; status: string };

export function mountKnowledgeRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/knowledge', (c) => handle(c, () => listKnowledge(c, ready)));
  app.get('/api/v1/knowledge/:id', (c) => handle(c, () => readKnowledge(c, ready)));
  app.get('/api/v1/knowledge/:id/evidence', (c) => handle(c, () => readEvidence(c, ready)));
  app.get('/api/v1/knowledge/:id/edit-target', (c) => handle(c, () => originalTarget(c, ready)));
  app.get('/api/v1/sources/:id/revisions/:rev', (c) => handle(c, () => sourceRevision(c, ready)));
}

async function listKnowledge(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'knowledge.read');
  const { db, now } = ready();
  const domain = learningDomain(db, principal, 'knowledge.read', queryParameter(c, 'domain'));
  const text = queryParameter(c, 'q')?.trim();
  const limitValue = queryParameter(c, 'limit');
  const limit = limitValue === undefined ? 50 : Number(limitValue);
  if ((text !== undefined && (text.length < 1 || text.length > 160)) ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ApiError(422, 'UNPROCESSABLE');
  const data = withDeferredTransaction(db, () => {
    if (!text) {
      const items = db.prepare(`SELECT knowledge_id,canonical_id,revision,status FROM knowledge_records
        WHERE account_id=? AND data_domain=? AND status<>'withdrawn' ORDER BY knowledge_id LIMIT ?`)
        .all(principal.account_id, domain, limit) as KnowledgeRow[];
      return { items };
    }
    const { epoch } = db.prepare('SELECT COALESCE(MAX(epoch),0) AS epoch FROM withdrawal_events WHERE data_domain=?')
      .get(domain) as { epoch: number };
    const pack = queryEvidenceSnapshot(db, { text, domain, withdrawalEpoch: epoch }, principal);
    const items = pack.items.slice(0, limit).map(({ knowledge_id, aliases }) => ({
      ...visibleKnowledge(db, principal, domain, knowledge_id), aliases,
    }));
    return { items };
  });
  return c.json(snapshot({ ...principal, domains: [domain] }, data, now(), db));
}

async function readKnowledge(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'knowledge.read');
  const { db, now } = ready();
  const domain = learningDomain(db, principal, 'knowledge.read', queryParameter(c, 'domain'));
  const row = visibleKnowledge(db, principal, domain, routeId(c.req.param('id')));
  return c.json(snapshot({ ...principal, domains: [domain] }, { ...row, data_domain: domain }, now(), db));
}

async function readEvidence(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'knowledge.read');
  const { db, now } = ready();
  const domain = learningDomain(db, principal, 'knowledge.read', queryParameter(c, 'domain'));
  const row = visibleKnowledge(db, principal, domain, routeId(c.req.param('id')));
  const items = db.prepare(`SELECT e.evidence_id,e.document_id,e.revision_id,e.status,v.source_id
    FROM evidence_refs e LEFT JOIN vault_revisions r ON r.revision_id=e.revision_id
      AND r.document_id=e.document_id AND r.account_id=? AND r.data_domain=e.data_domain
    LEFT JOIN vaults v ON v.vault_id=r.vault_id AND v.account_id=r.account_id AND v.data_domain=r.data_domain
    WHERE e.knowledge_id=? AND e.data_domain=? ORDER BY e.evidence_id`).all(principal.account_id, row.knowledge_id, domain);
  return c.json(snapshot({ ...principal, domains: [domain] }, { items }, now(), db));
}

async function originalTarget(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'edits.read');
  const { db, now } = ready();
  const domain = learningDomain(db, principal, 'edits.read', queryParameter(c, 'domain'));
  learningDomain(db, principal, 'knowledge.read', domain);
  const row = visibleKnowledge(db, principal, domain, routeId(c.req.param('id')));
  const document = queryParameter(c, 'document');
  const items = db.prepare(`SELECT d.document_id,d.observed_seq,d.relative_path,v.vault_id FROM vault_documents d
    JOIN vaults v ON v.vault_id=d.vault_id AND v.account_id=d.account_id AND v.data_domain=d.data_domain
    WHERE d.account_id=? AND d.data_domain=? AND d.knowledge_id=? AND d.kind='note' AND d.tombstone=0 AND d.parse_error IS NULL
      AND v.status='connected' AND d.relative_path NOT LIKE '知识笔记/补充/%' AND (? IS NULL OR d.document_id=?)
      AND EXISTS (SELECT 1 FROM vault_revisions r JOIN evidence_refs e ON e.revision_id=r.revision_id AND e.document_id=r.document_id
        WHERE r.vault_id=d.vault_id AND r.document_id=d.document_id AND r.observed_seq=d.observed_seq
          AND e.knowledge_id=d.knowledge_id AND e.data_domain=d.data_domain AND e.status IN ('supported','disputed'))
    ORDER BY d.document_id LIMIT 2`).all(principal.account_id, domain, row.knowledge_id, document ?? null, document ?? null) as {
    vault_id: string; document_id: string; observed_seq: number; relative_path: string;
  }[];
  const target = items[0];
  if (!target || items.length !== 1 || !vaultRelativePath(target.relative_path)) {
    throw new ApiError(409, 'CONFLICT', { reason: 'edit_target' });
  }
  return c.json(snapshot({ ...principal, domains: [domain] }, target, now(), db));
}

async function sourceRevision(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'sources.read');
  const { db, now } = ready();
  const domain = learningDomain(db, principal, 'sources.read', queryParameter(c, 'domain'));
  const row = db.prepare(`SELECT r.document_id,r.revision_id,r.observed_seq,r.relative_path,r.created_at
    FROM vault_revisions r JOIN vaults v ON v.vault_id=r.vault_id AND v.account_id=r.account_id AND v.data_domain=r.data_domain
    WHERE v.source_id=? AND r.revision_id=? AND r.account_id=? AND r.data_domain=? AND r.tombstone=0
      AND EXISTS (SELECT 1 FROM evidence_refs e JOIN knowledge_records k ON k.knowledge_id=e.knowledge_id
        WHERE e.revision_id=r.revision_id AND e.document_id=r.document_id AND e.data_domain=r.data_domain
          AND k.account_id=r.account_id AND k.data_domain=r.data_domain AND k.status<>'withdrawn' AND e.status IN ('supported','disputed'))`)
    .get(routeId(c.req.param('id')), routeId(c.req.param('rev')), principal.account_id, domain) as { relative_path: string } | undefined;
  if (!row || !vaultRelativePath(row.relative_path)) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return c.json(snapshot({ ...principal, domains: [domain] }, row, now(), db));
}

function visibleKnowledge(db: SqliteDatabase, principal: Principal, domain: string, id: string): KnowledgeRow {
  const row = db.prepare(`SELECT knowledge_id,canonical_id,revision,status FROM knowledge_records
    WHERE knowledge_id=? AND account_id=? AND data_domain=? AND status<>'withdrawn'`)
    .get(id, principal.account_id, domain) as KnowledgeRow | undefined;
  if (!row) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return row;
}
