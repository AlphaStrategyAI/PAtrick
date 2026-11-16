import { EMPTY_TERMINAL, type TerminalParse, type TokenUsage } from '../types.js';

export type Invocation = {
  command: string;
  args: string[];
  env: { GROK_HOME: string };
  stdin: false;
};

export function grokInvocation(input: { home: string; resumeSession: string | null; promptFile: string }): Invocation {
  const args = ['--output-format', 'json', '--no-subagents'];
  if (input.resumeSession) args.push('--resume', input.resumeSession);
  else args.push('--prompt-file', input.promptFile);
  return { command: 'grok', args, env: { GROK_HOME: input.home }, stdin: false };
}

export function parseGrokTerminal(stdout: string): TerminalParse {
  const trimmed = stdout.trim();
  if (!trimmed) return EMPTY_TERMINAL;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.stop_reason === 'string') return oneGrok(parsed);
  } catch {
    // A stream is one JSON object per line.
  }
  let finals = 0;
  let endTurn = false;
  let sessionId: string | null = null;
  let usage: TokenUsage | null = null;
  for (const line of trimmed.split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== 'end') continue;
    finals += 1;
    if (parsed.stopReason === 'end_turn') endTurn = true;
    if (typeof parsed.sessionId === 'string') sessionId = parsed.sessionId;
    usage = tokenUsage(parsed.usage) ?? usage;
  }
  const completed = finals === 1 && endTurn;
  return {
    finalCount: finals,
    completed,
    outputsValid: completed && sessionId !== null,
    sessionId,
    usage,
  };
}

function oneGrok(event: Record<string, unknown>): TerminalParse {
  const endTurn = event.stop_reason === 'end_turn';
  const text = typeof event.result === 'string' ? event.result.trim() : '';
  const sessionId = typeof event.session_id === 'string' ? event.session_id : null;
  const completed = endTurn && text.length > 0;
  return {
    finalCount: 1,
    completed,
    outputsValid: completed && sessionId !== null,
    sessionId,
    usage: tokenUsage(event.usage),
  };
}

function tokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const input = token(value.input_tokens);
  const output = token(value.output_tokens);
  const cached = token(value.cache_read_input_tokens ?? value.cached_input_tokens);
  if (input + output + cached <= 0) return null;
  return { input, output, cached };
}

function token(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
