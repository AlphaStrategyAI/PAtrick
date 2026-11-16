import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_FILES, canonicalJson, evidenceSha256 } from '../hash.js';
import type { BackendCapability, TerminalParse, TokenUsage } from '../types.js';
import { readCapability } from './capability.js';
import { isRecord, jsonLines, positiveToken } from './parse.js';

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
};

export function dshInvocation(home: string): Invocation {
  return {
    command: 'dsh',
    args: ['--profile', 'headless', '--json', '--approval-policy', 'never'],
    env: { DSH_HOME: home },
    stdin: true,
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
    invocation: (home) => dshInvocation(home),
    parse: parseDshTerminal,
    prepare: installDshProfile,
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
