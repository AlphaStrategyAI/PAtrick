import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_TERMINAL, type BackendCapability, type TerminalParse } from '../types.js';
import { readCapability } from './capability.js';
import { modelRouteFromEnv, type ModelRoute } from './codex.js';
import { isRecord, jsonLines, tokenUsage } from './parse.js';
import { startProbeDomain } from './probe-domain.js';

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

/** The invocation the probe uses: the stream shows the tool calls it made. */
export function grokProbeInvocation(input: { home: string; promptFile: string }): Invocation {
  return {
    command: 'grok',
    args: ['--output-format', 'streaming-json', '--no-subagents', '--prompt-file', input.promptFile],
    env: { GROK_HOME: input.home },
    stdin: false,
  };
}

export function parseGrokTerminal(stdout: string): TerminalParse {
  const trimmed = stdout.trim();
  if (!trimmed) return EMPTY_TERMINAL;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // The stream shape carries the type of the event; the final answer does not.
    if (isRecord(parsed) && parsed.type !== 'end'
        && (typeof parsed.stop_reason === 'string' || typeof parsed.stopReason === 'string')) {
      return oneGrok(parsed);
    }
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
  // The CLI writes the stop reason and the answer in camel case; the older
  // snake case shape is still accepted.
  const endTurn = (event.stopReason ?? event.stop_reason) === 'end_turn';
  const text = typeof event.text === 'string' ? event.text : typeof event.result === 'string' ? event.result : '';
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId
    : typeof event.session_id === 'string' ? event.session_id : null;
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

/** The model route and the bundle of the Grok home. */
export function installGrokProfile(home: string, route: ModelRoute | null, rpc: { url: string; token: string } | null): void {
  mkdirSync(home, { recursive: true });
  const lines: string[] = ['[ui]', 'permission_mode = "always-approve"'];
  if (route) {
    const key = `patrick/${route.model}`;
    lines.push('', '[models]', `default = ${JSON.stringify(key)}`, '', `[model.${JSON.stringify(key)}]`,
      `model = ${JSON.stringify(route.model)}`, 'name = "PAtrick model route"',
      `base_url = ${JSON.stringify(route.baseUrl)}`, `env_key = ${JSON.stringify(route.tokenEnv)}`,
      'api_backend = "chat_completions"', 'context_window = 1000000');
  }
  if (rpc) {
    lines.push('', '[mcp_servers.patrick]', 'command = "node"',
      `args = [${JSON.stringify(MCP_SERVER)}]`,
      `env = { PATRICK_HARNESS_RPC_URL = ${JSON.stringify(rpc.url)}, PATRICK_HARNESS_RPC_TOKEN = ${JSON.stringify(rpc.token)} }`);
  }
  writeFileSync(join(home, 'config.toml'), `${lines.join('\n')}\n`, 'utf8');
}

const MCP_SERVER = fileURLToPath(new URL('../../harness/mcp-server.ts', import.meta.url));

export function probe(): Promise<BackendCapability> {
  return readCapability({
    backend: 'grok',
    resumeArgs: ['--help'],
    resumeMark: '--resume',
    invocation: (home) => grokProbeInvocation({ home, promptFile: `${home}/prompt.txt` }),
    parse: parseGrokTerminal,
    prepare: async (home) => {
      // The Grok CLI reads its task from a file, not from its standard input.
      writeFileSync(`${home}/prompt.txt`, GROK_PROBE_PROMPT, 'utf8');
      const domain = await startProbeDomain(() => new Date());
      installGrokProfile(home, modelRouteFromEnv(), { url: domain.url, token: domain.token });
      return async () => { await domain.close(); };
    },
    timeoutMs: 180_000,
    blocked: () => modelRouteFromEnv() ? null : 'blocked: no model route is configured for this backend',
  });
}

/** The prompt the probe sends: it has to make the model reach the bundle. */
export const GROK_PROBE_PROMPT = 'Call the patrick-memory tool once with the domain "personal", '
  + 'the knowledge id "K-001" and the withdrawal epoch 0. Then report how many records the tool returned.';
