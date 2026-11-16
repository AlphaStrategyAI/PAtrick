export type BackendId = 'codex' | 'grok' | 'dsh';

export type RunClassification = 'agent_completed' | 'policy_wait' | 'technical_failure';

export type TokenUsage = {
  input: number;
  output: number;
  cached: number;
};

export type TerminalParse = {
  finalCount: number;
  completed: boolean;
  outputsValid: boolean;
  sessionId: string | null;
  usage: TokenUsage | null;
};

export type ObservedProcess = {
  closed: boolean;
  drained: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type WorkSubject = {
  kind: 'work';
  work_id: string;
  generation: number;
  judgment_basis: {
    hash: string;
    evidence_watermark: number;
  };
  next_action: string;
  resume_phase: 'answer' | 'evidence_ready' | null;
};

export type ConsultationSubject = {
  kind: 'consultation';
  request_id: string;
  result_version: number;
  admitted_evidence: readonly string[];
};

export type ResumeProbe = {
  requested: boolean;
  supported: boolean;
  backend: BackendId;
  home: string;
  configHash: string;
  processTreeStopped: boolean;
  revoked: boolean;
  withdrawalEpoch: number;
  withdrawnEvidence: readonly string[];
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
};

export type BackendCapability = {
  backend: BackendId;
  command: string;
  version: string | null;
  resumeSupported: boolean;
  liveTerminal: boolean;
};

export type ProbeGates = {
  isolated: boolean;
  liveTerminal: boolean;
  liveToolCall: boolean;
};

export type ProbeRecord = {
  backend: BackendId;
  available: boolean;
  status: 'verified' | 'blocked';
  command: string;
  observation: string;
  evidenceSha256: string;
};

export const EMPTY_TERMINAL: TerminalParse = {
  finalCount: 0,
  completed: false,
  outputsValid: false,
  sessionId: null,
  usage: null,
};
