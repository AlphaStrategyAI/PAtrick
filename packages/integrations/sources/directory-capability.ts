/** Current process has no admitted directory reader. This is not source configuration or authorization. */
export const directoryReaderCapability = Object.freeze({ state: 'blocked', reason: 'DIRECTORY_READER_UNAVAILABLE' } as const);

export class DirectoryReaderUnavailableError extends Error {
  readonly code = directoryReaderCapability.reason;

  constructor() {
    super(directoryReaderCapability.reason);
    this.name = 'DirectoryReaderUnavailableError';
  }
}

export function assertDirectoryReaderAvailable(): void {
  throw new DirectoryReaderUnavailableError();
}
