import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { RunGrant } from '../../domain/src/delegation.js';
import { codexInvocation, parseCodexTerminal } from './backends/codex.js';
import { dshInvocation, installDshProfile, parseDshTerminal } from './backends/dsh.js';
import { grokInvocation, parseGrokTerminal } from './backends/grok.js';
import { dispatchPaidNext, type PaidDispatch } from '../harness/patrick-bridge.js';
import { assertRunAdmission, type ExecutorRuntime } from './admission.js';
import { findExecutable, runClosed } from './command.js';
import { ensureLedgerDirectory, ledgerPath, persistRecord, readExactFile, syncDirectory } from './ledger.js';
import { assertDeliveryBinding, createDeliveryRequest, planLimit, sealDeliveryMarkdown, type DeliveryArtifact, type DeliveryBinding, type DeliverySource } from './delivery-artifact.js';
import type {
  BackendId,
  ConsultationSubject,
  ObservedProcess,
  ResumeProbe,
  RunClassification,
  TerminalParse,
  WorkSubject,
} from './types.js';

export type { ExecutorRuntime } from './admission.js';

export type FrozenRun = {
  backend: BackendId;
  subject: WorkSubject | ConsultationSubject;
  home: string;
  config_hash: string;
  cwd: string;
  session_id: string | null;
  bundle_present: boolean;
  controller: 'run' | 'policy_wait';
  terminal: ObservedProcess | null;
  resume: ResumeProbe | null;
  ledger_dir: string;
  paid: PaidDispatch | null;
  deliveryPlan?: DeliverySource & { sourceBytes: Uint8Array };
};

export type RunReceipt = {
  classification: RunClassification;
  attempt_id: string;
  session_id: string | null;
  exit_code: number | null;
  persisted_path: string;
  policy_wait_path: string | null;
  usage: TerminalParse['usage'];
  reservation_id: string | null;
};

export function completedRun(input: {
  closed: boolean; drained: boolean; exitCode: number | null;
  finalCount: number; completed: boolean; outputsValid: boolean;
}): boolean {
  return input.closed && input.drained && input.exitCode === 0
    && input.finalCount === 1 && input.completed && input.outputsValid;
}

export function resumeAllowed(snapshot: FrozenRun, grant: RunGrant, probe: ResumeProbe): boolean {
  if (!probe.requested) return true;
  if (!probe.supported || probe.revoked || !probe.processTreeStopped) return false;
  if (probe.backend !== snapshot.backend || probe.home !== snapshot.home || probe.configHash !== snapshot.config_hash) return false;
  if (!sameSubject(snapshot, grant)) return false;
  if (snapshot.subject.kind === 'work') {
    return probe.withdrawalEpoch <= snapshot.subject.judgment_basis.evidence_watermark;
  }
  return !snapshot.subject.admitted_evidence.some((evidenceId) => probe.withdrawnEvidence.includes(evidenceId));
}

export async function runAttempt(snapshot: FrozenRun, grant: RunGrant, runtime: ExecutorRuntime): Promise<RunReceipt> {
  if (!runtime?.db || !runtime.principal || typeof runtime.now !== 'function') return unavailableReceipt(grant);
  const delivery = (snapshot.subject.kind === 'work' && snapshot.subject.next_action === 'publish_pr')
    || (grant.subject_kind === 'work' && grant.next_action === 'publish_pr');
  if ((!delivery || snapshot.controller !== 'run') && existsSync(ledgerPath(snapshot.ledger_dir, 'execution_claim', grant.attempt_id))) {
    return unavailableReceipt(grant); // Other routes cannot take over a claimed delivery attempt.
  }
  let execution: DeliveryExecution | undefined;
  if (delivery && snapshot.controller === 'run') {
    try {
      execution = await prepareDelivery(snapshot, grant);
      const replay = claimDelivery(execution, snapshot, grant, runtime);
      if (replay) return replay;
    } catch {
      return unavailableReceipt(grant);
    }
  }
  try {
    assertRunAdmission(runtime, grant);
  } catch {
    return unavailableReceipt(grant);
  }
  const finish = (
    classification: 'agent_completed' | 'technical_failure', exitCode: number | null, parsed: TerminalParse | null,
    reservationId: string | null, artifact?: DeliveryArtifact,
  ) => {
    if (classification === 'agent_completed') {
      try {
        assertRunAdmission(runtime, grant);
      } catch {
        classification = 'technical_failure';
        artifact = undefined;
      }
    }
    return storeTerminal(execution ? { ...snapshot, ledger_dir: execution.ledgerRoot } : snapshot, grant, classification,
      exitCode, parsed, reservationId, artifact, execution?.bindingHash);
  };
  if (snapshot.controller === 'policy_wait') {
    if (!sameSubject(snapshot, grant)) return delivery ? unavailableReceipt(grant) : finish('technical_failure', null, null, null);
    const path = persistRecord(snapshot.ledger_dir, 'policy_wait', grant.attempt_id, {
      classification: 'policy_wait',
      origin: 'controller',
      attempt_id: grant.attempt_id,
      subject: snapshot.subject,
    });
    return receipt('policy_wait', grant.attempt_id, null, null, path, path, null, null);
  }
  if (!sameSubject(snapshot, grant) || (snapshot.resume?.requested && !resumeAllowed(snapshot, grant, snapshot.resume))) {
    return finish('technical_failure', null, null, null);
  }
  if (!snapshot.bundle_present) {
    return finish('technical_failure', snapshot.terminal?.exitCode ?? null, null, null);
  }
  const terminal = await observeTerminal(snapshot, grant, runtime, execution).catch(() => null);
  if (!terminal) {
    return finish('technical_failure', null, null, null);
  }
  let reservationId: string | null = null;
  if (snapshot.paid) {
    try {
      assertRunAdmission(runtime, grant);
      const paid = await dispatchPaidNext(snapshot.paid);
      reservationId = paid.reservationId;
      if (!paid.sent || paid.settled !== 'settled') {
        return finish('technical_failure', terminal.exitCode, null, reservationId);
      }
    } catch {
      return finish('technical_failure', terminal.exitCode, null, reservationId);
    }
  }
  const parsed = parseTerminal(snapshot.backend, terminal.stdout);
  const outputsValid = snapshot.bundle_present && parsed.outputsValid;
  const finished = completedRun({
    closed: terminal.closed,
    drained: terminal.drained,
    exitCode: terminal.exitCode,
    finalCount: parsed.finalCount,
    completed: parsed.completed,
    outputsValid,
  });
  const classification = finished && parsed.usage !== null ? 'agent_completed' : 'technical_failure';
  if (execution && classification === 'agent_completed') {
    try {
      const output = sealPlan(execution, parsed.answerText, grant, runtime);
      return finish(classification, terminal.exitCode, parsed, reservationId, output);
    } catch {
      return finish('technical_failure', terminal.exitCode, parsed, reservationId);
    }
  }
  return finish(classification, terminal.exitCode, parsed, reservationId);
}

type DeliveryExecution = {
  binding: DeliveryBinding;
  bindingHash: string;
  request: ReturnType<typeof createDeliveryRequest>;
  outputRoot: string;
  ledgerRoot: string;
};

function unavailableReceipt(grant: RunGrant): RunReceipt {
  return receipt('technical_failure', grant.attempt_id, null, null, '', null, null, null);
}

async function prepareDelivery(snapshot: FrozenRun, grant: RunGrant): Promise<DeliveryExecution> {
  if (!snapshot.deliveryPlan || snapshot.subject.kind !== 'work' || !sameSubject(snapshot, grant) || !snapshot.bundle_present
    || grant.subject_kind !== 'work' || grant.phase !== 'delivery' || !grant.allowed_effects.includes('publish_pr')
    || (snapshot.resume?.requested && !resumeAllowed(snapshot, grant, snapshot.resume))) throw new Error('UNAUTHORIZED_DELIVERY');
  const { source_revision, source_sha256, sourceBytes } = snapshot.deliveryPlan;
  const binding = { source_revision, source_sha256, work_id: snapshot.subject.work_id, generation: snapshot.subject.generation,
    attempt_id: grant.attempt_id, basis_hash: snapshot.subject.judgment_basis.hash,
    evidence_watermark: snapshot.subject.judgment_basis.evidence_watermark };
  assertDeliveryBinding(binding);
  const bytes = Buffer.from(sourceBytes);
  ensureLedgerDirectory(snapshot.ledger_dir);
  const outputRoot = await realpath(snapshot.cwd);
  const ledgerRoot = await realpath(snapshot.ledger_dir);
  if (outputRoot === ledgerRoot || outputRoot.startsWith(ledgerRoot + sep) || ledgerRoot.startsWith(outputRoot + sep)) {
    throw new Error('DELIVERY_LEDGER_NOT_ISOLATED');
  }
  const request = createDeliveryRequest(bytes, binding);
  const bindingHash = createHash('sha256').update(JSON.stringify([
    'delivery-attempt-v1', Object.values(binding), request.sha256, grant.grant_id, grant.mandate_id,
    snapshot.backend, snapshot.home, snapshot.config_hash, snapshot.session_id, snapshot.subject.resume_phase,
    outputRoot, ledgerRoot,
  ])).digest('hex');
  return { outputRoot, ledgerRoot, binding, request, bindingHash };
}

function claimDelivery(execution: DeliveryExecution, snapshot: FrozenRun, grant: RunGrant, runtime: ExecutorRuntime): RunReceipt | null {
  const path = ledgerPath(execution.ledgerRoot, 'terminal', grant.attempt_id);
  const claimPath = ledgerPath(execution.ledgerRoot, 'execution_claim', grant.attempt_id);
  const key = { binding: execution.bindingHash, attempt_id: grant.attempt_id, grant_id: grant.grant_id,
    request_sha256: execution.request.sha256 };
  if (!existsSync(path)) {
    try {
      assertRunAdmission(runtime, grant);
      persistRecord(execution.ledgerRoot, 'execution_claim', grant.attempt_id, key);
      if (!existsSync(path)) return null;
      throw new Error('DELIVERY_TERMINAL_PREEXISTED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const decode = (filename: string) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readExactFile(filename, 64 * 1024, 'supervisor_record')));
  const claim = decode(claimPath) as Partial<typeof key>;
  if (claim.binding !== key.binding || claim.attempt_id !== key.attempt_id
    || claim.grant_id !== key.grant_id || claim.request_sha256 !== key.request_sha256) throw new Error('DELIVERY_CLAIM_MISMATCH');
  const terminal = decode(path) as {
    execution_binding?: string; attempt_id?: string; backend?: BackendId; origin?: string;
    classification: 'agent_completed' | 'technical_failure'; session_id: string | null; exit_code: number | null;
    delivery_artifact?: DeliveryArtifact; usage: TerminalParse['usage']; reservation_id: string | null;
  };
  if (terminal.execution_binding !== key.binding || terminal.attempt_id !== key.attempt_id
    || terminal.backend !== snapshot.backend || terminal.origin !== 'wrapper'
    || !['agent_completed', 'technical_failure'].includes(terminal.classification)) throw new Error('DELIVERY_TERMINAL_MISMATCH');
  if (terminal.classification === 'agent_completed') {
    const markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(readExactFile(join(execution.outputRoot, 'plan.md'), planLimit));
    const sealed = sealDeliveryMarkdown(markdown, execution.binding, execution.request.sha256).artifact;
    if (terminal.exit_code !== 0 || !terminal.delivery_artifact
      || Object.entries(sealed).some(([field, expected]) => terminal.delivery_artifact?.[field as keyof DeliveryArtifact] !== expected)) {
      throw new Error('DELIVERY_OUTPUT_CHANGED');
    }
  }
  return receipt(terminal.classification, grant.attempt_id, terminal.session_id, terminal.exit_code, path, null,
    terminal.usage, terminal.reservation_id);
}

async function observeTerminal(
  snapshot: FrozenRun, grant: RunGrant, runtime: ExecutorRuntime, execution?: DeliveryExecution,
): Promise<ObservedProcess | null> {
  assertRunAdmission(runtime, grant);
  // Grok's file prompt lives in an executor-writable workspace; it cannot attest a delivery input.
  if (execution && snapshot.backend === 'grok') return null;
  const prompt = execution?.request.text;
  const invocation = backendInvocation(snapshot);
  const binary = findExecutable(invocation.command);
  if (!binary) return execution ? null : snapshot.terminal;
  if (snapshot.backend === 'dsh') {
    assertRunAdmission(runtime, grant);
    installDshProfile(snapshot.home);
  }
  const args = prompt && snapshot.backend === 'codex' ? [...invocation.args, '-'] : invocation.args;
  return runClosed(binary, args, {
    cwd: execution?.outputRoot,
    env: { ...process.env, ...invocation.env },
    pipeStdin: invocation.stdin,
    stdinText: invocation.stdin ? prompt : undefined,
    beforeSpawn: () => assertRunAdmission(runtime, grant),
  });
}

function sealPlan(execution: DeliveryExecution, markdown: string | undefined, grant: RunGrant, runtime: ExecutorRuntime): DeliveryArtifact {
  if (markdown === undefined) throw new Error('DELIVERY_PLAN_MISSING');
  const { bytes, artifact } = sealDeliveryMarkdown(markdown, execution.binding, execution.request.sha256);
  assertRunAdmission(runtime, grant);
  writeFileSync(join(execution.outputRoot, 'plan.md'), bytes, { flag: 'wx', mode: 0o600, flush: true });
  syncDirectory(execution.outputRoot);
  return artifact;
}

function backendInvocation(snapshot: FrozenRun): {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  stdin: boolean;
} {
  if (snapshot.backend === 'dsh') return dshInvocation(snapshot.home);
  if (snapshot.backend === 'codex') {
    return codexInvocation({ home: snapshot.home, resumeSession: snapshot.session_id });
  }
  return grokInvocation({
    home: snapshot.home,
    resumeSession: snapshot.session_id,
    promptFile: join(snapshot.cwd, 'prompt.txt'),
  });
}

export function parseTerminal(backend: BackendId, stdout: string): TerminalParse {
  if (backend === 'codex') return parseCodexTerminal(stdout);
  if (backend === 'grok') return parseGrokTerminal(stdout);
  return parseDshTerminal(stdout);
}

function sameSubject(snapshot: FrozenRun, grant: RunGrant): boolean {
  if (snapshot.subject.kind === 'work') {
    return grant.subject_kind === 'work'
      && grant.work_id === snapshot.subject.work_id
      && grant.generation === snapshot.subject.generation
      && grant.next_action === snapshot.subject.next_action
      && grant.basis_hash === snapshot.subject.judgment_basis.hash;
  }
  return grant.subject_kind === 'consultation'
    && grant.request_id === snapshot.subject.request_id
    && grant.result_version === snapshot.subject.result_version;
}

function storeTerminal(
  snapshot: FrozenRun,
  grant: RunGrant,
  classification: 'agent_completed' | 'technical_failure',
  exitCode: number | null,
  parsed: TerminalParse | null,
  reservationId: string | null,
  deliveryArtifact?: DeliveryArtifact,
  bindingHash?: string,
): RunReceipt {
  const path = persistRecord(snapshot.ledger_dir, 'terminal', grant.attempt_id, {
    classification,
    origin: 'wrapper',
    attempt_id: grant.attempt_id,
    backend: snapshot.backend,
    session_id: parsed?.sessionId ?? null,
    exit_code: exitCode,
    subject: snapshot.subject,
    usage: parsed?.usage ?? null,
    reservation_id: reservationId,
    ...(bindingHash ? { execution_binding: bindingHash } : {}),
    ...(deliveryArtifact ? { delivery_artifact: deliveryArtifact } : {}),
  });
  return receipt(classification, grant.attempt_id, parsed?.sessionId ?? null, exitCode, path, null, parsed?.usage ?? null, reservationId);
}

function receipt(
  classification: RunClassification,
  attemptId: string,
  sessionId: string | null,
  exitCode: number | null,
  persistedPath: string,
  policyWaitPath: string | null,
  usage: TerminalParse['usage'],
  reservationId: string | null,
): RunReceipt {
  return {
    classification,
    attempt_id: attemptId,
    session_id: sessionId,
    exit_code: exitCode,
    persisted_path: persistedPath,
    policy_wait_path: policyWaitPath,
    usage,
    reservation_id: reservationId,
  };
}
