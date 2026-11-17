import { EMPTY_TERMINAL, type BackendCapability, type TerminalParse } from '../types.js';
import { readCapability } from './capability.js';
import { isRecord, jsonLines, tokenUsage } from './parse.js';

export type Invocation = {
  command: string;
  args: string[];
  env: { GROK_HOME: string };
  stdin: false;
};

const GROK_TOKENS = { input: 'input_tokens', output: 'output_tokens', cached: ['cache_read_input_tokens', 'cached_input_tokens'] } as const;

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
  let usage: TerminalParse['usage'] = null;
  for (const parsed of jsonLines(trimmed)) {
    if (parsed.type !== 'end') continue;
    finals += 1;
    if (parsed.stopReason === 'end_turn') endTurn = true;
    if (typeof parsed.sessionId === 'string') sessionId = parsed.sessionId;
    usage = tokenUsage(parsed.usage, GROK_TOKENS) ?? usage;
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
  const text = typeof event.result === 'string' ? event.result : '';
  const sessionId = typeof event.session_id === 'string' ? event.session_id : null;
  const completed = endTurn && text.trim().length > 0;
  return {
    finalCount: 1,
    answerText: text,
    completed,
    outputsValid: completed && sessionId !== null,
    sessionId,
    usage: tokenUsage(event.usage, GROK_TOKENS),
  };
}

export function probe(): Promise<BackendCapability> {
  return readCapability({
    backend: 'grok',
    resumeArgs: ['--help'],
    resumeMark: '--resume',
    invocation: (home) => grokInvocation({ home, resumeSession: null, promptFile: `${home}/prompt.txt` }),
    parse: parseGrokTerminal,
  });
}
