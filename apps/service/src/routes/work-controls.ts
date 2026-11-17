import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { routes } from '@patrick/contracts';
import { appendDomainEvent, commandFingerprint, recordCommand, withDeferredTransaction, withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { createWorkControlApi, type WorkControlCommand, type WorkControlReceipt, type WorkControlState } from '../../../../packages/domain/src/work-control.js';
import { assertDomainPermission, domainsWithPermission, requireSession, snapshot } from '../auth.js';
import { assertBusinessWrite } from '../recovery-runtime.js';
import { ApiError } from '../errors.js';
import { assertPayloadHash, assertWriteOrigin, handle, readJson, routeId } from './http.js';
import { oneValue } from './work.js';
import { workStopDestination } from '../work-stop.js';

type Ready = () => { db: SqliteDatabase; now: () => Date };
type Work = { generation: number; data_domain: string; revision: number; control_state: Exclude<WorkControlState, 'denied'> };
const operation = 'controlWork';
const controlRequest = routes.find((entry) => entry.operationId === operation)!.request;

export function mountWorkControlRoutes(app: Hono, ready: Ready, stopAvailable: () => boolean = () => false): void {
  app.get('/api/v1/work/:id/controls', (c) => handle(c, () => readWorkControl(c, ready, stopAvailable())));
  app.get('/api/v1/work/:id/controls/:receiptId', (c) => handle(c, () => readControlReceipt(c, ready)));
  app.post('/api/v1/work/:id/controls', (c) => handle(c, () => controlWork(c, ready, stopAvailable)));
}

async function readWorkControl(c: Context, ready: Ready, canStop: boolean): Promise<Response> {
  const principal = await requireSession(c.req.raw);
  const workId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const domain = oneValue(new URL(c.req.url).searchParams, 'domain');
  return c.json(withDeferredTransaction(db, () => {
    const candidates = domainsWithPermission(db, principal, 'work.read');
    const visible = domain ? candidates.filter((item) => item === domain) : candidates;
    const work = db.prepare(`SELECT generation,data_domain,revision,control_state FROM work_generations
      WHERE work_id=? AND account_id=? AND data_domain IN (SELECT value FROM json_each(?))
      ORDER BY generation DESC LIMIT 1`).get(workId, principal.account_id, JSON.stringify(visible)) as Work | undefined;
    if (!work) deny();
    const permit = domainsWithPermission(db, principal, 'work.control').includes(work.data_domain);
    const actions: WorkControlCommand['type'][] = [];
    if (permit && work.control_state === 'running') actions.push('pause');
    if (permit && work.control_state === 'paused') actions.push('resume');
    if (permit && canStop && (work.control_state === 'running' || work.control_state === 'paused')) actions.push('stop');
    return snapshot({ ...principal, domains: [work.data_domain] }, {
      work_id: workId, generation: work.generation, control_revision: work.revision, state: work.control_state, actions,
    }, now(), db);
  }));
}

async function readControlReceipt(c: Context, ready: Ready): Promise<Response> {
  const principal = await requireSession(c.req.raw);
  const { db, now } = ready();
  const id = routeId(c.req.param('receiptId'));
  const workId = routeId(c.req.param('id'));
  const requested = oneValue(new URL(c.req.url).searchParams, 'domain');
  return c.json(withDeferredTransaction(db, () => {
    const row = db.prepare(`SELECT w.data_domain, r.receipt_id, r.work_id, r.generation, r.command_type AS type, r.state, r.revision
      FROM work_control_receipts r JOIN work_generations w ON w.work_id=r.work_id AND w.generation=r.generation AND w.account_id=r.account_id
      JOIN command_records c ON c.resource_id=r.receipt_id AND c.account_id=r.account_id AND c.data_domain=w.data_domain AND c.operation=?
      WHERE r.receipt_id=? AND r.work_id=? AND r.account_id=? AND c.caller_id=?`)
      .get(operation, id, workId, principal.account_id, principal.caller_id) as (WorkControlReceipt & { data_domain: string }) | undefined;
    if (!row || (requested && requested !== row.data_domain)) deny();
    assertDomainPermission(db, principal, row.data_domain, 'work.control');
    const { data_domain, ...receipt } = row;
    return snapshot({ ...principal, domains: [data_domain] }, receipt, now(), db);
  }));
}

async function controlWork(c: Context, ready: Ready, stopAvailable: () => boolean): Promise<Response> {
  assertWriteOrigin(c.req.raw);
  const parsed = controlRequest.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'schema' });
  const body = parsed.data as { client_request_id: string; expected_revision: number | null; payload_hash: string;
    payload: Pick<WorkControlCommand, 'type' | 'generation'> };
  if (body.expected_revision === null) throw new ApiError(422, 'UNPROCESSABLE', { reason: 'expected_revision' });
  assertPayloadHash(body.payload, body.payload_hash);
  const principal = await requireSession(c.req.raw);
  const workId = routeId(c.req.param('id'));
  const { db, now } = ready();
  const response = withImmediateTransaction(db, () => {
    const work = db.prepare(`SELECT generation,data_domain,revision,control_state FROM work_generations
      WHERE work_id=? AND generation=? AND account_id=?`).get(workId, body.payload.generation, principal.account_id) as Work | undefined;
    if (!work) deny();
    assertDomainPermission(db, principal, work.data_domain, 'work.control');
    const fingerprint = commandFingerprint({ operation, resource_id: workId, data_domain: work.data_domain,
      expected_revision: body.expected_revision, payload_hash: body.payload_hash });
    const existing = db.prepare(`SELECT i.command_id,i.command_fingerprint,c.resource_id FROM command_inbox i
      LEFT JOIN command_records c ON c.command_id=i.command_id AND c.operation=?
      WHERE i.account_id=? AND i.caller_id=? AND i.client_request_id=?`)
      .get(operation, principal.account_id, principal.caller_id, body.client_request_id) as
      { command_id: string; command_fingerprint: string; resource_id: string | null } | undefined;
    if (existing) {
      if (existing.command_fingerprint !== fingerprint || !existing.resource_id) throw new ApiError(409, 'CONFLICT', { reason: 'idempotency' });
      // Prior builds recorded the work ID only. Preserve their original URL on replay.
      return accepted(existing.command_id, workId, existing.resource_id === workId ? undefined : existing.resource_id);
    }
    const latest = db.prepare(`SELECT MAX(generation) AS generation FROM work_generations
      WHERE work_id=? AND account_id=? AND data_domain=?`).get(workId, principal.account_id, work.data_domain) as { generation: number };
    if (latest.generation !== work.generation) throw new ApiError(409, 'CONFLICT', { reason: 'generation' }, false, work.revision);
    if (work.revision !== body.expected_revision) throw new ApiError(409, 'CONFLICT', { reason: 'revision' }, false, work.revision);
    if (body.payload.type === 'stop') {
      if (!stopAvailable()) throw new ApiError(503, 'UNAVAILABLE', { reason: 'stop_supervisor' });
      if (work.control_state !== 'running' && work.control_state !== 'paused') throw new ApiError(409, 'CONFLICT', { reason: 'work_state' });
    }
    if (body.payload.type === 'resume') assertBusinessWrite(db, work.data_domain);
    // This synchronous port performs no side effect. The durable event and receipt commit together below.
    const localStop = { submit() {}, read: () => ({ process_tree_stopped: false, effects_reconciled: false }) };
    const receipt = createWorkControlApi(db, principal, { now, stopPort: localStop })
      .applyWorkControlNow(principal, { ...body.payload, work_id: workId, expected_revision: work.revision });
    const createdAt = now().toISOString();
    if (body.payload.type === 'resume') {
      const current = db.prepare('SELECT data_domain FROM work_generations WHERE work_id=? AND generation=?')
        .get(workId, work.generation) as { data_domain: string };
      assertDomainPermission(db, principal, current.data_domain, 'work.control');
      assertBusinessWrite(db, current.data_domain);
      if (current.data_domain !== work.data_domain) throw new ApiError(409, 'CONFLICT', { reason: 'scope' });
    }
    const command = recordCommand(db, { account_id: principal.account_id, caller_id: principal.caller_id,
      client_request_id: body.client_request_id, command_fingerprint: fingerprint, command_id: randomUUID() });
    db.prepare(`INSERT INTO command_records(command_id,account_id,caller_id,operation,resource_id,data_domain,permission,created_at)
      VALUES (?,?,?,?,?,?,'work.control',?)`).run(command.command_id, principal.account_id, principal.caller_id, operation, receipt.receipt_id,
        work.data_domain, createdAt);
    if (receipt.type === 'stop') appendDomainEvent(db, {
      eventId: 'work.stop:' + receipt.receipt_id,
      aggregateId: workId, aggregateVersion: work.generation, accountId: principal.account_id, dataDomain: work.data_domain,
      destination: workStopDestination, payload: { type: 'work.stop.requested', receipt_id: receipt.receipt_id },
    });
    return accepted(command.command_id, workId, receipt.receipt_id);
  });
  return c.json(response, 202);
}

function accepted(id: string, workId: string, receiptId?: string) {
  const base = '/api/v1/work/' + encodeURIComponent(workId);
  return { command_id: id, state: 'received' as const,
    receipt_url: receiptId ? base + '/controls/' + encodeURIComponent(receiptId) : base };
}

function deny(): never { throw new ApiError(403, 'FORBIDDEN', { reason: 'scope' }); }
