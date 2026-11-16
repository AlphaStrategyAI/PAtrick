import type { TerminalParse, TokenUsage } from '../types.js';

export type Invocation = {
  command: string;
  args: string[];
  env: { CODEX_HOME: string };
  stdin: true;
};

export function codexInvocation(input: { home: string; resumeSession: string | null }): Invocation {
  const args = ['exec'];
  if (input.resumeSession) args.push('resume', input.resumeSession);
  args.push('--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"');
  return { command: 'codex', args, env: { CODEX_HOME: input.home }, stdin: true };
}

export function parseCodexTerminal(stdout: string): TerminalParse {
  let sessionId: string | null = null;
  let text = '';
  let finals = 0;
  let failed = false;
  let usage: TokenUsage | null = null;
  for (const event of jsonLines(stdout)) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
    else if (event.type === 'item.completed' && isRecord(event.item) && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      text = event.item.text;
    } else if (event.type === 'turn.completed') {
      finals += 1;
      usage = tokenUsage(event.usage);
    } else if (event.type === 'turn.failed' || event.type === 'error') failed = true;
  }
  const completed = finals === 1 && !failed && text.trim().length > 0;
  return {
    finalCount: finals,
    completed,
    outputsValid: completed && sessionId !== null,
    sessionId,
    usage,
  };
}

function tokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const input = token(value.input_tokens);
  const output = token(value.output_tokens);
  const cached = token(value.cached_input_tokens);
  if (input + output + cached <= 0) return null;
  return { input, output, cached };
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // Shell profile noise is not a Codex event.
    }
  }
  return events;
}

function token(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
