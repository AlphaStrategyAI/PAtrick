import type { Context, Hono } from 'hono';
import type { SqliteDatabase } from '@patrick/storage';
import { snapshot } from '../auth.js';
import { ApiError } from '../errors.js';
import { handle, requirePermission, routeId } from './http.js';

type Ready = () => { db: SqliteDatabase; now: () => Date };

export function mountKnowledgeRoutes(app: Hono, ready: Ready): void {
  app.get('/api/v1/knowledge', (c) => handle(c, () => listKnowledge(c, ready)));
  app.get('/api/v1/knowledge/:id', (c) => handle(c, () => readKnowledge(c, ready)));
  app.get('/api/v1/knowledge/:id/evidence', (c) => handle(c, () => readEvidence(c, ready)));
}

async function listKnowledge(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'knowledge.read');
  const { db, now } = ready();
  const items = db.prepare(`SELECT knowledge_id, canonical_id, revision, status, data_domain FROM knowledge_records
    WHERE account_id = ? AND status != 'withdrawn' ORDER BY knowledge_id`).all(principal.account_id) as {
    knowledge_id: string;
    canonical_id: string;
    revision: number;
    status: string;
    data_domain: string;
  }[];
  const visible = items
    .filter((item) => principal.domains.includes(item.data_domain))
    .map((item) => ({ knowledge_id: item.knowledge_id, canonical_id: item.canonical_id, revision: item.revision, status: item.status }));
  return c.json(snapshot(principal, { items: visible }, now(), db));
}

async function readKnowledge(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'knowledge.read');
  const { db, now } = ready();
  const row = visibleKnowledge(db, principal.account_id, principal.domains, routeId(c.req.param('id')));
  return c.json(snapshot(principal, {
    knowledge_id: row.knowledge_id,
    canonical_id: row.canonical_id,
    revision: row.revision,
    status: row.status,
    data_domain: row.data_domain,
  }, now(), db));
}

async function readEvidence(c: Context, ready: Ready): Promise<Response> {
  const principal = await requirePermission(c.req.raw, 'knowledge.read');
  const { db, now } = ready();
  const row = visibleKnowledge(db, principal.account_id, principal.domains, routeId(c.req.param('id')));
  const items = db.prepare(`SELECT evidence_id, document_id, revision_id, status FROM evidence_refs
    WHERE knowledge_id = ? AND data_domain = ? ORDER BY evidence_id`).all(row.knowledge_id, row.data_domain);
  return c.json(snapshot(principal, { items }, now(), db));
}

function visibleKnowledge(db: SqliteDatabase, accountId: string, domains: readonly string[], knowledgeId: string) {
  const row = db.prepare(`SELECT knowledge_id, canonical_id, revision, status, data_domain FROM knowledge_records
    WHERE knowledge_id = ? AND account_id = ?`).get(knowledgeId, accountId) as {
    knowledge_id: string;
    canonical_id: string;
    revision: number;
    status: string;
    data_domain: string;
  } | undefined;
  if (!row || !domains.includes(row.data_domain)) throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' });
  return row;
}
