import { join } from 'node:path';
import type { RunGrant } from '../../domain/src/delegation.js';
import { codexInvocation, parseCodexTerminal } from './backends/codex.js';
import { dshInvocation, parseDshTerminal } from './backends/dsh.js';
import { grokInvocation, parseGrokTerminal } from './backends/grok.js';
import { dispatchPaidNext, type PaidDispatch } from '../harness/patrick-bridge.js';
import { findExecutable, runClosed } from './command.js';
import { persistRecord } from './ledger.js';
import type {
  BackendId,
  ConsultationSubject,
  ObservedProcess,
  ResumeProbe,
  RunClassification,
  TerminalParse,
  WorkSubject,
} from './types.js';

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

export async function runAttempt(snapshot: FrozenRun, grant: RunGrant): Promise<RunReceipt> {
  if (snapshot.controller === 'policy_wait') {
    if (!sameSubject(snapshot, grant)) return storeTerminal(snapshot, grant, 'technical_failure', null, null, null);
    const path = persistRecord(snapshot.ledger_dir, 'policy_wait', grant.attempt_id, {
      classification: 'policy_wait',
      origin: 'controller',
      attempt_id: grant.attempt_id,
      subject: snapshot.subject,
    });
    return receipt('policy_wait', grant.attempt_id, null, null, path, path, null, null);
  }
  if (!sameSubject(snapshot, grant) || (snapshot.resume?.requested && !resumeAllowed(snapshot, grant, snapshot.resume))) {
    return storeTerminal(snapshot, grant, 'technical_failure', null, null, null);
  }
  if (!snapshot.bundle_present) {
    return storeTerminal(snapshot, grant, 'technical_failure', snapshot.terminal?.exitCode ?? null, null, null);
  }
  const terminal = await observeTerminal(snapshot);
  if (!terminal) {
    return storeTerminal(snapshot, grant, 'technical_failure', null, null, null);
  }
  let reservationId: string | null = null;
  if (snapshot.paid) {
    try {
      const paid = await dispatchPaidNext(snapshot.paid);
      reservationId = paid.reservationId;
      if (!paid.sent || paid.settled !== 'settled') {
        return storeTerminal(snapshot, grant, 'technical_failure', terminal.exitCode, null, reservationId);
      }
    } catch {
      return storeTerminal(snapshot, grant, 'technical_failure', terminal.exitCode, null, reservationId);
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
  return storeTerminal(snapshot, grant, classification, terminal.exitCode, parsed, reservationId);
}

async function observeTerminal(snapshot: FrozenRun): Promise<ObservedProcess | null> {
  const invocation = backendInvocation(snapshot);
  const binary = findExecutable(invocation.command);
  if (!binary) return snapshot.terminal;
  return runClosed(binary, invocation.args, {
    env: { ...process.env, ...invocation.env },
    pipeStdin: invocation.stdin,
  });
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

function parseTerminal(backend: BackendId, stdout: string): TerminalParse {
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
): RunReceipt {
  const path = persistRecord(snapshot.ledger_dir, 'terminal', grant.attempt_id, {
    classification,
    origin: 'wrapper',
    attempt_id: grant.attempt_id,
    backend: snapshot.backend,
    session_id: parsed?.sessionId ?? null,
    exit_code: exitCode,
    subject: snapshot.subject,
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
