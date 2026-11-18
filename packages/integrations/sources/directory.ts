import { assertDirectoryReaderAvailable } from './directory-capability.js';
import {
  listSamples as fixtureListSamples,
  samplePath as fixtureSamplePath,
  scanDirectory as fixtureScanDirectory,
} from './github-fixture-directory.js';

export type { StabilitySample, FileSample, DirectoryFile, DirectoryScan } from './github-fixture-directory.js';
export { stabilityDecision } from './github-fixture-directory.js';

/** These public helpers are blocked until a trusted directory reader has been admitted. */
export async function samplePath(path: string) {
  assertDirectoryReaderAvailable();
  return fixtureSamplePath(path);
}

export async function scanDirectory(root: string, excludes: readonly string[]) {
  assertDirectoryReaderAvailable();
  return fixtureScanDirectory(root, excludes);
}

export async function listSamples(root: string, excludes: readonly string[], limit = 3) {
  assertDirectoryReaderAvailable();
  return fixtureListSamples(root, excludes, limit);
}
