import { dirname, resolve } from 'node:path';
import { admitReadRoot, readRegularFile, sha256 } from '../deploy/lib/release.mjs';
import { assertPilotTraceConsistency } from '../tests/support/pilot-trace.ts';

try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0] || args[0].startsWith('-')) throw new Error('PILOT_TRACE_ARGUMENT_INVALID');
  const path = resolve(args[0]);
  const root = dirname(path);
  const bytes = await readRegularFile(path, 1024 * 1024, admitReadRoot(root));
  const traces = JSON.parse(bytes.toString('utf8'));
  const checked = assertPilotTraceConsistency(traces, root);
  const routes = traces.map(({ route, evidenceRefs }) => ({ route, evidenceRefs }));
  console.log(JSON.stringify({ ...checked, traceSha256: sha256(bytes), routes }, null, 2));
} catch (error) {
  const codes = ['PILOT_TRACE_ARGUMENT_INVALID', 'PILOT_TRACE_INVALID', 'PILOT_EVIDENCE_INVALID'];
  console.error(codes.includes(error?.message) ? error.message : 'PILOT_TRACE_INPUT_UNAVAILABLE');
  process.exitCode = 1;
}
