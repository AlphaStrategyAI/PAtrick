import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createDelegationApi, type AdmissionPrincipal, type RunGrant } from '../../packages/domain/src/delegation.js';
import * as command from '../../packages/executor/src/command.js';
import { runAttempt, type FrozenRun, type RunReceipt } from '../../packages/executor/src/wrapper.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';
import { createRecoveryRuntimeGate } from '../../packages/storage/src/recovery-gate.js';

const preparation = vi.hoisted(() => ({ close: undefined as (() => void | Promise<void>) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    realpath: async (...args: Parameters<typeof original.realpath>) => {
      const result = await original.realpath(...args);
      await preparation.close?.();
      return result;
    },
  };
});

const NOW = '2026-11-16T12:00:00.000Z';
const DOMAIN = 'product';
const OTHER = 'personal';
const principal: AdmissionPrincipal = {
  account_id: 'owner', caller_id: 'service', auth_epoch: 1,
  domains: [DOMAIN, OTHER], operations: ['owner'],
};
type Runtime = { db: SqliteDatabase; principal: AdmissionPrincipal; now: () => Date };
const invoke = runAttempt;
const cleanups: Array<() => void> = [];
afterEach(() => {
  preparation.close = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture(kind: 'judgment' | 'collect_evidence' | 'delivery' | 'consultation' = 'judgment') {
  const root = mkdtempSync(join(tmpdir(), 'patrick-t22-executor-'));
  const location = join(root, 'state.sqlite');
  const db = openDatabase(location);
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare("INSERT INTO accounts VALUES ('owner',1,1,?)").run(NOW);
  const now = () => new Date(NOW);
  const delegation = createDelegationApi(db, principal, { domain: DOMAIN, now });
  const scope = {
    actions: ['judge', 'collect', 'publish_pr'], effects: ['publish_pr'], resources: ['work'],
    domains: [DOMAIN], risk: 'low', level: 'L1' as const, budget_micros: 0,
  };
  await delegation.registerMandateType({ ...scope, type_id: 'type', config_version: 1 });
  await delegation.openMandate({ ...scope, type_id: 'type', mandate_id: 'mandate', expires_at: '2027-01-01' });
  await delegation.setCapability({
    profile_id: 'profile', level: 'L2', actions: scope.actions,
    report_id: 'report', report_version: 1, config_version: 1,
  });
  await delegation.ensureJudgmentPolicy();
  let grant: RunGrant;
  let subject: FrozenRun['subject'];
  if (kind === 'consultation') {
    await delegation.openConsultation({
      request_id: 'request', caller_id: principal.caller_id, parent_work_id: null,
      result_version: 1, domains: [DOMAIN, OTHER], tools: ['patrick-memory'],
      deadline_at: '2027-01-01', budget_micros: 0, permission_revision: 1,
    });
    grant = await delegation.authorizeConsultation('request', 'attempt');
    subject = { kind: 'consultation', request_id: 'request', result_version: 1, admitted_evidence: [] };
  } else {
    const nextAction = kind === 'delivery' ? 'publish_pr' : kind === 'collect_evidence' ? 'collect:collection-fixture' : 'judge';
    await delegation.openWork({
      work_id: 'work:rev_fixture', generation: 1, mandate_id: 'mandate', phase: kind,
      next_action: nextAction, budget_micros: 0,
    });
    if (kind === 'delivery') await delegation.setWorkGate('work:rev_fixture', 1, { evidence_ready: true });
    if (kind === 'collect_evidence') {
      await delegation.setWorkGate('work:rev_fixture', 1, { phase: kind, collection_id: 'collection-fixture' });
    }
    grant = await delegation.authorizeAction({
      work_id: 'work:rev_fixture', generation: 1, attempt_id: 'attempt', phase: kind,
      next_action: nextAction, allowed_effects: kind === 'judgment' ? [] : [nextAction],
      ...(kind === 'collect_evidence' ? { collection_id: 'collection-fixture' } : {}),
      expires_at: '2027-01-01',
    });
    subject = {
      kind: 'work', work_id: 'work:rev_fixture', generation: 1, next_action: nextAction,
      judgment_basis: { hash: grant.basis_hash, evidence_watermark: 0 }, resume_phase: null,
    };
  }
  const output = join(root, 'output');
  const bin = join(root, 'bin');
  mkdirSync(output);
  mkdirSync(bin);
  const starts = join(root, 'starts');
  const plan = '# Candidate plan\n\nSource revision: rev_fixture\n\nApproved source plan.\n';
  const terminal = [
    { type: 'thread.started', thread_id: 'synthetic-session' },
    { type: 'item.completed', item: { type: 'agent_message', text: plan } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } },
  ].map((event) => JSON.stringify(event)).join('\n');
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(starts)}, 'start\\n');
require('node:fs').readFileSync(0, 'utf8');
process.stdout.write(${JSON.stringify(terminal)});
`, { mode: 0o755 });
  vi.stubEnv('PATH', bin);
  const sourceBytes = Buffer.from('admitted source');
  const snapshot: FrozenRun = {
    backend: 'codex', subject, home: join(root, 'home'), config_hash: 'config', cwd: output,
    session_id: null, bundle_present: true, controller: 'run', terminal: null, resume: null,
    ledger_dir: join(root, 'ledger'), paid: null,
    ...(kind === 'delivery' ? { deliveryPlan: {
      source_revision: 'rev_fixture', source_sha256: createHash('sha256').update(sourceBytes).digest('hex'), sourceBytes,
    } } : {}),
  };
  const gate = createRecoveryRuntimeGate(db);
  const activate = (domain = DOMAIN) => {
    db.prepare(`INSERT INTO recovery_domain_gates
      (data_domain,writer_epoch,status,activation_id,witness_revision,updated_at)
      VALUES (?,'writer','open','activation','witness',?)
      ON CONFLICT(data_domain) DO UPDATE SET writer_epoch='writer',status='open',
        activation_id='activation',witness_revision='witness'`).run(domain, NOW);
    gate.admit({ domain, writerEpoch: 'writer', activationId: 'activation', witnessRevision: 'witness' });
  };
  activate();
  if (kind === 'consultation') activate(OTHER);
  const runtime = { db, principal, now };
  return {
    db, location, root, grant, snapshot, starts, output, runtime, gate, activate, delegation,
    run: (overrides: Partial<FrozenRun> = {}, selectedGrant = grant, authority = runtime) =>
      invoke({ ...snapshot, ...overrides }, selectedGrant, authority),
    claim: join(snapshot.ledger_dir, 'execution_claim/attempt.json'),
    terminal: join(snapshot.ledger_dir, 'terminal/attempt.json'),
  };
}

function noStart(fx: Awaited<ReturnType<typeof fixture>>, receipt: RunReceipt) {
  expect(receipt.classification).toBe('technical_failure');
  expect(existsSync(fx.starts)).toBe(false);
  expect(existsSync(join(fx.output, 'plan.md'))).toBe(false);
}

test.each(['judgment', 'delivery'] as const)('closed free %s cannot start or acquire an execution claim', async (kind) => {
  const fx = await fixture(kind);
  fx.gate.revoke(DOMAIN);
  noStart(fx, await fx.run());
  expect(existsSync(fx.claim)).toBe(false);
  expect(existsSync(fx.terminal)).toBe(false);
});

test.each(['judgment', 'collect_evidence', 'delivery', 'consultation'] as const)('admitted current %s runs a synthetic backend', async (kind) => {
  const fx = await fixture(kind);
  const receipt = await fx.run();
  expect(receipt.classification).toBe('agent_completed');
  expect(readFileSync(fx.starts, 'utf8')).toBe('start\n');
  expect(receipt.session_id).toBe('synthetic-session');
});

test('legacy databases require persisted delegation rather than a permissive runner fallback', async () => {
  const fx = await fixture();
  const legacyLocation = join(fx.root, 'legacy.sqlite');
  await fx.db.backup(legacyLocation);
  const legacy = openDatabase(legacyLocation);
  cleanups.push(() => legacy.close());
  legacy.prepare('DELETE FROM recovery_domain_gates').run();
  expect((await fx.run({}, fx.grant, { ...fx.runtime, db: legacy })).classification).toBe('agent_completed');
});

test('an absent mandatory database authority cannot launch', async () => {
  const fx = await fixture('delivery');
  noStart(fx, await invoke(fx.snapshot, fx.grant, undefined as unknown as Runtime));
  expect(existsSync(fx.claim)).toBe(false);
});

test('copied SQL-open databases cannot inherit the admitted handle capability', async () => {
  const fx = await fixture('delivery');
  const copyLocation = join(fx.root, 'copy.sqlite');
  await fx.db.backup(copyLocation);
  const copy = openDatabase(copyLocation);
  cleanups.push(() => copy.close());
  noStart(fx, await fx.run({}, fx.grant, { ...fx.runtime, db: copy }));
  expect(existsSync(fx.claim)).toBe(false);
});

test.each(['writer_epoch', 'activation_id', 'witness_revision', 'data_domain'] as const)(
  'current stored %s drift closes a frozen free run', async (field) => {
    const fx = await fixture('delivery');
    fx.db.prepare(`UPDATE recovery_domain_gates SET ${field}='changed' WHERE data_domain=?`).run(DOMAIN);
    noStart(fx, await fx.run());
    expect(existsSync(fx.claim)).toBe(false);
  },
);

test.each(['missing', 'forged_scope', 'revoked', 'paused', 'auth_epoch', 'expired'] as const)(
  '%s live authority cannot be replaced with a frozen grant', async (change) => {
    const fx = await fixture('delivery');
    let grant = fx.grant;
    let authority = fx.runtime;
    if (change === 'missing') fx.db.prepare('DELETE FROM execution_grants').run();
    if (change === 'forged_scope' && grant.subject_kind === 'work') grant = { ...grant, mandate_id: 'forged' };
    if (change === 'revoked') await fx.delegation.revokeGrant(grant.grant_id);
    if (change === 'paused') await fx.delegation.pauseMandate('mandate');
    if (change === 'auth_epoch') fx.db.prepare("UPDATE accounts SET auth_epoch=2 WHERE account_id='owner'").run();
    if (change === 'expired') authority = { ...authority, now: () => new Date('2028-01-01') };
    noStart(fx, await fx.run({}, grant, authority));
    expect(existsSync(fx.claim)).toBe(false);
  },
);

test('consultation secondary domain closure is checked from persisted grant scope', async () => {
  const fx = await fixture('consultation');
  fx.gate.revoke(OTHER);
  noStart(fx, await fx.run());
  if (fx.grant.subject_kind !== 'consultation') throw new Error('expected consultation');
  noStart(fx, await fx.run({}, { ...fx.grant, allowed_domains: [DOMAIN] }));
});

test('closure while asynchronous delivery preparation resolves cannot acquire an execution claim', async () => {
  const fx = await fixture('delivery');
  preparation.close = () => fx.gate.revoke(DOMAIN);
  noStart(fx, await fx.run());
  expect(existsSync(fx.claim)).toBe(false);
});

test('the actual synchronous spawn assertion rechecks closure after command preparation', async () => {
  const fx = await fixture('delivery');
  const original = command.runClosed;
  vi.spyOn(command, 'runClosed').mockImplementation((...args) => {
    fx.gate.revoke(DOMAIN);
    return original(...args);
  });
  noStart(fx, await fx.run());
  expect(existsSync(fx.claim)).toBe(true);
  expect(JSON.parse(readFileSync(fx.terminal, 'utf8')).classification).toBe('technical_failure');
});

test('closure after a process drains suppresses any new materialized plan or success receipt', async () => {
  const fx = await fixture('delivery');
  const original = command.runClosed;
  vi.spyOn(command, 'runClosed').mockImplementation(async (...args) => {
    const terminal = await original(...args);
    fx.gate.revoke(DOMAIN);
    return terminal;
  });
  const receipt = await fx.run();
  expect(readFileSync(fx.starts, 'utf8')).toBe('start\n');
  expect(receipt.classification).toBe('technical_failure');
  expect(existsSync(join(fx.output, 'plan.md'))).toBe(false);
  expect(JSON.parse(readFileSync(fx.terminal, 'utf8')).classification).toBe('technical_failure');
});

test('an exact completed delivery receipt remains readable after current admission closes', async () => {
  const fx = await fixture('delivery');
  const completed = await fx.run();
  expect(completed.classification).toBe('agent_completed');
  const bytes = readFileSync(completed.persisted_path, 'utf8');
  fx.gate.revoke(DOMAIN);
  expect(await fx.run()).toEqual(completed);
  expect(readFileSync(fx.starts, 'utf8')).toBe('start\n');
  expect(readFileSync(completed.persisted_path, 'utf8')).toBe(bytes);
});

test('a supported evidence gate reduction denies delivery before any execution claim', async () => {
  const fx = await fixture('delivery');
  await fx.delegation.setWorkGate('work:rev_fixture', 1, { evidence_ready: false });
  expect(fx.db.prepare('SELECT evidence_ready FROM work_generations').get()).toEqual({ evidence_ready: 0 });
  noStart(fx, await fx.run());
  expect(existsSync(fx.claim)).toBe(false);
  expect(existsSync(fx.terminal)).toBe(false);
});

test('evidence reduction during awaited delivery preparation denies a new claim', async () => {
  const fx = await fixture('delivery');
  preparation.close = () => fx.delegation.setWorkGate('work:rev_fixture', 1, { evidence_ready: false });
  noStart(fx, await fx.run());
  expect(existsSync(fx.claim)).toBe(false);
  expect(existsSync(fx.terminal)).toBe(false);
});

test('evidence reduction at the actual spawn boundary denies a process start', async () => {
  const fx = await fixture('delivery');
  const original = command.runClosed;
  vi.spyOn(command, 'runClosed').mockImplementation(async (...args) => {
    await fx.delegation.setWorkGate('work:rev_fixture', 1, { evidence_ready: false });
    return original(...args);
  });
  noStart(fx, await fx.run());
  expect(existsSync(fx.claim)).toBe(true);
  expect(JSON.parse(readFileSync(fx.terminal, 'utf8')).classification).toBe('technical_failure');
});

test('evidence reduction after process drainage suppresses plan publication and success', async () => {
  const fx = await fixture('delivery');
  const original = command.runClosed;
  vi.spyOn(command, 'runClosed').mockImplementation(async (...args) => {
    const terminal = await original(...args);
    await fx.delegation.setWorkGate('work:rev_fixture', 1, { evidence_ready: false });
    return terminal;
  });
  const receipt = await fx.run();
  expect(readFileSync(fx.starts, 'utf8')).toBe('start\n');
  expect(receipt.classification).toBe('technical_failure');
  expect(existsSync(join(fx.output, 'plan.md'))).toBe(false);
  expect(JSON.parse(readFileSync(fx.terminal, 'utf8')).classification).toBe('technical_failure');
});

test.each(['agent_completed', 'technical_failure'] as const)(
  'an exact %s delivery receipt replays after evidence gate reduction', async (classification) => {
    const fx = await fixture('delivery');
    if (classification === 'technical_failure') {
      const original = command.runClosed;
      vi.spyOn(command, 'runClosed').mockImplementation(async (...args) => ({ ...await original(...args), exitCode: 1 }));
    }
    const receipt = await fx.run();
    expect(receipt.classification).toBe(classification);
    const bytes = readFileSync(receipt.persisted_path, 'utf8');
    await fx.delegation.setWorkGate('work:rev_fixture', 1, { evidence_ready: false });
    expect(await fx.run()).toEqual(receipt);
    expect(readFileSync(fx.starts, 'utf8')).toBe('start\n');
    expect(readFileSync(receipt.persisted_path, 'utf8')).toBe(bytes);
  },
);

test.each([null, 'collection-other'])('a current collection binding of %s denies a frozen collection grant', async (collectionId) => {
  const fx = await fixture('collect_evidence');
  await fx.delegation.setWorkGate('work:rev_fixture', 1, { collection_id: collectionId });
  noStart(fx, await fx.run());
  expect(existsSync(fx.terminal)).toBe(false);
});

test('collection binding reduction after process drainage cannot record success', async () => {
  const fx = await fixture('collect_evidence');
  const original = command.runClosed;
  vi.spyOn(command, 'runClosed').mockImplementation(async (...args) => {
    const terminal = await original(...args);
    await fx.delegation.setWorkGate('work:rev_fixture', 1, { collection_id: null });
    return terminal;
  });
  const receipt = await fx.run();
  expect(readFileSync(fx.starts, 'utf8')).toBe('start\n');
  expect(receipt.classification).toBe('technical_failure');
  expect(JSON.parse(readFileSync(fx.terminal, 'utf8')).classification).toBe('technical_failure');
});

test.each(['awaiting_answer', 'phase', 'capability'] as const)('a current judgment %s reduction denies a frozen grant', async (change) => {
  const fx = await fixture();
  if (change === 'awaiting_answer') await fx.delegation.setWorkGate('work:rev_fixture', 1, { awaiting_answer: true });
  if (change === 'phase') await fx.delegation.setWorkGate('work:rev_fixture', 1, { phase: 'delivery' });
  if (change === 'capability') {
    await fx.delegation.setCapability({
      profile_id: 'profile', level: 'L2', actions: [],
      report_id: 'report', report_version: 1, config_version: 2,
    });
  }
  noStart(fx, await fx.run());
  expect(existsSync(fx.terminal)).toBe(false);
});

test('a judgment answer gate raised after process drainage cannot record success', async () => {
  const fx = await fixture();
  const original = command.runClosed;
  vi.spyOn(command, 'runClosed').mockImplementation(async (...args) => {
    const terminal = await original(...args);
    await fx.delegation.setWorkGate('work:rev_fixture', 1, { awaiting_answer: true });
    return terminal;
  });
  const receipt = await fx.run();
  expect(readFileSync(fx.starts, 'utf8')).toBe('start\n');
  expect(receipt.classification).toBe('technical_failure');
  expect(JSON.parse(readFileSync(fx.terminal, 'utf8')).classification).toBe('technical_failure');
});

test('a clock callback cannot reduce evidence after the final preclaim work snapshot', async () => {
  const fx = await fixture('delivery');
  let reduction: Promise<void> | undefined;
  const authority = {
    ...fx.runtime,
    now: () => {
      reduction = fx.delegation.setWorkGate('work:rev_fixture', 1, { evidence_ready: false });
      return new Date(NOW);
    },
  };
  const receipt = await fx.run({}, fx.grant, authority);
  await reduction;
  noStart(fx, receipt);
  expect(existsSync(fx.claim)).toBe(false);
  expect(existsSync(fx.terminal)).toBe(false);
});

test('a clock callback after process drainage cannot invalidate the final plan admission snapshot', async () => {
  const fx = await fixture('delivery');
  let drained = false;
  let reduction: Promise<void> | undefined;
  const original = command.runClosed;
  vi.spyOn(command, 'runClosed').mockImplementation(async (...args) => {
    const terminal = await original(...args);
    drained = true;
    return terminal;
  });
  const authority = {
    ...fx.runtime,
    now: () => {
      if (drained) reduction = fx.delegation.setWorkGate('work:rev_fixture', 1, { evidence_ready: false });
      return new Date(NOW);
    },
  };
  const receipt = await fx.run({}, fx.grant, authority);
  await reduction;
  expect(readFileSync(fx.starts, 'utf8')).toBe('start\n');
  expect(receipt.classification).toBe('technical_failure');
  expect(existsSync(join(fx.output, 'plan.md'))).toBe(false);
  expect(JSON.parse(readFileSync(fx.terminal, 'utf8')).classification).toBe('technical_failure');
});

test('principal scope access cannot reduce evidence after the final preclaim work snapshot', async () => {
  const fx = await fixture('delivery');
  let reduction: Promise<void> | undefined;
  const authority = {
    ...fx.runtime,
    principal: {
      ...principal,
      get domains() {
        reduction = fx.delegation.setWorkGate('work:rev_fixture', 1, { evidence_ready: false });
        return principal.domains;
      },
    },
  };
  const receipt = await fx.run({}, fx.grant, authority);
  await reduction;
  noStart(fx, receipt);
  expect(existsSync(fx.claim)).toBe(false);
  expect(existsSync(fx.terminal)).toBe(false);
});
