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
  /** The text the backend reads from its standard input. */
  stdinText?: string;
};

export function sameProcessToolCall(input: {
  error: string | null;
  stdout: string;
  stderr: string;
  sessionId: string | null;
}): boolean {
  if (input.error?.includes('ENOENT')) return false;
  if (input.sessionId === null) return false;
  const values = [...jsonValues(input.stdout), ...jsonValues(input.stderr)];
  const failed = failedToolCallIds(values);
  return values.some((value) => succeededHarnessToolCall(value, failed));
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
  /** Prepares the backend home. It may return the cleanup of what it started. */
  prepare?: (home: string) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  /** How long a live turn may take. A model turn is slower than a version probe. */
  timeoutMs?: number;
  /** The reason the live turn cannot run, when the host provides no route. */
  blocked?: () => string | null;
}): Promise<BackendCapability> {
  const spec = versionCommand(input.backend);
  const versionResult = await runCommand(spec.command, spec.args, 8000);
  const versionText = versionResult.stdout.trim();
  const version = versionResult.exitCode === 0 && versionResult.error === null && versionText ? versionText : null;
  const home = mkdtempSync(join(tmpdir(), 'patrick-backend-'));
  let cleanup: void | (() => void | Promise<void>) = undefined;
  try {
    const blocked = input.blocked?.() ?? null;
    if (blocked) {
      const spec = versionCommand(input.backend);
      const result = await runCommand(spec.command, spec.args, 8000);
      return {
        backend: input.backend,
        command: `${spec.command} ${spec.args.join(' ')}`,
        version: result.exitCode === 0 && result.error === null && result.stdout.trim() ? result.stdout.trim() : null,
        resumeSupported: false,
        liveTerminal: false,
        liveToolCall: false,
        error: blocked,
      };
    }
    cleanup = await input.prepare?.(home);
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
      stdinText: invocation.stdinText,
      timeoutMs: input.timeoutMs ?? 8000,
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
    if (typeof cleanup === 'function') await cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * A tool call only counts when it carries a harness tool that was not refused.
 *
 * The name alone is not enough: a call that the approval policy turned down
 * never reached the bundle, so it must not read as a live tool call.
 */
function succeededHarnessToolCall(value: unknown, failed: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((entry) => succeededHarnessToolCall(entry, failed));
  if (!isRecord(value)) return false;
  for (const [key, inner] of Object.entries(value)) {
    if (TOOL_NAME_KEYS.has(key) && typeof inner === 'string' && isHarnessToolName(inner)) {
      const callId = typeof value.callId === 'string' ? value.callId : null;
      if (callId && failed.has(callId)) return false;
      return !refusedToolCall(value);
    }
  }
  return Object.values(value).some((inner) => succeededHarnessToolCall(inner, failed));
}

/** A harness tool may be named plainly or with the server prefix of its transport. */
function isHarnessToolName(name: string): boolean {
  if (HARNESS_TOOL_NAMES.has(name)) return true;
  return [...HARNESS_TOOL_NAMES].some((tool) => name.endsWith(`__${tool}`));
}

/** The calls the transport reported as failed, by their call id. */
function failedToolCallIds(values: readonly unknown[]): Set<string> {
  const failed = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isRecord(value)) return;
    if (typeof value.callId === 'string' && typeof value.status === 'string' && value.status === 'failed') {
      failed.add(value.callId);
    }
    Object.values(value).forEach(visit);
  };
  values.forEach(visit);
  return failed;
}

/** A tool call that failed or returned nothing never reached the domain. */
function refusedToolCall(value: Record<string, unknown>): boolean {
  if (value.error !== undefined && value.error !== null && value.error !== false) return true;
  if (value.status === 'failed') return true;
  if ('result' in value && value.result === null) return true;
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
