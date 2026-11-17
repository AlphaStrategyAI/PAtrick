import { readCapability } from './capability.js';
import { isRecord, jsonLines, tokenUsage } from './parse.js';
import type { BackendCapability, TerminalParse } from '../types.js';

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
  let usage: TerminalParse['usage'] = null;
  for (const event of jsonLines(stdout)) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
    else if (event.type === 'item.completed' && isRecord(event.item) && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      text = event.item.text;
    } else if (event.type === 'turn.completed') {
      finals += 1;
      usage = tokenUsage(event.usage, { input: 'input_tokens', output: 'output_tokens', cached: ['cached_input_tokens'] });
    } else if (event.type === 'turn.failed' || event.type === 'error') failed = true;
  }
  const completed = finals === 1 && !failed && text.trim().length > 0;
  return {
    finalCount: finals,
    answerText: text,
    completed,
    outputsValid: completed && sessionId !== null,
    sessionId,
    usage,
  };
}

export function probe(): Promise<BackendCapability> {
  return readCapability({
    backend: 'codex',
    resumeArgs: ['exec', '--help'],
    resumeMark: 'resume',
    invocation: (home) => codexInvocation({ home, resumeSession: null }),
    parse: parseCodexTerminal,
  });
}
