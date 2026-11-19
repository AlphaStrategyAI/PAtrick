import { assertDirectoryReaderAvailable } from './directory-capability.js';
import {
  listDirectory,
  readDirectoryFile,
  safeComponents,
  type DirectoryReadResult,
} from './directory-reader.js';
import {
  listSamples as fixtureListSamples,
  samplePath as fixtureSamplePath,
  scanDirectory as fixtureScanDirectory,
} from './github-fixture-directory.js';

export type { StabilitySample, FileSample, DirectoryFile, DirectoryScan } from './github-fixture-directory.js';
export { stabilityDecision } from './github-fixture-directory.js';
export type { DirectoryEntry, DirectoryReadResult } from './directory-reader.js';
export { listDirectory, readDirectoryFile, safeComponents, MAX_DIRECTORY_BYTES } from './directory-reader.js';

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

/** Reads one approved object of a directory through the trusted reader. */
export async function readDirectoryObject(root: string, relativePath: string): Promise<DirectoryReadResult> {
  assertDirectoryReaderAvailable();
  const components = safeComponents(relativePath);
  if (!components) return { state: 'rejected', reason: 'the path is not inside the approved directory' };
  const listing = await listDirectory(root, []);
  if (listing.state !== 'ready') return { state: listing.state };
  const entry = listing.entries.find((candidate) => candidate.relativePath === components.join('/'));
  if (!entry) return { state: 'missing' };
  return readDirectoryFile(entry);
}
