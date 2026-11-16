import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClosed, runCommand } from '../command.js';
import type { BackendCapability, BackendId, TerminalParse } from '../types.js';
import { isRecord } from './parse.js';

const HARNESS_TOOL_NAMES = new Set(['patrick-memory', 'patrick-judgment', 'patrick-bridge']);
const TOOL_NAME_KEYS = new Set(['name', 'tool', 'tool_name', 'toolName', 'function_name', 'functionName']);

export type BackendLaunch = {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  stdin: boolean;
};

export function sameProcessToolCall(input: {
  error: string | null;
  stdout: string;
  stderr: string;
  sessionId: string | null;
}): boolean {
  if (input.error?.includes('ENOENT')) return false;
  if (input.sessionId === null) return false;
  return jsonValues(input.stdout).some(valueNamesHarnessTool) || jsonValues(input.stderr).some(valueNamesHarnessTool);
}

export function versionCommand(backend: BackendId): { command: string; args: string[] } {
  if (backend === 'codex') return { command: 'codex', args: ['--version'] };
  if (backend === 'grok') return { command: 'grok', args: ['--version'] };
  return { command: 'dsh', args: ['--version'] };
}

export async function readCapability(input: {
  backend: BackendId;
  resumeArgs: readonly string[];
  resumeMark: string;
  invocation: (home: string) => BackendLaunch;
  parse: (stdout: string) => TerminalParse;
  prepare?: (home: string) => void;
}): Promise<BackendCapability> {
  const spec = versionCommand(input.backend);
  const versionResult = await runCommand(spec.command, spec.args, 8000);
  const versionText = versionResult.stdout.trim();
  const version = versionResult.exitCode === 0 && versionResult.error === null && versionText ? versionText : null;
  const home = mkdtempSync(join(tmpdir(), 'patrick-backend-'));
  try {
    input.prepare?.(home);
    const invocation = input.invocation(home);
    const env = { ...process.env, ...invocation.env };
    let resumeSupported = false;
    if (version !== null) {
      const help = await runCommand(spec.command, input.resumeArgs, 8000, { env });
      const helpText = `${help.stdout}\n${help.stderr}`;
      resumeSupported = help.exitCode === 0 && help.error === null && helpText.includes(input.resumeMark);
    }
    const headless = await runClosed(invocation.command, invocation.args, {
      env,
      pipeStdin: invocation.stdin,
      timeoutMs: 8000,
    });
    const parsed = input.parse(headless.stdout);
    const liveTerminal = headless.closed
      && headless.drained
      && headless.error === null
      && headless.exitCode === 0
      && parsed.finalCount === 1
      && parsed.completed
      && parsed.outputsValid
      && parsed.sessionId !== null;
    const liveToolCall = sameProcessToolCall({
      error: headless.error,
      stdout: headless.stdout,
      stderr: headless.stderr,
      sessionId: parsed.sessionId,
    });
    return {
      backend: input.backend,
      command: `${spec.command} ${spec.args.join(' ')}`,
      version,
      resumeSupported,
      liveTerminal,
      liveToolCall,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function valueNamesHarnessTool(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(valueNamesHarnessTool);
  if (!isRecord(value)) return false;
  for (const [key, inner] of Object.entries(value)) {
    if (TOOL_NAME_KEYS.has(key) && typeof inner === 'string' && HARNESS_TOOL_NAMES.has(inner)) return true;
    if (valueNamesHarnessTool(inner)) return true;
  }
  return false;
}

function jsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      // A JSONL stream or a sentence is scanned for an object below.
    }
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '{' && char !== '[') continue;
    const end = jsonValueEnd(text, index);
    if (end < 0) continue;
    try {
      values.push(JSON.parse(text.slice(index, end)));
      index = end - 1;
    } catch {
      // This brace is not the start of a JSON value.
    }
  }
  return values;
}

function jsonValueEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      const open = stack.pop();
      if (open === undefined) return -1;
      if ((open === '{') !== (char === '}')) return -1;
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}
