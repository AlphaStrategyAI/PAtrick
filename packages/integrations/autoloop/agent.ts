import { existsSync } from 'node:fs';

export type ResumePhase = 'answer' | 'evidence_ready';

export type ResumeKey = {
  work_id: string;
  generation: number;
  question_id: string;
  answer_event_id: string;
  phase: ResumePhase;
};

export type ExecutionGrant = {
  grant_id: string;
  subject_kind: 'work';
  work_id: string;
  generation: number;
  phase: ResumePhase;
  answer_event_id: string;
};

export type ClaimContinuationResult =
  | { status: 'claimed'; grant: ExecutionGrant }
  | { status: 'waiting' }
  | { status: 'duplicate' };

/** T04 port. T08 and T10 replace this fixture with the grant ledger. */
export type ContinuationPort = {
  claimContinuation(key: ResumeKey, attemptId: string): ClaimContinuationResult | Promise<ClaimContinuationResult>;
};

export type ClaimFixture = ContinuationPort & {
  setClaimable(key: ResumeKey, claimable: boolean): void;
};

export type PolicyTurn = {
  prompt: string;
  cwd: string;
  contextFile: string;
  command?: string[];
  access?: 'read' | 'edit' | 'full';
  session?: string;
  resume?: string | null;
  folder?: string;
};

export type PolicyReading = {
  text?: string;
  error?: string;
  finished?: boolean;
  controller?: 'policy_wait' | 'claimed';
  hubOutcome?: 'done';
  noop?: boolean;
  modelCalls: number;
  technicalRetries: number;
};

export type WorkerSettlement = {
  controller: 'policy_wait' | 'claimed';
  hubResult: {
    outcome: 'done';
    summary: 'no-op' | 'claimed';
    later?: { key: 'answer'; cancel: true }[];
  };
  noop: boolean;
  modelCalls: number;
  technicalRetries: number;
  claim: ClaimContinuationResult;
};

const POLICY_SOURCE = `const mode = process.env.PATRICK_CLAIM ?? 'waiting';
if (mode === 'claimed') process.stdout.write('claimed\\n');
else process.stdout.write('no-op\\n');
`;

function resumeId(key: ResumeKey): string {
  return [key.work_id, String(key.generation), key.question_id, key.answer_event_id, key.phase].join('/');
}

export function createClaimFixture(): ClaimFixture {
  const claimable = new Set<string>();
  const claimed = new Map<string, ExecutionGrant>();
  return {
    setClaimable(key, ready) {
      const id = resumeId(key);
      if (ready) claimable.add(id);
      else claimable.delete(id);
    },
    claimContinuation(key, attemptId) {
      const id = resumeId(key);
      const existing = claimed.get(id);
      if (existing) return { status: 'duplicate' };
      if (!claimable.has(id)) return { status: 'waiting' };
      const grant: ExecutionGrant = {
        grant_id: `fixture:${id}:${attemptId}`,
        subject_kind: 'work',
        work_id: key.work_id,
        generation: key.generation,
        phase: key.phase,
        answer_event_id: key.answer_event_id,
      };
      claimed.set(id, grant);
      return { status: 'claimed', grant };
    },
  };
}

export async function settleNativeAnswer(
  port: ContinuationPort,
  key: ResumeKey,
  attemptId: string,
): Promise<WorkerSettlement> {
  const claim = await port.claimContinuation(key, attemptId);
  if (claim.status !== 'claimed') {
    return {
      controller: 'policy_wait',
      hubResult: { outcome: 'done', summary: 'no-op', later: [{ key: 'answer', cancel: true }] },
      noop: true,
      modelCalls: 0,
      technicalRetries: 0,
      claim,
    };
  }
  return {
    controller: 'claimed',
    hubResult: { outcome: 'done', summary: 'claimed' },
    noop: false,
    modelCalls: 0,
    technicalRetries: 0,
    claim,
  };
}

export function doneAskRemainsUnanswered(result: { outcome: string; ask?: readonly unknown[] }): boolean {
  return result.outcome === 'done' && Array.isArray(result.ask) && result.ask.length > 0;
}

export function command(turn: PolicyTurn): string[] {
  if (turn.command && turn.command.length > 0) return [...turn.command];
  return [process.execPath, '--eval', POLICY_SOURCE];
}

export function read(stdout: string, code: number | null, stderr: string): PolicyReading {
  if (code === null) return { modelCalls: 0, technicalRetries: 0 };
  if (stderr.includes('model-called')) {
    return { error: stderr, finished: true, modelCalls: 1, technicalRetries: 0 };
  }
  if (code !== 0) {
    return {
      error: stderr || stdout || `退出码 ${code}`,
      finished: true,
      modelCalls: 0,
      technicalRetries: 0,
    };
  }
  const text = stdout;
  const first = text.split('\n')[0] ?? '';
  if (first === 'no-op') {
    return {
      text,
      finished: true,
      controller: 'policy_wait',
      hubOutcome: 'done',
      noop: true,
      modelCalls: 0,
      technicalRetries: 0,
    };
  }
  if (first === 'claimed') {
    return {
      text,
      finished: true,
      controller: 'claimed',
      hubOutcome: 'done',
      noop: false,
      modelCalls: 0,
      technicalRetries: 0,
    };
  }
  return { text, finished: true, modelCalls: 0, technicalRetries: 0 };
}

export function check(program?: string): string | null {
  if (program && !existsSync(program)) return `程序不存在：${program}`;
  return null;
}
