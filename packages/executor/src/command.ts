import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { CommandResult, ObservedProcess } from './types.js';

export type ClosedProcess = ObservedProcess & { error: string | null };

export type CommandOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  pipeStdin?: boolean;
  stdinText?: string;
  timeoutMs?: number;
};

export function findExecutable(command: string, pathEnv = process.env.PATH ?? ''): string | null {
  const candidates = command.includes('/')
    ? [command]
    : pathEnv.split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // This PATH entry does not have the command.
    }
  }
  return null;
}

export function runClosed(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<ClosedProcess> {
  const timeoutMs = options.timeoutMs ?? 20000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (result: ClosedProcess) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.pipeStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      finish({ closed: false, drained: false, exitCode: null, stdout, stderr, error: 'missing stdio' });
      return;
    }
    stdoutStream.setEncoding('utf8');
    stderrStream.setEncoding('utf8');
    stdoutStream.on('data', (chunk: string) => {
      stdout += chunk;
    });
    stderrStream.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('spawn', () => {
      if (options.pipeStdin && child.stdin) {
        child.stdin.on('error', () => { /* Early child exit is classified by the terminal result. */ });
        child.stdin.end(options.stdinText);
      }
    });
    child.on('error', (error) => {
      finish({ closed: false, drained: false, exitCode: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code) => {
      finish({
        closed: true,
        drained: true,
        exitCode: timedOut ? null : code,
        stdout,
        stderr,
        error: timedOut ? `timeout ${timeoutMs}ms` : null,
      });
    });
  });
}

export async function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs = 20000,
  options: Omit<CommandOptions, 'timeoutMs'> = {},
): Promise<CommandResult> {
  const closed = await runClosed(command, args, { ...options, timeoutMs });
  return {
    exitCode: closed.exitCode,
    stdout: closed.stdout,
    stderr: closed.stderr,
    error: closed.error,
  };
}
