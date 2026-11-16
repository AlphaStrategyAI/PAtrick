import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClosed, runCommand } from '../command.js';
import type { BackendCapability, BackendId, TerminalParse } from '../types.js';

export type BackendLaunch = {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  stdin: boolean;
};

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
}): Promise<BackendCapability> {
  const spec = versionCommand(input.backend);
  const versionResult = await runCommand(spec.command, spec.args, 8000);
  const versionText = versionResult.stdout.trim();
  const version = versionResult.exitCode === 0 && versionResult.error === null && versionText ? versionText : null;
  const home = mkdtempSync(join(tmpdir(), 'patrick-backend-'));
  try {
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
    return {
      backend: input.backend,
      command: `${spec.command} ${spec.args.join(' ')}`,
      version,
      resumeSupported,
      liveTerminal,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
