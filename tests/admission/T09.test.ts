import { expect, test } from 'vitest';
import { LOCKED_DSH_VERSION } from '../../packages/executor/src/backends/dsh.js';
import { evidenceSha256 } from '../../packages/executor/src/hash.js';
import { limaGuestMarkerPresent, probeBackend, runCommand, versionCommand } from '../../packages/executor/src/probe.js';
import type { BackendId } from '../../packages/executor/src/types.js';

const BACKENDS: readonly BackendId[] = ['codex', 'grok', 'dsh'];

test('each backend probe records the real command result and stays blocked without a live readback', async () => {
  const isolated = limaGuestMarkerPresent();
  for (const backend of BACKENDS) {
    const spec = versionCommand(backend);
    const real = await runCommand(spec.command, spec.args);
    const record = await probeBackend(backend, { isolated, liveTerminal: false, liveToolCall: false });
    const observed = real.stdout.trim() || real.stderr.trim() || real.error || '';
    expect(record.command).toBe(`${spec.command} ${spec.args.join(' ')}`);
    expect(record.evidenceSha256).toBe(evidenceSha256(record.observation));
    expect(record.available).toBe(false);
    expect(record.status).toBe('blocked');
    expect(record.observation).not.toMatch(/thread-fixture|grok-fixture|session-fixture/);
    if (observed) expect(record.observation).toContain(observed.split('\n')[0] ?? observed);
    if (backend === 'dsh' && real.stdout.trim() !== LOCKED_DSH_VERSION) {
      expect(record.observation).toContain(LOCKED_DSH_VERSION);
      expect(record.available).toBe(false);
    }
    expect(record.observation).toContain('blocked: no live harness tool call');
  }
});
