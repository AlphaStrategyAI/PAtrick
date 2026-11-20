import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleFingerprint, HARNESS_FILES } from './hash.js';

const HARNESS_DIR = fileURLToPath(new URL('../harness/', import.meta.url));

/**
 * Copies the Harness bundle into a backend home.
 *
 * The backend then runs the pinned copy, so the fingerprint of the bundle is
 * the fingerprint of the code that actually answered the model.
 */
export function installHarnessBundle(dir: string): { path: string; hash: string | null; tools: string[] } {
  mkdirSync(dir, { recursive: true });
  for (const name of HARNESS_FILES) copyFileSync(join(HARNESS_DIR, name), join(dir, name));
  const fingerprint = bundleFingerprint(dir);
  return { path: dir, hash: fingerprint.hash, tools: fingerprint.tools };
}

/** The MCP server inside an installed bundle. */
export function bundleMcpServer(dir: string): string {
  return join(dir, 'mcp-server.ts');
}
