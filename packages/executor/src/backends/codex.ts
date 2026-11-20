import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readCapability } from './capability.js';
import { isRecord, jsonLines, tokenUsage } from './parse.js';
import { startProbeDomain } from './probe-domain.js';
import type { BackendCapability, TerminalParse } from '../types.js';

/** The model route of one call. The CLI reads the secret from its environment. */
export type ModelRoute = {
  baseUrl: string;
  model: string;
  tokenEnv: string;
};

/** The route of this installation, when the host provides one. */
export function modelRouteFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRoute | null {
  const baseUrl = env.PATRICK_MODEL_BASE_URL?.trim();
  const model = env.PATRICK_MODEL_ID?.trim();
  const tokenEnv = env.PATRICK_MODEL_TOKEN_ENV?.trim() || 'PATRICK_MODEL_TOKEN';
  if (!baseUrl || !model || !env[tokenEnv]?.trim()) return null;
  return { baseUrl, model, tokenEnv };
}

/** The prompt the probe sends: it has to make the model reach the bundle. */
export const PROBE_PROMPT = 'Call the patrick-memory tool once with the domain "personal", '
  + 'the knowledge id "K-001" and the withdrawal epoch 0. Then report how many records the tool returned.';

const MCP_SERVER = fileURLToPath(new URL('../../harness/mcp-server.ts', import.meta.url));
const BUNDLE_TOOLS = ['patrick-memory', 'patrick-judgment', 'patrick-bridge'];

/** Writes the Codex home: the model route and the Harness bundle. */
export function installCodexBundle(home: string, route: ModelRoute | null, rpc: { url: string; token: string } | null): void {
  mkdirSync(home, { recursive: true });
  const lines: string[] = [];
  if (route) {
    lines.push(`model = ${JSON.stringify(route.model)}`, 'model_provider = "patrick-route"', '',
      '[model_providers.patrick-route]', 'name = "patrick-route"',
      `base_url = ${JSON.stringify(route.baseUrl)}`, `env_key = ${JSON.stringify(route.tokenEnv)}`,
      'wire_api = "responses"');
  }
  if (rpc) {
    lines.push('', '[mcp_servers.patrick]', 'command = "node"',
      `args = [${JSON.stringify(MCP_SERVER)}]`, '[mcp_servers.patrick.env]',
      `PATRICK_HARNESS_RPC_URL = ${JSON.stringify(rpc.url)}`,
      `PATRICK_HARNESS_RPC_TOKEN = ${JSON.stringify(rpc.token)}`);
    // The bundle tools only read the admitted domain, so the CLI may run them
    // without asking the owner for every call.
    for (const tool of BUNDLE_TOOLS) {
      lines.push('', `[mcp_servers.patrick.tools.${tool}]`, 'approval_mode = "approve"');
    }
  }
  writeFileSync(`${home}/config.toml`, `${lines.join('\n')}\n`, 'utf8');
}

export type Invocation = {
  command: string;
  args: string[];
  env: { CODEX_HOME: string };
  stdin: true;
  stdinText?: string;
};

export function codexInvocation(input: { home: string; resumeSession: string | null; prompt?: string }): Invocation {
  const args = ['exec'];
  if (input.resumeSession) args.push('resume', input.resumeSession);
  args.push('--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"');
  return { command: 'codex', args, env: { CODEX_HOME: input.home }, stdin: true,
    stdinText: input.prompt ?? PROBE_PROMPT };
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
    prepare: async (home) => {
      const route = modelRouteFromEnv();
      const domain = await startProbeDomain(() => new Date());
      installCodexBundle(home, route, { url: domain.url, token: domain.token });
      return async () => { await domain.close(); };
    },
    timeoutMs: 180_000,
    blocked: () => modelRouteFromEnv() ? null : 'blocked: no model route is configured for this backend',
  });
}
