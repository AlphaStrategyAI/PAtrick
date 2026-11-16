import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { LOCKED_DSH_COMMIT, LOCKED_DSH_VERSION } from './backends/dsh.js';
import { evidenceSha256 } from './hash.js';
import type { BackendId, CommandResult, ProbeGates, ProbeRecord } from './types.js';

export function versionCommand(backend: BackendId): { command: string; args: string[] } {
  if (backend === 'codex') return { command: 'codex', args: ['--version'] };
  if (backend === 'grok') return { command: 'grok', args: ['--version'] };
  return { command: 'dsh', args: ['--version'] };
}

export function limaGuestMarkerPresent(marker = '/etc/patrick-executor-vm'): boolean {
  return existsSync(marker);
}

export function assessProbe(backend: BackendId, result: CommandResult, gates: ProbeGates): ProbeRecord {
  const spec = versionCommand(backend);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const commandMatched = result.exitCode === 0 && result.error === null && stdout.length > 0;
  const pinOk = backend === 'dsh' ? stdout === LOCKED_DSH_VERSION : commandMatched;
  const lines: string[] = [];
  if (result.error) lines.push(result.error);
  if (stdout) lines.push(stdout);
  if (stderr) lines.push(stderr);
  if (backend === 'dsh' && stdout !== LOCKED_DSH_VERSION) {
    lines.push(`blocked: installed version does not match locked package ${LOCKED_DSH_VERSION} (${LOCKED_DSH_COMMIT})`);
  }
  if (!gates.isolated) lines.push('blocked: executor is not inside the lima guest');
  if (!gates.liveTerminal) lines.push('blocked: no isolated terminal readback');
  if (!gates.liveToolCall) lines.push('blocked: no live harness tool call');
  const observation = lines.join('\n');
  const available = commandMatched && pinOk && gates.isolated && gates.liveTerminal && gates.liveToolCall;
  return {
    backend,
    available,
    status: available ? 'verified' : 'blocked',
    command: `${spec.command} ${spec.args.join(' ')}`,
    observation,
    evidenceSha256: evidenceSha256(observation),
  };
}

export function runCommand(command: string, args: string[], timeoutMs = 20000): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ exitCode: null, stdout, stderr, error: `timeout ${timeoutMs}ms` });
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ exitCode: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ exitCode: code, stdout, stderr, error: null });
    });
  });
}

export async function probeBackend(
  backend: BackendId,
  gates: ProbeGates,
  runner: (command: string, args: string[]) => Promise<CommandResult> = runCommand,
): Promise<ProbeRecord> {
  const spec = versionCommand(backend);
  return assessProbe(backend, await runner(spec.command, spec.args), gates);
}
