import { existsSync } from 'node:fs';
import { versionCommand } from './backends/capability.js';
import { LOCKED_DSH_COMMIT, LOCKED_DSH_VERSION } from './backends/dsh.js';
import { runCommand } from './command.js';
import { evidenceSha256 } from './hash.js';
import type { BackendId, CommandResult, ProbeGates, ProbeRecord } from './types.js';

export { runCommand } from './command.js';
export { versionCommand } from './backends/capability.js';

export function limaGuestMarkerPresent(marker = '/etc/patrick-executor-vm'): boolean {
  return existsSync(marker);
}

export function assessProbe(
  backend: BackendId,
  result: CommandResult,
  gates: ProbeGates,
  notes: readonly string[] = [],
): ProbeRecord {
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
  for (const note of notes) {
    const text = note.trim();
    if (text) lines.push(text);
  }
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

export async function probeBackend(
  backend: BackendId,
  gates: ProbeGates,
  runner: (command: string, args: string[]) => Promise<CommandResult> = runCommand,
): Promise<ProbeRecord> {
  const spec = versionCommand(backend);
  return assessProbe(backend, await runner(spec.command, spec.args), gates);
}
