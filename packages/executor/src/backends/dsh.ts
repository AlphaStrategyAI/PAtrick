import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_FILES, canonicalJson, evidenceSha256 } from '../hash.js';
import type { BackendCapability, TerminalParse, TokenUsage } from '../types.js';
import { readCapability } from './capability.js';
import { isRecord, jsonLines, positiveToken } from './parse.js';
import { startProbeDomain } from './probe-domain.js';
import { modelRouteFromEnv, type ModelRoute } from './codex.js';

export const LOCKED_DSH_VERSION = '0.2.2-rc.2';
export const LOCKED_DSH_COMMIT = 'e8f7b93a344964de3dca1ace9e72b6e4d6de87cb';
export const HARNESS_TOOLS = ['patrick-memory', 'patrick-judgment', 'patrick-bridge'] as const;

export const DSH_OVERLAY = {
  sessionReport: false,
  inventory: false,
  pluginAdmin: false,
  hmr: false,
  unattributedBackground: false,
  model: null,
  effort: null,
} as const;

export type Invocation = {
  command: string;
  args: readonly string[];
  env: { DSH_HOME: string };
  stdin: true;
  stdinText?: string;
};

export function dshInvocation(home: string, prompt?: string): Invocation {
  return {
    command: 'dsh',
    args: ['--profile', 'headless', '--json', '--approval-policy', 'never'],
    env: { DSH_HOME: home },
    stdin: true,
    stdinText: prompt,
  };
}

export function writeDshOverlay(home: string): { path: string; configHash: string } {
  const path = join(home, 'profiles', 'headless', 'patrick-overlay.json');
  mkdirSync(join(home, 'profiles', 'headless'), { recursive: true });
  const body = canonicalJson(DSH_OVERLAY);
  writeFileSync(path, body, 'utf8');
  return { path, configHash: evidenceSha256(body) };
}

const HARNESS_DIR = fileURLToPath(new URL('../../harness/', import.meta.url));
const MCP_SERVER = fileURLToPath(new URL('../../harness/mcp-server.ts', import.meta.url));

/** The prompt the probe sends: it has to make the model reach the bundle. */
export const DSH_PROBE_PROMPT = 'Call the patrick-memory tool once with the domain "personal", '
  + 'the knowledge id "K-001" and the withdrawal epoch 0. Then report how many records the tool returned.';

export function dshBundleDir(home: string): string {
  return join(home, 'profiles', 'headless', 'bundle');
}

export function installDshProfile(home: string): { path: string; configHash: string } {
  const overlay = writeDshOverlay(home);
  const bundleDir = dshBundleDir(home);
  mkdirSync(bundleDir, { recursive: true });
  for (const name of HARNESS_FILES) {
    copyFileSync(join(HARNESS_DIR, name), join(bundleDir, name));
  }
  return overlay;
}

/** Writes the profile patch: the model route, the default model and the bundle.
 *
 * The Harness bundle reaches the profile as an MCP server, the same transport
 * the Codex backend uses, so both backends call the same tools over the same
 * restricted RPC.
 */
export function installDshPatch(home: string, route: ModelRoute | null, rpc: { url: string; token: string } | null): void {
  const profile = join(home, 'profiles', 'headless');
  mkdirSync(profile, { recursive: true });
  const lines: string[] = [];
  if (route) {
    lines.push('- id: llm-pi-ai', '  config:', '    providers:', '      patrick-route:',
      `        apiKeyEnv: ${route.tokenEnv}`, '        api: openai-responses',
      `        baseURL: ${route.baseUrl}`, '        models:', `          - id: ${JSON.stringify(route.model)}`,
      '- id: agent-default-model', '  config:', '    provider: patrick-route',
      `    model: ${JSON.stringify(route.model)}`);
  }
  if (rpc) {
    lines.push('- insert:', '    - id: memory-patrick', '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:', '        serverName: patrick', '        transport: stdio', '        command: node',
      `        args: [${JSON.stringify(MCP_SERVER)}]`, '        env:',
      `          PATRICK_HARNESS_RPC_URL: ${JSON.stringify(rpc.url)}`,
      `          PATRICK_HARNESS_RPC_TOKEN: ${JSON.stringify(rpc.token)}`);
  }
  writeFileSync(join(profile, 'cordis.patch.yml'), `${lines.join('\n')}\n`, 'utf8');
}

export function parseDshTerminal(stdout: string): TerminalParse {
  let sessionId: string | null = null;
  let usage: TokenUsage | null = null;
  const finals: { kind: string | null; text: string; sessionId: string | null }[] = [];
  for (const event of jsonLines(stdout)) {
    if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId;
    else if (event.type === 'status' && event.phase === 'step_end') usage = addUsage(usage, event.usage);
    else if (event.type === 'final') {
      const reason = isRecord(event.reason) ? event.reason : null;
      finals.push({
        kind: reason && typeof reason.kind === 'string' ? reason.kind : null,
        text: typeof event.text === 'string' ? event.text : '',
        sessionId: typeof event.sessionId === 'string' ? event.sessionId : null,
      });
    }
  }
  const final = finals.length === 1 ? finals[0] : null;
  const sessionMatches = final?.sessionId === null || final?.sessionId === sessionId;
  const completed = final?.kind === 'completed' && (final.text.trim().length > 0) && sessionMatches && sessionId !== null;
  return {
    finalCount: finals.length,
    answerText: final?.text,
    completed,
    outputsValid: completed,
    sessionId,
    usage,
  };
}

export function probe(): Promise<BackendCapability> {
  return readCapability({
    backend: 'dsh',
    resumeArgs: ['--profile', 'headless', '--help'],
    resumeMark: 'resume',
    invocation: (home) => dshInvocation(home, DSH_PROBE_PROMPT),
    parse: parseDshTerminal,
    prepare: async (home) => {
      installDshProfile(home);
      const domain = await startProbeDomain(() => new Date());
      installDshPatch(home, modelRouteFromEnv(), { url: domain.url, token: domain.token });
      return async () => { await domain.close(); };
    },
    timeoutMs: 180_000,
    blocked: () => modelRouteFromEnv() ? null : 'blocked: no model route is configured for this backend',
  });
}

function addUsage(current: TokenUsage | null, value: unknown): TokenUsage | null {
  if (!isRecord(value)) return current;
  const input = positiveToken(value.inputTokens);
  const output = positiveToken(value.outputTokens);
  const cached = positiveToken(value.cacheReadTokens);
  if (input + output + cached <= 0) return current;
  return {
    input: (current?.input ?? 0) + input,
    output: (current?.output ?? 0) + output,
    cached: (current?.cached ?? 0) + cached,
  };
}
