import { createPatrickCli } from '../cli/patrick.mjs';
import {
  createRuntimeCli,
  isRuntimeMain,
  unavailableRuntimeDiagnostic,
  type RuntimeProvisioning,
} from './composition.js';

export { applyHostRegistry, createFirstInstallCli, hostRegistryRoot, planHostRegistry, readHostRegistry } from './composition.js';

export function createInstalledCli(provisioning: RuntimeProvisioning) {
  return createRuntimeCli(provisioning);
}

async function main(): Promise<void> {
  const result = await createPatrickCli().run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}

if (isRuntimeMain(import.meta.url)) {
  void main().catch(() => {
    const result = unavailableRuntimeDiagnostic();
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  });
}
