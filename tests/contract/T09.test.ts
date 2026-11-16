import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { CallReservation } from '../../packages/domain/src/budget.js';
import { createBudgetApi } from '../../packages/domain/src/budget.js';
import {
  createDelegationApi,
  type AdmissionPrincipal,
  type ConsultationGrant,
  type ExecutionGrant,
} from '../../packages/domain/src/delegation.js';
import { codexInvocation } from '../../packages/executor/src/backends/codex.js';
import { HARNESS_TOOLS, LOCKED_DSH_VERSION, dshInvocation, writeDshOverlay } from '../../packages/executor/src/backends/dsh.js';
import { grokInvocation } from '../../packages/executor/src/backends/grok.js';
import { bundleFingerprint, evidenceSha256 } from '../../packages/executor/src/hash.js';
import { processTreeStopped, stopProcessTreeAndWait } from '../../packages/executor/src/process-tree.js';
import { assessProbe } from '../../packages/executor/src/probe.js';
import { completedRun, resumeAllowed, runAttempt, type FrozenRun } from '../../packages/executor/src/wrapper.js';
import type { ObservedProcess, ResumeProbe } from '../../packages/executor/src/types.js';
import { patrickJudgment } from '../../packages/executor/harness/patrick-judgment.js';
import { patrickMemory } from '../../packages/executor/harness/patrick-memory.js';
import { dispatchPaidNext, type RouteProof } from '../../packages/executor/harness/patrick-bridge.js';
import { openDatabase, type SqliteDatabase } from '../../packages/storage/src/database.js';

process.env.PATH = (process.env.PATH ?? '').split(delimiter).filter((dir) => {
  if (!dir) return false;
  return !['codex', 'grok', 'dsh'].some((name) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}).join(delimiter);

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HARNESS = fileURLToPath(new URL('../../packages/executor/harness/', import.meta.url));
const HOME = '/var/lib/patrick-executor/home';
const CONFIG = 'config-1';
const PI_AI: RouteProof = { sdkMaxRetries: 0, implicitResend: false, perHttpAccounted: false, verifiedMaxSends: null };
const DOMAIN = 'product';
const principal: AdmissionPrincipal = {
  account_id: 'owner',
  caller_id: 'web',
  auth_epoch: 1,
  domains: [DOMAIN],
  operations: ['owner', 'work.control', 'delegations.read'],
};

const CODEX_OK = [
  '{"type":"thread.started","thread_id":"thread-fixture"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}',
  '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":2,"cached_input_tokens":0}}',
].join('\n');
const GROK_OK = '{"result":"answer","stop_reason":"end_turn","session_id":"grok-fixture","usage":{"input_tokens":3,"output_tokens":1}}';
const DSH_OK = [
  '{"type":"session","sessionId":"session-fixture"}',
  '{"type":"status","phase":"step_end","usage":{"inputTokens":2,"outputTokens":1,"cacheReadTokens":0}}',
  '{"type":"final","sessionId":"session-fixture","text":"done","reason":{"kind":"completed"}}',
].join('\n');

test('a drained exit 0 with one final is the only completed run', () => {
  const closed = { closed: true, drained: true, exitCode: 0, finalCount: 1, completed: true, outputsValid: true };
  expect(completedRun(closed)).toBe(true);
  expect(completedRun({ ...closed, exitCode: 1 })).toBe(false);
  expect(completedRun({ ...closed, closed: false })).toBe(false);
  expect(completedRun({ ...closed, finalCount: 2 })).toBe(false);
  expect(completedRun({ ...closed, exitCode: null })).toBe(false);
  expect(completedRun({ ...closed, drained: false })).toBe(false);
  expect(completedRun({ ...closed, completed: false })).toBe(false);
  expect(completedRun({ ...closed, outputsValid: false })).toBe(false);
});

test('a final message followed by exit 1 is not success', async () => {
  await withDir(async (dir) => {
    const receipt = await runAttempt(workSnapshot(dir, observed(CODEX_OK, 1)), workGrant());
    expect(receipt.classification).toBe('technical_failure');
    expect(readJson(receipt.persisted_path).classification).toBe('technical_failure');
    expect(existsSync(join(dir, 'policy_wait', 'attempt-1.json'))).toBe(false);
  });
});

test('a final message without process exit is not success', async () => {
  await withDir(async (dir) => {
    const receipt = await runAttempt(workSnapshot(dir, observed(CODEX_OK, null, false)), workGrant());
    expect(receipt.classification).toBe('technical_failure');
    expect(receipt.exit_code).toBeNull();
  });
});

test('a missing bundle is not success and does not send', async () => {
  await withDir(async (dir) => {
    const paid = blockingPaid();
    const receipt = await runAttempt(workSnapshot(dir, observed(CODEX_OK, 0), { bundle_present: false, paid: paid.dispatch }), workGrant());
    expect(receipt.classification).toBe('technical_failure');
    expect(paid.sends).toEqual([]);
    expect(bundleFingerprint(join(dir, 'missing-bundle')).present).toBe(false);
  });
});

test('empty usage is not success', async () => {
  await withDir(async (dir) => {
    const stdout = [
      '{"type":"thread.started","thread_id":"thread-fixture"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n');
    const receipt = await runAttempt(workSnapshot(dir, observed(stdout, 0)), workGrant());
    expect(receipt.classification).toBe('technical_failure');
    expect(receipt.usage).toBeNull();
  });
});

test('unsupported resume is not success and does not send', async () => {
  await withDir(async (dir) => {
    const paid = blockingPaid();
    const receipt = await runAttempt(workSnapshot(dir, observed(CODEX_OK, 0), {
      resume: resumeProbe({ supported: false }),
      paid: paid.dispatch,
    }), workGrant());
    expect(receipt.classification).toBe('technical_failure');
    expect(paid.sends).toEqual([]);
    expect(resumeAllowed(workSnapshot(dir, null), workGrant(), resumeProbe({ supported: false }))).toBe(false);
  });
});

test('controller policy_wait is stored apart from success', async () => {
  await withDir(async (dir) => {
    const receipt = await runAttempt(workSnapshot(dir, observed(CODEX_OK, 0), { controller: 'policy_wait' }), workGrant());
    expect(receipt.classification).toBe('policy_wait');
    expect(receipt.policy_wait_path).toBe(receipt.persisted_path);
    expect(readJson(receipt.persisted_path)).toMatchObject({ classification: 'policy_wait', origin: 'controller' });
    expect(existsSync(join(dir, 'terminal', 'attempt-1.json'))).toBe(false);
  });
});

test('codex, grok, and dsh each accept only their own successful terminal', async () => {
  await withDir(async (dir) => {
    const codex = await runAttempt(workSnapshot(dir, observed(CODEX_OK, 0)), workGrant());
    expect(codex.classification).toBe('agent_completed');
    expect(codex.session_id).toBe('thread-fixture');
    const doubled = `${CODEX_OK}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0}}`;
    expect((await runAttempt(workSnapshot(dir, observed(doubled, 0), { ledger_dir: dir }), workGrant({ attempt_id: 'attempt-2' }))).classification).toBe('technical_failure');

    const grok = await runAttempt(workSnapshot(dir, observed(GROK_OK, 0), { backend: 'grok' }), workGrant({ attempt_id: 'attempt-g' }));
    expect(grok.classification).toBe('agent_completed');
    expect(grok.session_id).toBe('grok-fixture');
    const grokExit = await runAttempt(workSnapshot(dir, observed(GROK_OK, 1), { backend: 'grok' }), workGrant({ attempt_id: 'attempt-gx' }));
    expect(grokExit.classification).toBe('technical_failure');
    const grokStop = GROK_OK.replace('end_turn', 'max_tokens');
    expect((await runAttempt(workSnapshot(dir, observed(grokStop, 0), { backend: 'grok' }), workGrant({ attempt_id: 'attempt-gs' }))).classification).toBe('technical_failure');
    const stream = '{"type":"end","stopReason":"end_turn","sessionId":"grok-fixture","usage":{"input_tokens":3,"output_tokens":1}}';
    expect((await runAttempt(workSnapshot(dir, observed(stream, 0), { backend: 'grok' }), workGrant({ attempt_id: 'attempt-gst' }))).classification).toBe('agent_completed');

    const dsh = await runAttempt(workSnapshot(dir, observed(DSH_OK, 0), { backend: 'dsh' }), workGrant({ attempt_id: 'attempt-d' }));
    expect(dsh.classification).toBe('agent_completed');
    expect(dsh.session_id).toBe('session-fixture');
    const aborted = DSH_OK.replace('"kind":"completed"', '"kind":"aborted"');
    expect((await runAttempt(workSnapshot(dir, observed(aborted, 0), { backend: 'dsh' }), workGrant({ attempt_id: 'attempt-da' }))).classification).toBe('technical_failure');
    expect((await runAttempt(workSnapshot(dir, observed(DSH_OK, 1), { backend: 'dsh' }), workGrant({ attempt_id: 'attempt-dx' }))).classification).toBe('technical_failure');
    expect(existsSync(join(dir, 'policy_wait', 'attempt-d.json'))).toBe(false);
  });
});

test('resume checks backend identity, home, config, and a stopped process tree', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error('missing pid');
  const snapshot = workSnapshot('/tmp', null);
  const grant = workGrant();
  try {
    await waitUntil(() => !processTreeStopped(pid));
    expect(processTreeStopped(pid)).toBe(false);
    expect(resumeAllowed(snapshot, grant, resumeProbe({ processTreeStopped: processTreeStopped(pid) }))).toBe(false);
    expect(await stopProcessTreeAndWait(pid)).toBe(true);
    expect(processTreeStopped(pid)).toBe(true);
    expect(resumeAllowed(snapshot, grant, resumeProbe({ processTreeStopped: true }))).toBe(true);
    expect(resumeAllowed(snapshot, grant, resumeProbe({ backend: 'grok' }))).toBe(false);
    expect(resumeAllowed(snapshot, grant, resumeProbe({ home: '/Users/someone' }))).toBe(false);
    expect(resumeAllowed(snapshot, grant, resumeProbe({ configHash: 'other-config' }))).toBe(false);
    expect(resumeAllowed(snapshot, grant, resumeProbe({ revoked: true }))).toBe(false);
    expect(resumeAllowed(snapshot, workGrant({ generation: 3 }), resumeProbe())).toBe(false);
    expect(resumeAllowed(snapshot, grant, resumeProbe({ withdrawalEpoch: 5 }))).toBe(false);
    const consultation = consultationSnapshot('/tmp', null);
    expect(resumeAllowed(consultation, consultationGrant({ result_version: 5 }), resumeProbe({ backend: 'grok' }))).toBe(false);
    expect(resumeAllowed(consultation, consultationGrant(), resumeProbe({ backend: 'grok', withdrawnEvidence: ['ev-1'] }))).toBe(false);
    expect(resumeAllowed(consultation, consultationGrant(), resumeProbe({ backend: 'grok' }))).toBe(true);
  } finally {
    await stopProcessTreeAndWait(pid);
  }
});

test('dsh starts from stdin in a dedicated home and the harness bundle is fixed', async () => {
  await withDir(async (dir) => {
    const invocation = dshInvocation(HOME);
    expect(invocation).toMatchObject({ command: 'dsh', stdin: true, env: { DSH_HOME: HOME } });
    expect(invocation.args).toEqual(['--profile', 'headless', '--json', '--approval-policy', 'never']);
    const overlay = writeDshOverlay(dir);
    expect(JSON.parse(readFileSync(overlay.path, 'utf8'))).toEqual({
      effort: null,
      hmr: false,
      inventory: false,
      model: null,
      pluginAdmin: false,
      sessionReport: false,
      unattributedBackground: false,
    });
    expect(writeDshOverlay(dir).configHash).toBe(overlay.configHash);
    const codex = codexInvocation({ home: HOME, resumeSession: null });
    expect(codex.env.CODEX_HOME).toBe(HOME);
    expect(codex.stdin).toBe(true);
    expect(codex.args).not.toContain('resume');
    expect(codexInvocation({ home: HOME, resumeSession: 'thread-fixture' }).args).toContain('resume');
    const grok = grokInvocation({ home: HOME, resumeSession: null, promptFile: join(dir, 'task.txt') });
    expect(grok.env.GROK_HOME).toBe(HOME);
    expect(grok.args).toContain('--output-format');
    expect(grok.args).toContain('json');
    const resumed = grokInvocation({ home: HOME, resumeSession: 'grok-fixture', promptFile: join(dir, 'task.txt') });
    expect(resumed.args).toContain('--resume');
    expect(resumed.args).not.toContain('--session-id');
  });
  const bundle = bundleFingerprint(HARNESS);
  expect(bundle.present).toBe(true);
  expect(bundle.tools).toEqual([...HARNESS_TOOLS]);
  expect(bundle.hash).toMatch(/^[a-f0-9]{64}$/);
  const records = await patrickMemory({
    async queryEvidence(query) {
      expect(query).toMatchObject({ domain: DOMAIN, knowledgeId: 'k-1', withdrawalEpoch: 4 });
      return [{ evidenceId: 'ev-1', documentId: 'doc-1', revisionId: 'rev-1', status: 'supported' }];
    },
  }, { domain: DOMAIN, knowledgeId: 'k-1', withdrawalEpoch: 4 });
  expect(records).toHaveLength(1);
  const basis = await patrickJudgment({
    async readBasis(workId, generation) {
      return { work_id: workId, generation, hash: 'basis-1', evidence_watermark: 4 };
    },
  }, { workId: 'work-1', generation: 2 });
  expect(basis.generation).toBe(2);
  await expect(patrickJudgment({
    async readBasis() {
      return { work_id: 'work-1', generation: 9, hash: 'basis-new', evidence_watermark: 9 };
    },
  }, { workId: 'work-1', generation: 2 })).rejects.toThrow('BASIS_MISMATCH');
});

test('the lima definition is the only executor yaml', () => {
  expect(globSync('**/executor.yaml', { cwd: ROOT })).toEqual(['deploy/lima/executor.yaml']);
  const script = readFileSync(join(ROOT, 'scripts/start-executor-vm.mjs'), 'utf8');
  expect(script).toContain('deploy/lima/executor.yaml');
  const yaml = readFileSync(join(ROOT, 'deploy/lima/executor.yaml'), 'utf8');
  expect(yaml).toMatch(/^mounts:\s*\[\]/m);
  expect(yaml).not.toMatch(/location:\s*"~"/);
  expect(yaml).toContain('loadDotSSHPubKeys: false');
  expect(yaml).toContain('/etc/patrick-executor-vm');
  expect(yaml).toContain('node_version=24.22.3');
  expect(yaml).toContain('https://nodejs.org/dist/v${node_version}/${node_dist}.tar.xz');
  expect(yaml).toContain('6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c');
  expect(yaml).toContain('4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb');
  expect(yaml).toContain('/usr/local/bin');
  expect(yaml).toContain('/usr/bin/node');
  expect(script).toContain('delete');
  expect(script).toContain('--force');
  const wrapper = readFileSync(join(ROOT, 'packages/executor/src/wrapper.ts'), 'utf8');
  expect(wrapper).toContain('dshInvocation');
  expect(wrapper).toContain('findExecutable');
  expect(wrapper).toContain('runClosed');
  for (const name of ['codex.ts', 'grok.ts', 'dsh.ts']) {
    const source = readFileSync(join(ROOT, 'packages/executor/src/backends', name), 'utf8');
    expect(source).toContain("from './parse.js'");
    expect(source).toContain('export function probe');
    expect(source).not.toMatch(/function jsonLines|function isRecord|function positiveToken/);
  }
});

test('a present backend is drained before the terminal is classified', async () => {
  await withDir(async (dir) => {
    const codex = writeBackendStub(dir, 'codex', CODEX_OK, 0);
    await withBackendPath(codex.bin, async () => {
      const receipt = await runAttempt(workSnapshot(dir, observed('not-live', 1)), workGrant({ attempt_id: 'attempt-live' }));
      expect(receipt.classification).toBe('agent_completed');
      expect(receipt.exit_code).toBe(0);
      expect(receipt.session_id).toBe('thread-fixture');
      expect(readFileSync(codex.args, 'utf8').trim().split('\n')).toEqual([
        'exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
      ]);
      expect(readFileSync(`${codex.args}.codex`, 'utf8')).toBe(HOME);
      writeFileSync(codex.args, 'not-run\n');
      const waited = await runAttempt(workSnapshot(dir, observed(CODEX_OK, 0), { controller: 'policy_wait' }), workGrant({ attempt_id: 'attempt-pw' }));
      expect(waited.classification).toBe('policy_wait');
      expect(readFileSync(codex.args, 'utf8')).toBe('not-run\n');
    });
    const failed = writeBackendStub(dir, 'codex', CODEX_OK, 1);
    await withBackendPath(failed.bin, async () => {
      const receipt = await runAttempt(workSnapshot(dir, observed(CODEX_OK, 0)), workGrant({ attempt_id: 'attempt-live-exit' }));
      expect(receipt.classification).toBe('technical_failure');
      expect(receipt.exit_code).toBe(1);
    });
    const dsh = writeBackendStub(dir, 'dsh', DSH_OK, 0);
    const dshHome = join(dir, 'dsh-home');
    await withBackendPath(dsh.bin, async () => {
      const receipt = await runAttempt(workSnapshot(dir, observed('not-live', 1), { backend: 'dsh', home: dshHome }), workGrant({ attempt_id: 'attempt-dsh-live' }));
      expect(receipt.classification).toBe('agent_completed');
      expect(receipt.session_id).toBe('session-fixture');
      const argv = readFileSync(dsh.args, 'utf8').trim().split('\n');
      expect(argv).toEqual(['--profile', 'headless', '--json', '--approval-policy', 'never']);
      expect(argv).not.toContain('--model');
      expect(argv).not.toContain('--effort');
      expect(readFileSync(`${dsh.args}.dsh`, 'utf8')).toBe(dshHome);
      expect(existsSync(join(dshHome, 'profiles', 'headless', 'patrick-overlay.json'))).toBe(true);
      for (const name of ['manifest.json', 'patrick-memory.ts', 'patrick-judgment.ts', 'patrick-bridge.ts']) {
        expect(existsSync(join(dshHome, 'profiles', 'headless', 'bundle', name))).toBe(true);
      }
    });
  });
});

test('a probe is verified only for the locked pin plus isolation, terminal readback, and a live tool call', () => {
  const gates = { isolated: true, liveTerminal: true, liveToolCall: true };
  const mismatch = assessProbe('dsh', { exitCode: 0, stdout: '0.2.2-rc.1\n', stderr: '', error: null }, gates);
  expect(mismatch.status).toBe('blocked');
  expect(mismatch.available).toBe(false);
  expect(mismatch.command).toBe('dsh --version');
  expect(mismatch.observation).toContain('0.2.2-rc.1');
  expect(mismatch.observation).toContain(LOCKED_DSH_VERSION);
  expect(mismatch.evidenceSha256).toBe(evidenceSha256(mismatch.observation));
  const unread = assessProbe('dsh', { exitCode: 0, stdout: `${LOCKED_DSH_VERSION}\n`, stderr: '', error: null }, {
    isolated: false,
    liveTerminal: false,
    liveToolCall: false,
  });
  expect(unread.available).toBe(false);
  expect(unread.status).toBe('blocked');
  const ready = assessProbe('codex', { exitCode: 0, stdout: 'codex-cli 0.163.0\n', stderr: '', error: null }, gates);
  expect(ready.status).toBe('verified');
  expect(ready.available).toBe(true);
  expect(ready.evidenceSha256).toBe(createHash('sha256').update(ready.observation, 'utf8').digest('hex'));
});

test('paid next sends once per acquired claim, including retry and crash recovery', async () => {
  const fx = temporaryDatabase();
  try {
    const now = () => new Date('2026-11-16T12:00:00.000Z');
    const admitted = await admitRunningWork(fx.db, now);
    const { budget, delegation, grant } = admitted;
    const network = networkDouble();
    const call = callFor(grant, 'route-a', 'call-a', 1000);
    const reserved = await budget.reserveCall(call);
    const claims = [
      await budget.claimPaidDispatch(reserved.reservation_id, grant.grant_id, grant.attempt_id, 'route-a'),
      await budget.claimPaidDispatch(reserved.reservation_id, grant.grant_id, grant.attempt_id, 'route-a'),
    ];
    for (const claim of claims) {
      if (claim === 'acquired') await network.send({ reservationId: reserved.reservation_id, callId: call.callId });
    }
    expect(claims.sort()).toEqual(['acquired', 'already_dispatched']);
    expect(network.sends).toEqual([{ reservationId: reserved.reservation_id, callId: 'call-a' }]);

    const retryNetwork = networkDouble();
    const first = await dispatchPaidNext({ bridge: budget, call: callFor(grant, 'route-b', 'call-b', 1000), route: PI_AI, network: retryNetwork });
    const second = await dispatchPaidNext({ bridge: budget, call: callFor(grant, 'route-b', 'call-b', 1000), route: PI_AI, network: retryNetwork });
    expect(first.sent).toBe(true);
    expect(first.outbound).toBe(1);
    expect(second.sent).toBe(false);
    expect(second.claim).toBe('denied');
    expect(retryNetwork.sends).toHaveLength(1);
    expect(retryNetwork.sends[0]?.reservationId).toBe(first.reservationId);

    const crashNetwork = networkDouble();
    const crashed = await dispatchPaidNext({
      bridge: budget,
      call: callFor(grant, 'route-c', 'call-c', 1000),
      route: PI_AI,
      network: crashNetwork,
      crashBeforeSettle: true,
    });
    const recovered = await dispatchPaidNext({
      bridge: budget,
      call: callFor(grant, 'route-c', 'call-c', 1000),
      route: PI_AI,
      network: crashNetwork,
    });
    expect(crashed.sent).toBe(true);
    expect(recovered.sent).toBe(false);
    expect(recovered.claim).toBe('already_dispatched');
    expect(crashNetwork.sends).toHaveLength(1);
    expect(new Set(crashNetwork.sends.map((send) => send.reservationId)).size).toBe(1);
    const heldBeforeSettle = await budget.heldAmount('work:work-1');
    const unsettled = await budget.settleCall(crashed.reservationId ?? '', null);
    expect(unsettled.status).toBe('uncertain');
    expect(await budget.heldAmount('work:work-1')).toBe(heldBeforeSettle);

    const blocked = networkDouble();
    const implicit = await dispatchPaidNext({
      bridge: budget,
      call: callFor(grant, 'route-d', 'call-d', 1000),
      route: { sdkMaxRetries: 0, implicitResend: true, perHttpAccounted: false, verifiedMaxSends: null },
      network: blocked,
    });
    expect(implicit).toMatchObject({ claim: 'route_blocked', sent: false, outbound: 0 });
    expect(blocked.sends).toEqual([]);
    const retriedSdk = await dispatchPaidNext({
      bridge: budget,
      call: callFor(grant, 'route-e', 'call-e', 1000),
      route: { sdkMaxRetries: 2, implicitResend: false, perHttpAccounted: false, verifiedMaxSends: null },
      network: blocked,
    });
    expect(retriedSdk.sent).toBe(false);
    expect(blocked.sends).toEqual([]);

    const proxied = networkDouble();
    const counted = await dispatchPaidNext({
      bridge: budget,
      call: callFor(grant, 'route-f', 'call-f', 1000),
      route: { sdkMaxRetries: 0, implicitResend: true, perHttpAccounted: true, verifiedMaxSends: 2 },
      network: proxied,
    });
    expect(counted.outbound).toBe(2);
    expect(new Set(proxied.sends.map((send) => send.reservationId)).size).toBe(2);
    expect(proxied.sends.map((send) => send.callId)).toEqual(['call-f#0', 'call-f#1']);

    await delegation.revokeGrant(grant.grant_id);
    const deniedNetwork = networkDouble();
    await expect(dispatchPaidNext({
      bridge: budget,
      call: callFor(grant, 'route-g', 'call-g', 1000),
      route: PI_AI,
      network: deniedNetwork,
    })).rejects.toThrow('DENIED');
    expect(deniedNetwork.sends).toEqual([]);
  } finally {
    fx.close();
  }
});

test('a consultation send uses its own request and still requires one acquired claim', async () => {
  const fx = temporaryDatabase();
  try {
    const now = () => new Date('2026-11-16T12:00:00.000Z');
    const { budget, delegation } = await admitRunningWork(fx.db, now);
    await delegation.openConsultation({
      request_id: 'req-1',
      caller_id: 'web',
      parent_work_id: 'work-1',
      result_version: 4,
      domains: [DOMAIN],
      tools: ['patrick-memory'],
      deadline_at: '2026-11-20T00:00:00.000Z',
      budget_micros: 2000,
      permission_revision: 1,
    });
    const consultation = await delegation.authorizeConsultation('req-1', 'attempt-c');
    const network = networkDouble();
    await withDir(async (dir) => {
      const receipt = await runAttempt(consultationSnapshot(dir, observed(GROK_OK, 0), {
        paid: {
          bridge: budget,
          call: {
            businessId: 'consultation:req-1',
            grantId: consultation.grant_id,
            attemptId: consultation.attempt_id,
            routeId: 'route-consult',
            callId: 'call-consult',
            amountMicros: 1000,
          },
          route: PI_AI,
          network,
        },
      }), consultation);
      expect(receipt.classification).toBe('agent_completed');
      expect(network.sends).toHaveLength(1);
      expect(receipt.reservation_id).toBe(network.sends[0]?.reservationId);
      const row = fx.db.prepare('SELECT business_id, status FROM budget_reservations WHERE reservation_id = ?').get(receipt.reservation_id) as {
        business_id: string;
        status: string;
      };
      expect(row).toEqual({ business_id: 'consultation:req-1', status: 'settled' });
    });
  } finally {
    fx.close();
  }
});

function observed(stdout: string, exitCode: number | null, closed = true, drained = true): ObservedProcess {
  return { closed, drained, exitCode, stdout, stderr: '' };
}

function workGrant(overrides: Partial<ExecutionGrant> = {}): ExecutionGrant {
  return {
    grant_id: 'grant-1',
    subject_kind: 'work',
    work_id: 'work-1',
    generation: 2,
    attempt_id: 'attempt-1',
    mandate_id: 'mandate-1',
    next_action: 'judge',
    allowed_effects: [],
    basis_hash: 'basis-1',
    phase: 'judgment',
    collection_id: null,
    expires_at: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

function consultationGrant(overrides: Partial<ConsultationGrant> = {}): ConsultationGrant {
  return {
    grant_id: 'grant-c',
    subject_kind: 'consultation',
    request_id: 'req-1',
    result_version: 4,
    caller_id: 'web',
    parent_work_id: null,
    allowed_domains: [DOMAIN],
    readonly_tools: ['patrick-memory'],
    allowed_effects: [],
    attempt_id: 'attempt-c',
    expires_at: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

function workSnapshot(dir: string, terminal: ObservedProcess | null, extras: Partial<FrozenRun> = {}): FrozenRun {
  return {
    backend: 'codex',
    subject: {
      kind: 'work',
      work_id: 'work-1',
      generation: 2,
      judgment_basis: { hash: 'basis-1', evidence_watermark: 4 },
      next_action: 'judge',
      resume_phase: 'answer',
    },
    home: HOME,
    config_hash: CONFIG,
    cwd: '/var/lib/patrick-executor/output',
    session_id: null,
    bundle_present: true,
    controller: 'run',
    terminal,
    resume: null,
    ledger_dir: dir,
    paid: null,
    ...extras,
  };
}

function consultationSnapshot(dir: string, terminal: ObservedProcess | null, extras: Partial<FrozenRun> = {}): FrozenRun {
  return {
    backend: 'grok',
    subject: {
      kind: 'consultation',
      request_id: 'req-1',
      result_version: 4,
      admitted_evidence: ['ev-1'],
    },
    home: HOME,
    config_hash: CONFIG,
    cwd: '/var/lib/patrick-executor/output',
    session_id: null,
    bundle_present: true,
    controller: 'run',
    terminal,
    resume: null,
    ledger_dir: dir,
    paid: null,
    ...extras,
  };
}

function resumeProbe(overrides: Partial<ResumeProbe> = {}): ResumeProbe {
  return {
    requested: true,
    supported: true,
    backend: 'codex',
    home: HOME,
    configHash: CONFIG,
    processTreeStopped: true,
    revoked: false,
    withdrawalEpoch: 4,
    withdrawnEvidence: [],
    ...overrides,
  };
}

function blockingPaid() {
  const sends: string[] = [];
  return {
    sends,
    dispatch: {
      bridge: {
        async reserveCall(): Promise<never> {
          throw new Error('reserve should not run');
        },
        async claimPaidDispatch(): Promise<never> {
          throw new Error('claim should not run');
        },
        async settleCall(): Promise<never> {
          throw new Error('settle should not run');
        },
      },
      call: {
        businessId: 'work:work-1',
        grantId: 'grant-1',
        attemptId: 'attempt-1',
        routeId: 'route-a',
        callId: 'call-blocked',
        amountMicros: 1000,
      },
      route: PI_AI,
      network: {
        async send(item: { reservationId: string; callId: string }) {
          sends.push(item.callId);
          return { usage: null };
        },
      },
    },
  };
}

function networkDouble(amount = 1000) {
  const sends: { reservationId: string; callId: string }[] = [];
  return {
    sends,
    async send(item: { reservationId: string; callId: string }) {
      sends.push(item);
      return { usage: { usage_id: `use-${item.callId}`, amount_micros: amount, proof: `proof-${item.callId}` } };
    },
  };
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

function readJson(path: string): { classification: string; origin?: string } {
  return JSON.parse(readFileSync(path, 'utf8')) as { classification: string; origin?: string };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function writeBackendStub(dir: string, name: string, stdout: string, exitCode: number): { bin: string; args: string } {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const stdoutFile = join(dir, `${name}-stdout.txt`);
  const argsFile = join(dir, `${name}-args.txt`);
  writeFileSync(stdoutFile, stdout);
  const script = `#!/bin/sh
printf '%s\\n' "$@" > ${shellQuote(argsFile)}
printf '%s' "\${DSH_HOME-}" > ${shellQuote(`${argsFile}.dsh`)}
printf '%s' "\${CODEX_HOME-}" > ${shellQuote(`${argsFile}.codex`)}
cat ${shellQuote(stdoutFile)}
exit ${exitCode}
`;
  const path = join(bin, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { bin, args: argsFile };
}

async function withBackendPath<T>(bin: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ''}`;
  try {
    return await run();
  } finally {
    process.env.PATH = previous;
  }
}

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t09-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitUntil(ready: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('process did not start');
}

function temporaryDatabase(): { db: SqliteDatabase; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'patrick-t09-db-'));
  const db = openDatabase(join(dir, 'patrick.sqlite'));
  return {
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function admitRunningWork(db: SqliteDatabase, now: () => Date) {
  const delegation = createDelegationApi(db, principal, { now, domain: DOMAIN });
  const budget = createBudgetApi(db, principal, { now });
  await delegation.registerMandateType({
    type_id: 'type-judge',
    actions: ['judge', 'collect', 'publish_pr'],
    resources: ['work'],
    effects: ['publish_pr'],
    domains: [DOMAIN],
    risk: 'low',
    level: 'L1',
    budget_micros: 5000,
    config_version: 1,
  });
  const mandate = await delegation.openMandate({
    mandate_id: 'mandate-work-1',
    type_id: 'type-judge',
    actions: ['judge', 'collect', 'publish_pr'],
    resources: ['work'],
    effects: ['publish_pr'],
    domains: [DOMAIN],
    risk: 'low',
    level: 'L1',
    budget_micros: 5000,
    expires_at: '2027-01-01T00:00:00.000Z',
  });
  await delegation.setCapability({
    profile_id: 'cap-work-1',
    level: 'L2',
    actions: ['judge', 'collect', 'publish_pr', 'deploy'],
    report_id: 'report-1',
    report_version: 1,
    config_version: 1,
  });
  await delegation.ensureJudgmentPolicy();
  await delegation.openWork({
    work_id: 'work-1',
    generation: 2,
    mandate_id: mandate.mandate_id,
    phase: 'judgment',
    next_action: 'judge',
    budget_micros: 5000,
  });
  const grant = await delegation.authorizeAction({
    work_id: 'work-1',
    generation: 2,
    attempt_id: 'attempt-1',
    phase: 'judgment',
    next_action: 'judge',
    allowed_effects: [],
    expires_at: '2026-11-17T00:00:00.000Z',
  });
  return { delegation, budget, grant };
}
