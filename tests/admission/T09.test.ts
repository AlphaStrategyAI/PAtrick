import { expect, test } from 'vitest';
import { probe as probeCodex } from '../../packages/executor/src/backends/codex.js';
import { LOCKED_DSH_VERSION, probe as probeDsh } from '../../packages/executor/src/backends/dsh.js';
import { probe as probeGrok } from '../../packages/executor/src/backends/grok.js';
import { runCommand } from '../../packages/executor/src/command.js';
import { evidenceSha256 } from '../../packages/executor/src/hash.js';
import { assessProbe, limaGuestMarkerPresent, versionCommand } from '../../packages/executor/src/probe.js';
import type { BackendId, CommandResult } from '../../packages/executor/src/types.js';

const BACKENDS: readonly BackendId[] = ['codex', 'grok', 'dsh'];
const PROBES = { codex: probeCodex, grok: probeGrok, dsh: probeDsh } as const;

test('each backend probe records the command result and the hash of that observation', async () => {
  const isolated = limaGuestMarkerPresent();
  for (const backend of BACKENDS) {
    const capability = await PROBES[backend]();
    const spec = versionCommand(backend);
    const version = await runCommand(spec.command, spec.args);
    const record = assessProbe(backend, version, {
      isolated,
      liveTerminal: capability.liveTerminal,
      liveToolCall: capability.liveToolCall,
    }, [
      noted(spec.command, spec.args, version),
    ]);
    const versionText = version.stdout.trim();
    const commandMatched = version.exitCode === 0 && version.error === null && versionText.length > 0;
    const pinOk = backend === 'dsh' ? versionText === LOCKED_DSH_VERSION : commandMatched;
    const ready = commandMatched && pinOk && isolated && capability.liveTerminal && capability.liveToolCall;
    expect(capability.backend).toBe(backend);
    expect(capability.command).toBe(`${spec.command} ${spec.args.join(' ')}`);
    expect(record.command).toBe(capability.command);
    expect(capability.version).toBe(commandMatched ? versionText : null);
    expect(record.evidenceSha256).toBe(evidenceSha256(record.observation));
    expect(record.available).toBe(ready);
    expect(record.status).toBe(ready ? 'verified' : 'blocked');
    expect(record.observation).not.toMatch(/thread-fixture|grok-fixture|session-fixture/);
    if (version.error) expect(record.observation).toContain(version.error);
    if (versionText) expect(record.observation).toContain(versionText.split('\n')[0] ?? versionText);
    if (backend === 'dsh' && versionText !== LOCKED_DSH_VERSION) {
      expect(record.observation).toContain(LOCKED_DSH_VERSION);
      expect(record.available).toBe(false);
    }
    if (!commandMatched) {
      expect(capability.resumeSupported).toBe(false);
      expect(capability.liveTerminal).toBe(false);
    }
    if (version.error?.includes('ENOENT')) expect(capability.liveToolCall).toBe(false);
    if (!isolated) expect(record.observation).toContain('blocked: executor is not inside the lima guest');
    if (!capability.liveTerminal) expect(record.observation).toContain('blocked: no isolated terminal readback');
    if (!capability.liveToolCall) expect(record.observation).toContain('blocked: no live harness tool call');
  }
}, 300_000);

function noted(command: string, args: readonly string[], result: CommandResult): string {
  const lines = [`${command} ${args.join(' ')}`, `exit=${result.exitCode ?? 'null'}`];
  if (result.error) lines.push(result.error);
  if (result.stdout.trim()) lines.push(result.stdout.trim());
  if (result.stderr.trim()) lines.push(result.stderr.trim());
  return lines.join('\n');
}
