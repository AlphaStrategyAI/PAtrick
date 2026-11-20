import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { SqliteDatabase } from '@patrick/storage';

/**
 * The restricted RPC that owns the domain.
 *
 * The bundle tools never take a database connection: they call these methods
 * over a local, token bound endpoint. The executor that holds the domain owns
 * the endpoint, so a tool call is scoped exactly like the work it belongs to.
 */

export type HarnessRpcPrincipal = {
  account_id: string;
  domains: readonly string[];
};

export type HarnessRpcInput = {
  db: SqliteDatabase;
  principal: HarnessRpcPrincipal;
  now: () => Date;
};

export type HarnessRpc = {
  handle(method: string, params: Record<string, unknown>): Promise<unknown>;
};

export function createHarnessRpc(input: HarnessRpcInput): HarnessRpc {
  return {
    async handle(method, params) {
      if (method === 'evidence.query') return evidenceQuery(input, params);
      if (method === 'judgment.read') return judgmentRead(input, params);
      if (method === 'budget.next') return budgetNext(input, params);
      throw new Error('UNKNOWN_METHOD');
    },
  };
}

/** The evidence a knowledge item may still use at the given withdrawal epoch. */
function evidenceQuery(input: HarnessRpcInput, params: Record<string, unknown>) {
  const domain = String(params.domain ?? '');
  const knowledgeId = String(params.knowledgeId ?? '');
  const withdrawalEpoch = Number(params.withdrawalEpoch ?? 0);
  if (!input.principal.domains.includes(domain)) throw new Error('FORBIDDEN');
  if (!knowledgeId || !Number.isSafeInteger(withdrawalEpoch) || withdrawalEpoch < 0) throw new Error('UNPROCESSABLE');
  const rows = input.db.prepare('SELECT evidence_id, document_id, revision_id, status FROM evidence_refs '
    + 'WHERE knowledge_id=? AND data_domain=? AND (withdrawal_epoch IS NULL OR withdrawal_epoch<=?)').all(
    knowledgeId, domain, withdrawalEpoch) as { evidence_id: string; document_id: string | null;
      revision_id: string | null; status: string }[];
  return rows.map((row) => ({ evidence_id: row.evidence_id, document_id: row.document_id,
    revision_id: row.revision_id, status: row.status }));
}

/** The frozen judgment basis of a work generation. */
function judgmentRead(input: HarnessRpcInput, params: Record<string, unknown>) {
  const workId = String(params.workId ?? '');
  const generation = Number(params.generation ?? 0);
  if (!workId || !Number.isSafeInteger(generation) || generation < 0) throw new Error('UNPROCESSABLE');
  const row = input.db.prepare('SELECT b.work_id, b.generation, b.basis_hash, b.evidence_watermark, g.data_domain '
    + 'FROM judgment_bases b JOIN work_generations g ON g.work_id=b.work_id AND g.generation=b.generation '
    + 'WHERE b.work_id=? AND b.generation=? AND g.account_id=?').get(
    workId, generation, input.principal.account_id) as {
    work_id: string; generation: number; basis_hash: string; evidence_watermark: number; data_domain: string;
  } | undefined;
  if (!row) throw new Error('NOT_FOUND');
  if (!input.principal.domains.includes(row.data_domain)) throw new Error('FORBIDDEN');
  return { work_id: row.work_id, generation: row.generation, hash: row.basis_hash,
    evidence_watermark: row.evidence_watermark };
}

/**
 * The budget of the next paid call.
 *
 * The budget bridge is owned by the runtime that holds the grants. Without a
 * reservation the call is refused instead of being faked.
 */
function budgetNext(input: HarnessRpcInput, params: Record<string, unknown>) {
  const grantId = String(params.grantId ?? '');
  const attemptId = String(params.attemptId ?? '');
  const routeId = String(params.routeId ?? '');
  if (!grantId || !attemptId || !routeId) throw new Error('UNPROCESSABLE');
  const grant = input.db.prepare('SELECT grant_id, subject_kind, attempt_id, expires_at FROM execution_grants '
    + 'WHERE grant_id=?').get(grantId) as { grant_id: string; subject_kind: string; attempt_id: string;
    expires_at: string } | undefined;
  if (!grant) throw new Error('NOT_FOUND');
  if (grant.attempt_id !== attemptId) throw new Error('FORBIDDEN');
  if (grant.expires_at <= input.now().toISOString()) throw new Error('DENIED');
  const reservation = input.db.prepare('SELECT reservation_id, status FROM budget_reservations '
    + 'WHERE grant_id=? AND attempt_id=? AND route_id=? ORDER BY reservation_id DESC LIMIT 1').get(
    grantId, attemptId, routeId) as { reservation_id: string; status: string } | undefined;
  return { claim: reservation?.status === 'settled' ? 'already_dispatched' : 'denied', sent: false,
    settled: reservation?.status === 'settled' ? 'settled' : 'none', outbound: 0 };
}

/** Serves the restricted RPC on the loopback interface for one backend. */
export async function startHarnessRpcServer(input: HarnessRpcInput): Promise<{
  url: string; token: string; close(): Promise<void>;
}> {
  const rpc = createHarnessRpc(input);
  const token = randomBytes(24).toString('hex');
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'FORBIDDEN' } }));
        return;
      }
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string;
            params?: Record<string, unknown> };
          const result = await rpc.handle(body.method, body.params ?? {});
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ result }));
        } catch (error) {
          response.writeHead(409, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HARNESS_RPC_LISTEN_FAILED');
  return {
    url: `http://127.0.0.1:${address.port}/rpc`,
    token,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The hash of a route, so a receipt can name it without the secret. */
export function harnessRouteHash(url: string, token: string): string {
  return createHash('sha256').update(`${url}\0${token}`).digest('hex');
}
