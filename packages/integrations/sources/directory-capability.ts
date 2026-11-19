/** The trusted directory reader is part of this installation.
 *
 * The reader resolves every path one component at a time, never follows a link
 * into or out of the approved root, reads through the descriptor it opened and
 * bounds what it reads.
 */
export const directoryReaderCapability = Object.freeze({ state: 'available', reason: null } as const);

export class DirectoryReaderUnavailableError extends Error {
  readonly code = directoryReaderCapability.reason;

  constructor() {
    super(directoryReaderCapability.reason ?? 'DIRECTORY_READER_UNAVAILABLE');
    this.name = 'DirectoryReaderUnavailableError';
  }
}

export function assertDirectoryReaderAvailable(): void {
  if (directoryReaderCapability.state !== 'available') throw new DirectoryReaderUnavailableError();
}
