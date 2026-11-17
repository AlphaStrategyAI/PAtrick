import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { canonicalPayload, type Json } from '../../packages/contracts/src/envelope.js';
import {
  CLAIM_DISPATCH_SQL,
  RESERVE_BUDGET_SQL,
  createBudgetApi,
  type BudgetReceipt,
  type CallReservation,
} from '../../packages/domain/src/budget.js';
import {
  createDelegationApi,
  type AdmissionPrincipal,
  type ExecutionGrant,
} from '../../packages/domain/src/delegation.js';
import { createStopFixture, createWorkControlApi, type StopFixture } from '../../packages/domain/src/work-control.js';
import { createApp } from '../../apps/service/src/app.js';
import { issueBootstrapTicket, issueCallerSession, ORIGIN, RP_ID } from '../../apps/service/src/auth.js';
import { createCredentialStore } from '../../packages/host/src/credentials.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';

const NOW = '2026-11-16T12:00:00.000Z';
const DOMAIN = 'product';
const MIGRATIONS = fileURLToPath(new URL('../../packages/storage/migrations/', import.meta.url));
const PREVIOUS = {
  '0002_core.sql': '6e82bac75d455f28dc498874b61d0d778e1552b4bc5a8d1b5d7f5dfddfc06233',
  '0003_auth_control.sql': '3767d19a3f6c65f5ddae4f5f7d65a057082bfc978fec2d7e7a7a347f4cf2487f',
  '0004_hub_work.sql': 'bcd83075a607244bf5e5ee89efc621d0dd7670e42ace2b5884874ee8047dbcbe',
  '0005_sources.sql': '8bd6d4ee8e06b94247d314030acaf0b312b635a8fccdc457267afdfdc3c22f29',
  '0006_vault_evidence.sql': '320c91d5935e2586a28aee0ba9a5e5a94eb0ee2036931244b9674ad09782f2f1',
  '0007_standards.sql': '32426e2501210cc250603f7e6dd64f3b8d56cd0225bef2f684be717c6e7559d7',
} as const;

const principal: AdmissionPrincipal = {
  account_id: 'owner',
  caller_id: 'web',
  auth_epoch: 1,
  domains: [DOMAIN],
  operations: ['owner', 'work.control', 'delegations.read'],
};

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function temporaryDatabase(): { dir: string; databasePath: string; db: SqliteDatabase; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t08-'));
  const databasePath = join(dir, 'patrick.sqlite');
  const db = openDatabase(databasePath);
  return {
    dir,
    databasePath,
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function clock(start = NOW) {
  let current = new Date(start);
  return {
    now: () => new Date(current.getTime()),
    set(iso: string) {
      current = new Date(iso);
    },
  };
}

type Clock = ReturnType<typeof clock>;

function apis(db: SqliteDatabase, time: Clock = clock(), stopPort: StopFixture = createStopFixture()) {
  const delegation = createDelegationApi(db, principal, { now: time.now, domain: DOMAIN });
  const budget = createBudgetApi(db, principal, { now: time.now });
  const controls = createWorkControlApi(db, principal, { now: time.now, stopPort });
  return { delegation, budget, controls, time, stopPort };
}

async function admitRunningWork(
  db: SqliteDatabase,
  options: { budget?: number; workId?: string; generation?: number; time?: Clock; stopPort?: StopFixture } = {},
) {
  const budgetMicros = options.budget ?? 5000;
  const workId = options.workId ?? 'work-1';
  const generation = options.generation ?? 2;
  const kit = apis(db, options.time, options.stopPort);
  await kit.delegation.registerMandateType({
    type_id: 'type-judge',
    actions: ['judge', 'collect', 'publish_pr'],
    resources: ['work'],
    effects: ['publish_pr'],
    domains: [DOMAIN],
    risk: 'low',
    level: 'L1',
    budget_micros: budgetMicros,
    config_version: 1,
  });
  const mandate = await kit.delegation.openMandate({
    mandate_id: `mandate-${workId}`,
    type_id: 'type-judge',
    actions: ['judge', 'collect', 'publish_pr'],
    resources: ['work'],
    effects: ['publish_pr'],
    domains: [DOMAIN],
    risk: 'low',
    level: 'L1',
    budget_micros: budgetMicros,
    expires_at: '2027-01-01T00:00:00.000Z',
  });
  await kit.delegation.setCapability({
    profile_id: `cap-${workId}`,
    level: 'L2',
    actions: ['judge', 'collect', 'publish_pr', 'deploy'],
    report_id: 'report-1',
    report_version: 1,
    config_version: 1,
  });
  await kit.delegation.ensureJudgmentPolicy();
  await kit.delegation.openWork({
    work_id: workId,
    generation,
    mandate_id: mandate.mandate_id,
    phase: 'judgment',
    next_action: 'judge',
    budget_micros: budgetMicros,
  });
  const grant = await kit.delegation.authorizeAction({
    work_id: workId,
    generation,
    attempt_id: 'attempt-1',
    phase: 'judgment',
    next_action: 'judge',
    allowed_effects: [],
    expires_at: '2026-11-17T00:00:00.000Z',
  });
  return { ...kit, grant, mandate, workId, generation, budgetMicros };
}

function callFor(grant: ExecutionGrant, routeId: string, callId: string, amountMicros: number): CallReservation {
  return {
    businessId: `work:${grant.work_id}`,
    grantId: grant.grant_id,
    attemptId: grant.attempt_id,
    routeId,
    callId,
    amountMicros,
  };
}

function budgetRow(db: SqliteDatabase, businessId: string) {
  const row = db.prepare('SELECT limit_micros, held_micros, spent_micros FROM business_budgets WHERE business_id = ?').get(businessId) as {
    limit_micros: number;
    held_micros: number;
    spent_micros: number;
  } | undefined;
  if (!row) throw new Error(`missing budget ${businessId}`);
  return row;
}

test('two calls compete for the last 5000 micros and the winner keeps one dispatch permit', async () => {
  const fx = temporaryDatabase();
  try {
    const admitted = await admitRunningWork(fx.db);
    const { budget, delegation, grant } = admitted;
    const reserveCall = (input: CallReservation) => budget.reserveCall(input);
    const claimPaidDispatch = (
      reservationId: string,
      grantId: string,
      attemptId: string,
      routeId: string,
    ) => budget.claimPaidDispatch(reservationId, grantId, attemptId, routeId);
    const heldAmount = (businessId: string) => budget.heldAmount(businessId);
    const activeGrantCount = (workId: string, generation: number) => delegation.activeGrantCount(workId, generation);
    const callA = callFor(grant, 'route-a', 'call-a', 5000);
    const callB = callFor(grant, 'route-b', 'call-b', 5000);

    const results = await Promise.allSettled([reserveCall(callA), reserveCall(callB)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await heldAmount('work:work-1')).toBe(5000);
    expect(await activeGrantCount('work-1', 2)).toBe(1);
    const winner = results.find((result): result is PromiseFulfilledResult<BudgetReceipt> => result.status === 'fulfilled');
    if (!winner) throw new Error('missing winner');
    const winningCall = winner.value.call_id === callA.callId ? callA : callB;
    const held = await reserveCall(winningCall);
    expect(held.reservation_id).toBe(winner.value.reservation_id);
    expect(held.amount_micros).toBe(5000);
    const claims = await Promise.all([
      claimPaidDispatch(held.reservation_id, winningCall.grantId, winningCall.attemptId, winningCall.routeId),
      claimPaidDispatch(held.reservation_id, winningCall.grantId, winningCall.attemptId, winningCall.routeId),
    ]);
    expect(claims.sort()).toEqual(['acquired', 'already_dispatched']);
    expect(await heldAmount('work:work-1')).toBe(5000);
    expect(await activeGrantCount('work-1', 2)).toBe(1);
    const dispatched = fx.db.prepare('SELECT COUNT(*) AS n FROM budget_reservations WHERE dispatched_at IS NOT NULL').get() as { n: number };
    expect(dispatched.n).toBe(1);
  } finally {
    fx.close();
  }
});

test('a fractional amount is rejected and the budget stays on integer micros', async () => {
  const fx = temporaryDatabase();
  try {
    const { budget, grant } = await admitRunningWork(fx.db);
    await expect(budget.reserveCall({ ...callFor(grant, 'route-a', 'call-fraction', 5000), amountMicros: 5000.5 })).rejects.toThrow('UNPROCESSABLE');
    expect(budgetRow(fx.db, 'work:work-1')).toEqual({ limit_micros: 5000, held_micros: 0, spent_micros: 0 });
  } finally {
    fx.close();
  }
});

test('expired, old-attempt, and revoked claims do not dispatch, and revocation stays in scope', async () => {
  const fx = temporaryDatabase();
  try {
    const time = clock();
    const { budget, delegation, grant } = await admitRunningWork(fx.db, { budget: 9000, time });
    const expired = await budget.reserveCall(callFor(grant, 'route-expire', 'call-expire', 1000));
    const stale = await budget.reserveCall(callFor(grant, 'route-stale', 'call-stale', 1000));
    const revoked = await budget.reserveCall(callFor(grant, 'route-revoke', 'call-revoke', 1000));
    time.set('2026-11-18T00:00:00.000Z');
    expect(await budget.claimPaidDispatch(expired.reservation_id, grant.grant_id, grant.attempt_id, 'route-expire')).toBe('denied');
    time.set(NOW);
    expect(await budget.claimPaidDispatch(stale.reservation_id, grant.grant_id, 'attempt-0', 'route-stale')).toBe('denied');
    await delegation.revokeGrant(grant.grant_id);
    expect(await budget.claimPaidDispatch(revoked.reservation_id, grant.grant_id, grant.attempt_id, 'route-revoke')).toBe('denied');
    const marked = fx.db.prepare('SELECT COUNT(*) AS n FROM budget_reservations WHERE dispatched_at IS NOT NULL').get() as { n: number };
    expect(marked.n).toBe(0);

    await delegation.openConsultation({
      request_id: 'req-scope',
      caller_id: 'web',
      parent_work_id: 'work-1',
      result_version: 4,
      domains: [DOMAIN],
      tools: ['patrick_memory_query'],
      deadline_at: '2026-11-20T00:00:00.000Z',
      budget_micros: 2000,
      permission_revision: 1,
    });
    const consultation = await delegation.authorizeConsultation('req-scope', 'attempt-c');
    const reserved = await budget.reserveCall({
      businessId: 'consultation:req-scope',
      grantId: consultation.grant_id,
      attemptId: consultation.attempt_id,
      routeId: 'route-consult',
      callId: 'call-consult',
      amountMicros: 1000,
    });
    expect(await budget.claimPaidDispatch(reserved.reservation_id, consultation.grant_id, consultation.attempt_id, 'route-consult')).toBe('acquired');
    expect(budgetRow(fx.db, 'work:work-1').held_micros).toBe(3000);
    expect(budgetRow(fx.db, 'consultation:req-scope').held_micros).toBe(1000);
  } finally {
    fx.close();
  }
});

test('a crash after the permit and missing usage keep the reservation on the same cumulative limit', async () => {
  const fx = temporaryDatabase();
  try {
    const time = clock();
    const admitted = await admitRunningWork(fx.db, { budget: 5000, time });
    const { budget, delegation, grant } = admitted;
    const basis = grant.basis_hash;
    const reserved = await budget.reserveCall(callFor(grant, 'route-crash', 'call-crash', 5000));
    expect(await budget.claimPaidDispatch(reserved.reservation_id, grant.grant_id, grant.attempt_id, 'route-crash')).toBe('acquired');
    const crashed = fx.db.prepare('SELECT status, dispatched_at FROM budget_reservations WHERE reservation_id = ?').get(reserved.reservation_id) as {
      status: string;
      dispatched_at: string | null;
    };
    expect(crashed.status).toBe('held');
    expect(crashed.dispatched_at).not.toBeNull();
    expect(budgetRow(fx.db, 'work:work-1')).toEqual({ limit_micros: 5000, held_micros: 5000, spent_micros: 0 });

    await delegation.noteAttemptFinished('work-1', 2);
    await expect(delegation.authorizeAction({
      work_id: 'work-1',
      generation: 2,
      attempt_id: 'attempt-2',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-17T00:00:00.000Z',
    })).rejects.toThrow('DENIED');
    fx.db.prepare(`UPDATE work_generations
      SET process_tree_stopped = 1, effects_reconciled = 0
      WHERE work_id = 'work-1' AND generation = 2`).run();
    await expect(delegation.authorizeAction({
      work_id: 'work-1',
      generation: 2,
      attempt_id: 'attempt-2',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-17T00:00:00.000Z',
    })).rejects.toThrow('DENIED');
    fx.db.prepare(`UPDATE work_generations
      SET effects_reconciled = 1, control_state = 'stopped', attempt_closed = 1
      WHERE work_id = 'work-1' AND generation = 2`).run();
    const next = await delegation.authorizeAction({
      work_id: 'work-1',
      generation: 2,
      attempt_id: 'attempt-2',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-17T00:00:00.000Z',
    });
    expect(next.grant_id).not.toBe(grant.grant_id);
    expect(next.basis_hash).toBe(basis);
    expect(await delegation.activeGrantCount('work-1', 2)).toBe(1);
    await expect(budget.reserveCall(callFor(next, 'route-next', 'call-next', 5000))).rejects.toThrow('BUDGET_EXHAUSTED');
    expect(budgetRow(fx.db, 'work:work-1')).toEqual({ limit_micros: 5000, held_micros: 5000, spent_micros: 0 });

    const uncertain = await budget.settleCall(reserved.reservation_id, null);
    expect(uncertain.status).toBe('uncertain');
    expect(uncertain.reservation_id).toBe(reserved.reservation_id);
    expect(uncertain.amount_micros).toBe(5000);
    expect(budgetRow(fx.db, 'work:work-1')).toEqual({ limit_micros: 5000, held_micros: 5000, spent_micros: 0 });
    const totals = budgetRow(fx.db, 'work:work-1');
    expect(totals.held_micros + totals.spent_micros).toBe(totals.limit_micros);
  } finally {
    fx.close();
  }
});

test('settled usage is unique and a later attempt keeps the spent total', async () => {
  const fx = temporaryDatabase();
  try {
    const { budget, delegation, grant } = await admitRunningWork(fx.db, { budget: 9000 });
    const reserved = await budget.reserveCall(callFor(grant, 'route-use', 'call-use', 4000));
    expect(await budget.claimPaidDispatch(reserved.reservation_id, grant.grant_id, grant.attempt_id, 'route-use')).toBe('acquired');
    const usage = { usage_id: 'usage-1', amount_micros: 4000, proof: 'meter:usage-1' };
    const settled = await budget.settleCall(reserved.reservation_id, usage);
    expect(settled.status).toBe('settled');
    expect(await budget.settleCall(reserved.reservation_id, usage)).toEqual(settled);
    await expect(budget.settleCall(reserved.reservation_id, { ...usage, usage_id: 'usage-2', proof: 'meter:usage-2' })).rejects.toThrow('CONFLICT');
    expect(budgetRow(fx.db, 'work:work-1')).toEqual({ limit_micros: 9000, held_micros: 0, spent_micros: 4000 });

    await delegation.noteAttemptFinished('work-1', 2);
    fx.db.prepare(`UPDATE work_generations
      SET process_tree_stopped = 1, effects_reconciled = 1, control_state = 'stopped', attempt_closed = 1
      WHERE work_id = 'work-1' AND generation = 2`).run();
    const next = await delegation.authorizeAction({
      work_id: 'work-1',
      generation: 2,
      attempt_id: 'attempt-2',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-17T00:00:00.000Z',
    });
    const again = await budget.reserveCall(callFor(next, 'route-again', 'call-again', 5000));
    expect(again.status).toBe('held');
    await expect(budget.reserveCall(callFor(next, 'route-over', 'call-over', 5000))).rejects.toThrow('BUDGET_EXHAUSTED');
    expect(budgetRow(fx.db, 'work:work-1')).toEqual({ limit_micros: 9000, held_micros: 5000, spent_micros: 4000 });
  } finally {
    fx.close();
  }
});

test('pause blocks dispatch, resume rechecks the delegation, and stop stays processing', async () => {
  const fx = temporaryDatabase();
  try {
    const admitted = await admitRunningWork(fx.db);
    const { budget, controls, delegation, grant, stopPort } = admitted;
    const reserved = await budget.reserveCall(callFor(grant, 'route-pause', 'call-pause', 1000));
    const paused = await controls.applyWorkControl(principal, {
      work_id: 'work-1',
      type: 'pause',
      generation: 2,
      expected_revision: 0,
    });
    expect(paused.state).toBe('paused');
    await expect(delegation.authorizeAction({
      work_id: 'work-1',
      generation: 2,
      attempt_id: 'attempt-9',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-17T00:00:00.000Z',
    })).rejects.toThrow('DENIED');
    expect(await budget.claimPaidDispatch(reserved.reservation_id, grant.grant_id, grant.attempt_id, 'route-pause')).toBe('denied');
    expect(fx.db.prepare('SELECT dispatched_at FROM budget_reservations WHERE reservation_id = ?').get(reserved.reservation_id)).toEqual({
      dispatched_at: null,
    });
    const resumed = await controls.applyWorkControl(principal, {
      work_id: 'work-1',
      type: 'resume',
      generation: 2,
      expected_revision: paused.revision,
    });
    expect(resumed.state).toBe('running');
    expect(await budget.claimPaidDispatch(reserved.reservation_id, grant.grant_id, grant.attempt_id, 'route-pause')).toBe('acquired');

    await delegation.pauseMandate(admitted.mandate.mandate_id);
    const denied = await controls.applyWorkControl(principal, {
      work_id: 'work-1',
      type: 'pause',
      generation: 2,
      expected_revision: resumed.revision,
    });
    const blocked = await controls.applyWorkControl(principal, {
      work_id: 'work-1',
      type: 'resume',
      generation: 2,
      expected_revision: denied.revision,
    });
    expect(blocked.state).toBe('denied');
    expect(fx.db.prepare('SELECT control_state FROM work_generations WHERE work_id = ? AND generation = ?').get('work-1', 2)).toEqual({
      control_state: 'paused',
    });

    await delegation.resumeMandate(admitted.mandate.mandate_id);
    const running = await controls.applyWorkControl(principal, {
      work_id: 'work-1',
      type: 'resume',
      generation: 2,
      expected_revision: denied.revision,
    });
    expect(running.state).toBe('running');
    const stopping = await controls.applyWorkControl(principal, {
      work_id: 'work-1',
      type: 'stop',
      generation: 2,
      expected_revision: running.revision,
    });
    expect(stopping.state).toBe('processing');
    stopPort.report('work-1', 2, { process_tree_stopped: true });
    expect((await controls.syncStop('work-1', 2)).state).toBe('processing');
    expect(fx.db.prepare('SELECT control_state, process_tree_stopped, effects_reconciled FROM work_generations WHERE work_id = ?').get('work-1')).toEqual({
      control_state: 'processing',
      process_tree_stopped: 1,
      effects_reconciled: 0,
    });
    stopPort.report('work-1', 2, { effects_reconciled: true });
    expect((await controls.syncStop('work-1', 2)).state).toBe('stopped');
    expect(fx.db.prepare(`SELECT control_state, process_tree_stopped, effects_reconciled, attempt_closed
      FROM work_generations WHERE work_id = ?`).get('work-1')).toEqual({
      control_state: 'stopped',
      process_tree_stopped: 1,
      effects_reconciled: 1,
      attempt_closed: 1,
    });
  } finally {
    fx.close();
  }
});

test('resume is denied while a stop is in progress or after it completes', async () => {
  const fx = temporaryDatabase();
  try {
    const admitted = await admitRunningWork(fx.db);
    const { budget, controls, grant, stopPort } = admitted;
    const reserved = await budget.reserveCall(callFor(grant, 'route-stop-resume', 'call-stop-resume', 1000));
    const running = await controls.applyWorkControl(principal, {
      work_id: 'work-1',
      type: 'resume',
      generation: 2,
      expected_revision: 0,
    });
    expect(running.state).toBe('denied');

    const stopping = await controls.applyWorkControl(principal, {
      work_id: 'work-1',
      type: 'stop',
      generation: 2,
      expected_revision: 0,
    });
    expect(stopping.state).toBe('processing');

    const deniedWhileStopping = await controls.applyWorkControl(principal, {
      work_id: 'work-1',
      type: 'resume',
      generation: 2,
      expected_revision: stopping.revision,
    });
    expect(deniedWhileStopping.state).toBe('denied');
    expect(fx.db.prepare('SELECT control_state FROM work_generations WHERE work_id = ? AND generation = ?').get('work-1', 2)).toEqual({
      control_state: 'processing',
    });
    expect(await budget.claimPaidDispatch(reserved.reservation_id, grant.grant_id, grant.attempt_id, 'route-stop-resume')).toBe('denied');

    stopPort.report('work-1', 2, { process_tree_stopped: true, effects_reconciled: true });
    expect((await controls.syncStop('work-1', 2)).state).toBe('stopped');
    expect(fx.db.prepare('SELECT control_state FROM work_generations WHERE work_id = ? AND generation = ?').get('work-1', 2)).toEqual({
      control_state: 'stopped',
    });

    const deniedAfterStop = await controls.applyWorkControl(principal, {
      work_id: 'work-1',
      type: 'resume',
      generation: 2,
      expected_revision: stopping.revision,
    });
    expect(deniedAfterStop.state).toBe('denied');
    expect(fx.db.prepare('SELECT control_state FROM work_generations WHERE work_id = ? AND generation = ?').get('work-1', 2)).toEqual({
      control_state: 'stopped',
    });
  } finally {
    fx.close();
  }
});

test('consultation stays inside its grant, and maintenance cannot authorize a business effect', async () => {
  const fx = temporaryDatabase();
  try {
    const parent = await admitRunningWork(fx.db, { budget: 4000, workId: 'work-parent', generation: 1 });
    const { delegation, budget } = parent;
    await delegation.setWorkGate('work-parent', 1, { awaiting_answer: true });
    await delegation.openWork({
      work_id: 'work-other',
      generation: 1,
      mandate_id: parent.mandate.mandate_id,
      phase: 'judgment',
      next_action: 'judge',
      budget_micros: 4000,
    });
    const beforeParent = await delegation.activeGrantCount('work-parent', 1);
    await delegation.openConsultation({
      request_id: 'req-1',
      caller_id: 'web',
      parent_work_id: 'work-parent',
      result_version: 7,
      domains: [DOMAIN],
      tools: ['patrick_memory_query'],
      deadline_at: '2026-11-20T00:00:00.000Z',
      budget_micros: 3000,
      permission_revision: 2,
    });
    const consultation = await delegation.authorizeConsultation('req-1', 'attempt-c');
    expect(consultation.subject_kind).toBe('consultation');
    expect(consultation.allowed_effects).toEqual([]);
    expect(consultation.request_id).toBe('req-1');
    expect(consultation.result_version).toBe(7);
    expect(consultation.caller_id).toBe('web');
    expect(consultation.allowed_domains).toEqual([DOMAIN]);
    expect(consultation.readonly_tools).toEqual(['patrick_memory_query']);
    expect(consultation.parent_work_id).toBe('work-parent');
    expect(await delegation.authorizeConsultation('req-1', 'attempt-c')).toEqual(consultation);
    await expect(delegation.authorizeAction({
      work_id: 'work-parent',
      generation: 1,
      attempt_id: 'attempt-blocked',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-17T00:00:00.000Z',
    })).rejects.toThrow('DENIED');
    const other = await delegation.authorizeAction({
      work_id: 'work-other',
      generation: 1,
      attempt_id: 'attempt-other',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-17T00:00:00.000Z',
    });
    expect(other.subject_kind).toBe('work');
    expect(await delegation.activeGrantCount('work-parent', 1)).toBe(beforeParent);
    expect(await delegation.activeGrantCount('work-other', 1)).toBe(1);
    const consultHold = await budget.reserveCall({
      businessId: 'consultation:req-1',
      grantId: consultation.grant_id,
      attemptId: consultation.attempt_id,
      routeId: 'route-c',
      callId: 'call-c',
      amountMicros: 1200,
    });
    expect(budgetRow(fx.db, 'work:work-parent').held_micros).toBe(0);
    expect(budgetRow(fx.db, 'work:work-other').held_micros).toBe(0);
    expect(consultHold.held_micros).toBe(1200);
    expect(fx.db.prepare('SELECT control_state FROM work_generations WHERE work_id = ?').get('work-other')).toEqual({
      control_state: 'running',
    });
    expect(await delegation.authorizeBusinessEffect(consultation, { work_id: 'work-other', generation: 1, action: 'publish_pr' })).toBe(false);
    expect(delegation.canWriteConsultationAnswer(consultation, 'req-1')).toBe(true);

    await delegation.cancelConsultation('req-1');
    expect(await budget.claimPaidDispatch(consultHold.reservation_id, consultation.grant_id, consultation.attempt_id, 'route-c')).toBe('denied');
    expect(fx.db.prepare('SELECT dispatched_at FROM budget_reservations WHERE reservation_id = ?').get(consultHold.reservation_id)).toEqual({
      dispatched_at: null,
    });

    await delegation.openConsultation({
      request_id: 'req-permission',
      caller_id: 'web',
      parent_work_id: null,
      result_version: 1,
      domains: [DOMAIN],
      tools: ['patrick_memory_query'],
      deadline_at: '2026-11-20T00:00:00.000Z',
      budget_micros: 1000,
      permission_revision: 1,
    });
    const permissionGrant = await delegation.authorizeConsultation('req-permission', 'attempt-p');
    const permissionHold = await budget.reserveCall({
      businessId: 'consultation:req-permission',
      grantId: permissionGrant.grant_id,
      attemptId: permissionGrant.attempt_id,
      routeId: 'route-p',
      callId: 'call-p',
      amountMicros: 100,
    });
    await delegation.setConsultationPermission('req-permission', 2);
    expect(await budget.claimPaidDispatch(permissionHold.reservation_id, permissionGrant.grant_id, permissionGrant.attempt_id, 'route-p')).toBe('denied');

    await delegation.openConsultation({
      request_id: 'req-deadline',
      caller_id: 'web',
      parent_work_id: null,
      result_version: 1,
      domains: [DOMAIN],
      tools: ['patrick_memory_query'],
      deadline_at: '2026-11-20T00:00:00.000Z',
      budget_micros: 1000,
      permission_revision: 1,
    });
    const deadlineGrant = await delegation.authorizeConsultation('req-deadline', 'attempt-d');
    const deadlineHold = await budget.reserveCall({
      businessId: 'consultation:req-deadline',
      grantId: deadlineGrant.grant_id,
      attemptId: deadlineGrant.attempt_id,
      routeId: 'route-d',
      callId: 'call-d',
      amountMicros: 100,
    });
    parent.time.set('2026-11-21T00:00:00.000Z');
    expect(await budget.claimPaidDispatch(deadlineHold.reservation_id, deadlineGrant.grant_id, deadlineGrant.attempt_id, 'route-d')).toBe('denied');
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM budget_reservations WHERE reservation_id IN (?, ?) AND dispatched_at IS NOT NULL').get(
      permissionHold.reservation_id,
      deadlineHold.reservation_id,
    )).toEqual({ n: 0 });

    await delegation.openMaintenance({
      job_id: 'job-eval',
      owner_id: 'owner',
      kind: 'standard_evaluation',
      budget_micros: 1500,
      result_ref: 'result:job-eval',
      expires_at: '2026-12-01T00:00:00.000Z',
    });
    await delegation.openMaintenance({
      job_id: 'job-ui',
      owner_id: 'owner',
      kind: 'ui_translation',
      budget_micros: 800,
      result_ref: 'result:job-ui',
      expires_at: '2026-12-01T00:00:00.000Z',
    });
    await expect(delegation.openMaintenance({
      job_id: 'job-bad',
      owner_id: 'owner',
      kind: 'deploy',
      budget_micros: 100,
      result_ref: 'result:bad',
      expires_at: '2026-12-01T00:00:00.000Z',
    })).rejects.toThrow('UNPROCESSABLE');
    const maintenance = await delegation.authorizeMaintenance('owner', 'job-eval', 'attempt-m');
    expect(maintenance.subject_kind).toBe('maintenance');
    expect(maintenance.allowed_effects).toEqual([]);
    expect(maintenance.owner_id).toBe('owner');
    expect(maintenance.kind).toBe('standard_evaluation');
    expect(maintenance.result_ref).toBe('result:job-eval');
    const translation = await delegation.authorizeMaintenance('owner', 'job-ui', 'attempt-ui');
    expect(translation.kind).toBe('ui_translation');
    expect(translation.allowed_effects).toEqual([]);
    expect(await delegation.authorizeBusinessEffect(maintenance, { work_id: 'work-other', generation: 1, action: 'publish_pr' })).toBe(false);
    expect(delegation.canWriteConsultationAnswer(maintenance, 'req-1')).toBe(false);
    const maintHold = await budget.reserveCall({
      businessId: 'maintenance:job-eval',
      grantId: maintenance.grant_id,
      attemptId: maintenance.attempt_id,
      routeId: 'route-m',
      callId: 'call-m',
      amountMicros: 500,
    });
    expect(budgetRow(fx.db, 'work:work-other').held_micros).toBe(0);
    expect(maintHold.held_micros).toBe(500);
    await delegation.cancelMaintenance('job-eval');
    expect(await budget.claimPaidDispatch(maintHold.reservation_id, maintenance.grant_id, maintenance.attempt_id, 'route-m')).toBe('denied');
    expect(fx.db.prepare('SELECT dispatched_at FROM budget_reservations WHERE reservation_id = ?').get(maintHold.reservation_id)).toEqual({
      dispatched_at: null,
    });
    await expect(delegation.authorizeMaintenance('other-owner', 'job-ui', 'attempt-x')).rejects.toThrow('FORBIDDEN');
  } finally {
    fx.close();
  }
});

test('evidence collection is limited to the named collection and delivery requires evidence_ready', async () => {
  const fx = temporaryDatabase();
  try {
    const { delegation, grant } = await admitRunningWork(fx.db, { budget: 2000 });
    expect(grant.basis_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(grant.allowed_effects).toEqual([]);
    expect(grant.next_action).toBe('judge');
    const frozen = fx.db.prepare('SELECT basis_hash FROM judgment_bases WHERE work_id = ? AND generation = ?').get('work-1', 2) as {
      basis_hash: string;
    };
    expect(grant.basis_hash).toBe(frozen.basis_hash);
    expect(await delegation.authorizeAction({
      work_id: 'work-1',
      generation: 2,
      attempt_id: 'attempt-1',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-17T00:00:00.000Z',
    })).toEqual(grant);
    await expect(delegation.authorizeAction({
      work_id: 'work-1',
      generation: 2,
      attempt_id: 'attempt-1',
      phase: 'judgment',
      next_action: 'deploy',
      allowed_effects: [],
      expires_at: '2026-11-17T00:00:00.000Z',
    })).rejects.toThrow('DENIED');

    await delegation.setWorkGate('work-1', 2, { phase: 'collect_evidence', collection_id: 'collection-9' });
    await expect(delegation.authorizeAction({
      work_id: 'work-1',
      generation: 2,
      attempt_id: 'attempt-collect-wide',
      phase: 'collect_evidence',
      next_action: 'collect:collection-9',
      allowed_effects: ['collect:collection-9', 'publish_pr'],
      collection_id: 'collection-9',
      expires_at: '2026-11-17T00:00:00.000Z',
    })).rejects.toThrow('DENIED');
    expect(await delegation.activeGrantCount('work-1', 2)).toBe(1);
    const collection = await reissue(delegation, {
      phase: 'collect_evidence',
      next_action: 'collect:collection-9',
      allowed_effects: ['collect:collection-9'],
      collection_id: 'collection-9',
    });
    expect(collection.allowed_effects).toEqual(['collect:collection-9']);
    expect(collection.collection_id).toBe('collection-9');
    expect(await delegation.authorizeBusinessEffect(collection, { work_id: 'work-1', generation: 2, action: 'publish_pr' })).toBe(false);
    expect(await delegation.authorizeBusinessEffect(collection, { work_id: 'work-1', generation: 2, action: 'collect:collection-9' })).toBe(true);
    expect(await delegation.authorizeBusinessEffect(collection, { work_id: 'work-1', generation: 9, action: 'collect:collection-9' })).toBe(false);

    await delegation.setWorkGate('work-1', 2, { phase: 'delivery', evidence_ready: false });
    await expect(delegation.authorizeAction({
      work_id: 'work-1',
      generation: 2,
      attempt_id: 'attempt-delivery-early',
      phase: 'delivery',
      next_action: 'publish_pr',
      allowed_effects: ['publish_pr'],
      expires_at: '2026-11-17T00:00:00.000Z',
    })).rejects.toThrow('DENIED');
    expect(await delegation.activeGrantCount('work-1', 2)).toBe(1);
    await delegation.setWorkGate('work-1', 2, { phase: 'delivery', evidence_ready: true });
    const delivery = await reissue(delegation, {
      phase: 'delivery',
      next_action: 'publish_pr',
      allowed_effects: ['publish_pr'],
      collection_id: null,
    });
    expect(delivery.phase).toBe('delivery');
    expect(await delegation.authorizeBusinessEffect(delivery, { work_id: 'work-1', generation: 2, action: 'publish_pr' })).toBe(true);
    expect(await delegation.activeGrantCount('work-1', 2)).toBe(1);

    fx.db.prepare(`UPDATE evaluation_policies SET external_method_revision = '2026.2' WHERE data_domain = ?`).run(DOMAIN);
    const same = await delegation.authorizeAction({
      work_id: 'work-1',
      generation: 2,
      attempt_id: delivery.attempt_id,
      phase: 'delivery',
      next_action: 'publish_pr',
      allowed_effects: ['publish_pr'],
      expires_at: '2026-11-17T00:00:00.000Z',
    });
    expect(same.basis_hash).toBe(grant.basis_hash);
    await delegation.openWork({
      work_id: 'work-new',
      generation: 1,
      mandate_id: 'mandate-work-1',
      phase: 'judgment',
      next_action: 'judge',
      budget_micros: 2000,
    });
    const newer = await delegation.authorizeAction({
      work_id: 'work-new',
      generation: 1,
      attempt_id: 'attempt-new',
      phase: 'judgment',
      next_action: 'judge',
      allowed_effects: [],
      expires_at: '2026-11-17T00:00:00.000Z',
    });
    expect(newer.basis_hash).not.toBe(grant.basis_hash);
  } finally {
    fx.close();
  }
});

async function reissue(
  delegation: ReturnType<typeof createDelegationApi>,
  input: {
    phase: 'judgment' | 'collect_evidence' | 'delivery';
    next_action: string;
    allowed_effects: string[];
    collection_id: string | null;
  },
): Promise<ExecutionGrant> {
  const current = await delegation.activeWorkGrant('work-1', 2);
  if (!current) throw new Error('missing grant');
  await delegation.revokeGrant(current.grant_id);
  return delegation.authorizeAction({
    work_id: 'work-1',
    generation: 2,
    attempt_id: `attempt-${input.phase}`,
    phase: input.phase,
    next_action: input.next_action,
    allowed_effects: input.allowed_effects,
    collection_id: input.collection_id,
    expires_at: '2026-11-17T00:00:00.000Z',
  });
}

test('a withdrawn judgment dependency blocks the next undispatched claim', async () => {
  const fx = temporaryDatabase();
  try {
    const { budget, delegation, dbGrant } = await standardWork(fx.db);
    const reserved = await budget.reserveCall(callFor(dbGrant, 'route-withdraw', 'call-withdraw', 500));
    fx.db.prepare(`INSERT INTO withdrawal_events (
      event_id, data_domain, target_kind, target_id, target_version, epoch, reason, created_at
    ) VALUES ('withdraw:standard:std-gate:1', ?, 'standard', 'std-gate', 1, 1, '依赖撤回', ?)`).run(DOMAIN, NOW);
    expect(await budget.claimPaidDispatch(reserved.reservation_id, dbGrant.grant_id, dbGrant.attempt_id, 'route-withdraw')).toBe('denied');
    expect(fx.db.prepare('SELECT dispatched_at FROM budget_reservations WHERE reservation_id = ?').get(reserved.reservation_id)).toEqual({
      dispatched_at: null,
    });
    expect(await delegation.activeGrantCount('work-1', 2)).toBe(1);
  } finally {
    fx.close();
  }
});

async function standardWork(db: SqliteDatabase) {
  const kit = await admitRunningWork(db, { budget: 2000 });
  db.prepare(`INSERT INTO standards (
    standard_id, account_id, data_domain, active_version, revision, schema_version, created_at, updated_at
  ) VALUES ('std-gate', 'owner', ?, 1, 1, '1.0', ?, ?)`).run(DOMAIN, NOW, NOW);
  await kit.delegation.revokeGrant(kit.grant.grant_id);
  db.prepare('DELETE FROM judgment_bases WHERE work_id = ? AND generation = ?').run('work-1', 2);
  db.prepare('DELETE FROM evidence_dependencies WHERE from_kind = ? AND from_id = ?').run('work', 'work-1');
  const dbGrant = await kit.delegation.authorizeAction({
    work_id: 'work-1',
    generation: 2,
    attempt_id: 'attempt-std',
    phase: 'judgment',
    next_action: 'judge',
    allowed_effects: [],
    expires_at: '2026-11-17T00:00:00.000Z',
  });
  expect(dbGrant.basis_hash).not.toBe(kit.grant.basis_hash);
  const basis = db.prepare('SELECT standards_json, evidence_watermark FROM judgment_bases WHERE work_id = ? AND generation = ?').get('work-1', 2) as {
    standards_json: string;
    evidence_watermark: number;
  };
  expect(JSON.parse(basis.standards_json)).toEqual([{ standard_id: 'std-gate', standard_version: 1 }]);
  expect(basis.evidence_watermark).toBe(0);
  return { ...kit, dbGrant };
}

test('commands return 202 and delegation reads return the snapshot envelope', async () => {
  const fx = temporaryDatabase();
  try {
    const admitted = await admitRunningWork(fx.db);
    const credentialDirectory = join(fx.dir, 'credentials');
    const app = createApp({ databasePath: fx.databasePath, credentialDirectory, now: () => new Date(NOW) });
    issueBootstrapTicket(fx.db, { accountId: 'owner' }, () => new Date(NOW));
    const store = createCredentialStore(credentialDirectory, () => new Date(NOW));
    const session = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'web',
      domain: DOMAIN,
      permissions: ['owner', 'work.control', 'delegations.read'],
    }, () => new Date(NOW), store);
    const headers = { authorization: session.authorization, origin: ORIGIN, 'content-type': 'application/json' };
    const proposal = {
      type_id: 'type-judge',
      actions: ['judge'],
      resources: ['work'],
      effects: [],
      domains: [DOMAIN],
      risk: 'low',
      level: 'L1',
      budget_micros: 1000,
      expires_at: '2027-01-01T00:00:00.000Z',
    };
    const post = (path: string, payload: Json, revision: number | null) => app.request(path, {
      method: 'POST', headers, body: JSON.stringify(envelope(path, path, revision, payload)),
    });
    async function challenge() {
      const response = await app.request('/api/v1/auth/challenge', {
        method: 'POST', headers, body: JSON.stringify({ rp_id: RP_ID }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { challenge_id: string }).challenge_id;
    }
    async function prepared(url: string) {
      const response = await app.request(url, { headers });
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: { proposal_id: string; proposal_hash: string; base_revision: number; mandate_id: string } }).data;
    }
    async function confirm(stage: Awaited<ReturnType<typeof prepared>>, challengeId: string) {
      const response = await post(`/api/v1/control-proposals/${stage.proposal_id}/confirm`,
        { proposal_hash: stage.proposal_hash, challenge_id: challengeId }, stage.base_revision);
      expect(response.status).toBe(202);
      const accepted = await response.json() as { receipt_url: string };
      const command = await app.request(accepted.receipt_url, { headers });
      expect(command.status).toBe(200);
      return ((await command.json()) as { data: { control_receipt_id: string } }).data.control_receipt_id;
    }

    const challengeId = await challenge();
    const stagedPayload = { ...proposal, challenge_id: challengeId };
    const proposalBody = envelope('createDelegationProposal', 'type-judge', null, stagedPayload);
    const stage = () => app.request('/api/v1/delegation-proposals', { method: 'POST', headers, body: JSON.stringify(proposalBody) });
    const created = await stage();
    expect(created.status).toBe(202);
    const createdBody = await created.json() as { command_id: string; state: string; receipt_url: string };
    expect(createdBody.state).toBe('received');
    expect(createdBody.receipt_url).toContain('/api/v1/delegation-proposals/');
    expect(await (await stage()).json()).toEqual(createdBody);
    const staged = await prepared(createdBody.receipt_url);
    const mandateId = staged.mandate_id;
    const applyPath = `/api/v1/delegation-proposals/${staged.proposal_id}/apply`;
    expect(fx.db.prepare('SELECT 1 FROM mandates WHERE mandate_id=?').get(mandateId)).toBeUndefined();
    expect((await post(applyPath, { control_receipt_id: 'unconfirmed' }, null)).status).toBe(403);
    expect(fx.db.prepare('SELECT 1 FROM mandates WHERE mandate_id=?').get(mandateId)).toBeUndefined();
    const receipt = await confirm(staged, challengeId);
    expect(fx.db.prepare('SELECT 1 FROM mandates WHERE mandate_id=?').get(mandateId)).toBeUndefined();
    const applyBody = envelope('applyDelegationProposal', staged.proposal_id, null, { control_receipt_id: receipt });
    const apply = () => app.request(applyPath, { method: 'POST', headers, body: JSON.stringify(applyBody) });
    const applied = await apply();
    expect(applied.status).toBe(202);
    expect(await (await apply()).json()).toEqual(await applied.json());

    const listed = await app.request('/api/v1/delegations', { headers: { authorization: session.authorization } });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      schema_version: string;
      scope: { account_id: string; data_domain: string; permission_epoch: number };
      as_of: string;
      watermark: { hub_seq: number; domain_seq: number };
      freshness: string;
      data: { items: Array<{ mandate_id: string; status: string }> };
    };
    expect(listedBody.schema_version).toBe('1.0');
    expect(listedBody.scope).toEqual({ account_id: 'owner', data_domain: DOMAIN, permission_epoch: 1 });
    expect(listedBody.freshness).toBe('fresh');
    expect(listedBody.watermark.hub_seq).toBe(0);
    expect(listedBody.watermark.domain_seq).toBeGreaterThanOrEqual(0);
    expect(listedBody.data.items.map((item) => item.mandate_id).sort()).toEqual(['mandate-work-1', mandateId].sort());
    const one = await app.request(`/api/v1/delegations/${mandateId}`, { headers: { authorization: session.authorization } });
    expect(one.status).toBe(200);
    const oneBody = await one.json() as { data: { mandate_id: string; status: string; budget_micros: number } };
    expect(oneBody.data).toMatchObject({ mandate_id: mandateId, status: 'active', budget_micros: 1000, resources: ['work'] });

    const controlPath = `/api/v1/delegations/${mandateId}/controls`;
    expect((await post(controlPath, { type: 'pause' }, 0)).status).toBe(422);
    const pauseChallenge = await challenge();
    const pauseStage = await post(controlPath, { type: 'pause', challenge_id: pauseChallenge }, 0);
    expect(pauseStage.status).toBe(202);
    const pauseUrl = ((await pauseStage.json()) as { receipt_url: string }).receipt_url;
    const paused = await prepared(pauseUrl);
    const applyPause = `/api/v1/delegation-proposals/${paused.proposal_id}/apply`;
    expect((await post(applyPause, { control_receipt_id: receipt }, 0)).status).toBe(403);
    expect(fx.db.prepare('SELECT status,revision FROM mandates WHERE mandate_id=?').get(mandateId))
      .toEqual({ status: 'active', revision: 0 });
    const stopChallenge = await challenge();
    const stopStage = await post(controlPath, { type: 'stop', challenge_id: stopChallenge }, 0);
    expect(stopStage.status).toBe(202);
    const stopped = await prepared(((await stopStage.json()) as { receipt_url: string }).receipt_url);
    const staleStopReceipt = await confirm(stopped, stopChallenge);
    const pauseReceipt = await confirm(paused, pauseChallenge);
    const pauseBody = envelope('applyDelegationProposal', paused.proposal_id, 0, { control_receipt_id: pauseReceipt });
    const applyOnce = () => app.request(applyPause, { method: 'POST', headers, body: JSON.stringify(pauseBody) });
    const firstPause = await applyOnce();
    expect(firstPause.status).toBe(202);
    expect(await (await applyOnce()).json()).toEqual(await firstPause.json());
    expect((await post(applyPause, { control_receipt_id: pauseReceipt }, 0)).status).toBe(409);
    const afterPause = await app.request(`/api/v1/delegations/${mandateId}`, { headers: { authorization: session.authorization } });
    expect((await afterPause.json() as { data: { status: string; revision: number } }).data)
      .toMatchObject({ status: 'paused', revision: 1 });

    expect((await post(`/api/v1/delegation-proposals/${stopped.proposal_id}/apply`,
      { control_receipt_id: staleStopReceipt }, 0)).status).toBe(409);
    expect(fx.db.prepare('SELECT status,revision FROM mandates WHERE mandate_id=?').get(mandateId))
      .toEqual({ status: 'paused', revision: 1 });

    const over = await post('/api/v1/delegation-proposals',
      { ...proposal, budget_micros: 9000, challenge_id: await challenge() }, null);
    expect(over.status).toBe(422);

    const workPause = await app.request('/api/v1/work/work-1/controls', {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope('controlWork', 'work-1', 0, { type: 'pause', generation: 2 })),
    });
    expect(workPause.status).toBe(202);
    expect(await workPause.json()).toMatchObject({ state: 'received' });
    expect(fx.db.prepare('SELECT control_state FROM work_generations WHERE work_id = ? AND generation = ?').get('work-1', 2)).toEqual({
      control_state: 'paused',
    });
    const workStop = await app.request('/api/v1/work/work-1/controls', {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope('controlWork', 'work-1', 1, { type: 'stop', generation: 2 })),
    });
    expect(workStop.status).toBe(503);
    expect(fx.db.prepare('SELECT control_state, process_tree_stopped, effects_reconciled FROM work_generations WHERE work_id = ?').get('work-1')).toEqual({
      control_state: 'paused',
      process_tree_stopped: 0,
      effects_reconciled: 0,
    });

    const reader = issueCallerSession(fx.db, {
      accountId: 'owner',
      callerId: 'reader',
      domain: DOMAIN,
      permissions: ['delegations.read'],
    }, () => new Date(NOW), store);
    const forbidden = await app.request('/api/v1/work/work-1/controls', {
      method: 'POST',
      headers: { authorization: reader.authorization, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(envelope('controlWork', 'work-1', 2, { type: 'pause', generation: 2 })),
    });
    expect(forbidden.status).toBe(403);
    expect(admitted.grant.grant_id).toMatch(/.+/);
  } finally {
    fx.close();
  }
});

test('the admission migration appends without changing earlier files', () => {
  const manifest = JSON.parse(readFileSync(join(MIGRATIONS, 'manifest.json'), 'utf8')) as { file: string; sha256: string }[];
  expect(manifest.map((entry) => entry.file)).toEqual([
    '0002_core.sql',
    '0003_auth_control.sql',
    '0004_hub_work.sql',
    '0005_sources.sql',
    '0006_vault_evidence.sql',
    '0007_standards.sql',
    '0008_admission_budget.sql',
    '0010_answers_channels.sql',
    '0011_conversations.sql',
    '0012_effects_outcomes.sql',
    '0013_views.sql',
    '0017_settings.sql',
    '0018_delegation_control.sql',
    '0019_stats.sql',
    '0020_http_sources.sql',
  ]);
  for (const [file, hash] of Object.entries(PREVIOUS)) {
    expect(manifest.find((entry) => entry.file === file)?.sha256).toBe(hash);
    expect(sha256(readFileSync(join(MIGRATIONS, file)))).toBe(hash);
  }
  const admissionHash = sha256(readFileSync(join(MIGRATIONS, '0008_admission_budget.sql')));
  expect(manifest[6]?.sha256).toBe(admissionHash);
  const sql = readFileSync(join(MIGRATIONS, '0008_admission_budget.sql'), 'utf8');
  expect(sql).toContain(`CREATE UNIQUE INDEX one_active_work_grant
ON execution_grants(work_id, generation) WHERE subject_kind = 'work' AND revoked_at IS NULL;`);
  expect(sql).toContain(`CREATE UNIQUE INDEX one_active_consultation_grant
ON execution_grants(request_id) WHERE subject_kind = 'consultation' AND revoked_at IS NULL;`);
  expect(RESERVE_BUDGET_SQL).toBe(`UPDATE business_budgets
SET held_micros = held_micros + @amount
WHERE business_id = @business_id AND @amount >= 0
  AND held_micros + spent_micros + @amount <= limit_micros
RETURNING held_micros;`);
  expect(CLAIM_DISPATCH_SQL).toBe(`UPDATE budget_reservations SET dispatched_at = @now
WHERE reservation_id = @reservation_id AND grant_id = @grant_id
  AND attempt_id = @attempt_id AND route_id = @route_id
  AND status = 'held' AND dispatched_at IS NULL
RETURNING reservation_id;`);
  const budgetSource = readFileSync(fileURLToPath(new URL('../../packages/domain/src/budget.ts', import.meta.url)), 'utf8');
  expect(budgetSource).toContain('withImmediateTransaction');
  expect(budgetSource).toContain('RESERVE_BUDGET_SQL');
  expect(budgetSource).toContain('CLAIM_DISPATCH_SQL');
  const delegationSource = readFileSync(fileURLToPath(new URL('../../packages/domain/src/delegation.ts', import.meta.url)), 'utf8');
  expect(delegationSource).toContain('freezeJudgmentBasis');
  const controlSource = readFileSync(fileURLToPath(new URL('../../packages/domain/src/work-control.ts', import.meta.url)), 'utf8');
  expect(controlSource).not.toContain('child_process');
  expect(controlSource).not.toContain('spawn');
  const fx = temporaryDatabase();
  try {
    expect(fx.db.prepare('SELECT file, sha256 FROM schema_migrations ORDER BY position').all()).toEqual(manifest);
    expect(() => fx.db.prepare(`INSERT INTO execution_grants (
      grant_id, subject_kind, account_id, data_domain, work_id, generation, request_id, result_version,
      job_id, owner_id, caller_id, attempt_id, mandate_id, next_action, allowed_effects_json,
      allowed_domains_json, readonly_tools_json, basis_hash, phase, collection_id, scope_hash,
      permission_revision, kind, result_ref, expires_at, revoked_at, schema_version, created_at
    ) VALUES (
      'bad-subject', 'work', 'owner', 'product', 'work-x', 1, 'req-x', NULL,
      NULL, NULL, 'web', 'attempt', 'mandate', 'judge', '[]',
      '[]', '[]', '${'a'.repeat(64)}', 'judgment', NULL, '${'b'.repeat(64)}',
      0, NULL, NULL,       '2026-11-17T00:00:00.000Z', NULL, '1.0', '2026-11-16T12:00:00.000Z'
    )`).run()).toThrow();
    fx.db.prepare(`INSERT INTO mandate_types (
      type_id, account_id, data_domain, actions_json, resources_json, effects_json, domains_json, risk, level,
      budget_micros, config_version, schema_version, created_at
    ) VALUES ('type-open', 'owner', 'product', '[]', '[]', '[]', '[]', 'low', 'L0', 0, 1, '1.0', ?)`).run(NOW);
    fx.db.prepare(`INSERT INTO mandates (
      mandate_id, type_id, account_id, data_domain, status, actions_json, resources_json, effects_json, domains_json,
      risk, level, budget_micros, expires_at, revision, scope_hash, config_version, schema_version, created_at, updated_at
    ) VALUES ('mandate-open', 'type-open', 'owner', 'product', 'active', '[]', '[]', '[]', '[]', 'low', 'L0', 0,
      '2027-01-01T00:00:00.000Z', 0, ?, 1, '1.0', ?, ?)`).run('c'.repeat(64), NOW, NOW);
    const grantSql = `INSERT INTO execution_grants (
      grant_id, subject_kind, account_id, data_domain, work_id, generation, request_id, result_version,
      job_id, owner_id, caller_id, attempt_id, mandate_id, next_action, allowed_effects_json,
      allowed_domains_json, readonly_tools_json, basis_hash, phase, collection_id, scope_hash,
      permission_revision, kind, result_ref, expires_at, revoked_at, schema_version, created_at
    ) VALUES (?, 'work', 'owner', 'product', 'work-open', 1, NULL, NULL, NULL, NULL, 'web', 'attempt', 'mandate-open',
      'judge', '[]', '[]', '[]', ?, 'judgment', NULL, ?, 0, NULL, NULL, '2026-11-17T00:00:00.000Z', ?, '1.0', ?)`;
    fx.db.prepare(grantSql).run('grant-open', 'd'.repeat(64), 'e'.repeat(64), null, NOW);
    expect(() => fx.db.prepare(grantSql).run('grant-open-2', 'd'.repeat(64), 'e'.repeat(64), null, NOW)).toThrow();
    fx.db.prepare(`UPDATE execution_grants SET revoked_at = ? WHERE grant_id = 'grant-open'`).run(NOW);
    fx.db.prepare(grantSql).run('grant-open-3', 'd'.repeat(64), 'e'.repeat(64), null, NOW);
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM execution_grants
      WHERE work_id = 'work-open' AND generation = 1 AND subject_kind = 'work' AND revoked_at IS NULL`).get()).toEqual({ n: 1 });
  } finally {
    fx.close();
  }
});

function envelope(operation: string, resourceId: string, expectedRevision: number | null, payload: Json) {
  const payloadHash = sha256(canonicalPayload(payload));
  return {
    client_request_id: `${operation}-${resourceId}-${randomUUID()}`,
    expected_revision: expectedRevision,
    payload_hash: payloadHash,
    payload,
  };
}
