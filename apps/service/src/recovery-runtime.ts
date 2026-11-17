import { createRecoveryRuntimeGate, recoveryWriteAllowed, type SqliteDatabase } from '@patrick/storage';
import { ApiError } from './errors.js';

/** Server composition only. An independent activation controller retains this capability;
 * HTTP drafts, saved gate rows and environment strings cannot install admission.
 * Attach runs before any app resource sees this handle. Until independently admitted,
 * every configured domain remains closed, including domains missing from the copied DB.
 */
export type RecoveryRuntimeConfiguration = Readonly<{
  attach(input: { database: SqliteDatabase; admission: ReturnType<typeof createRecoveryRuntimeGate> }): void;
}>;

export function attachRecoveryRuntime(database: SqliteDatabase, configuration: RecoveryRuntimeConfiguration): void {
  configuration.attach({ database, admission: createRecoveryRuntimeGate(database) });
}

export function assertBusinessWrite(db: SqliteDatabase, domain: string): void {
  if (!recoveryWriteAllowed(db, domain)) throw new ApiError(409, 'CONFLICT', { reason: 'recovery_write_blocked' });
}

/** Recheck after credential acquisition: it may await a key provider while a
 * withdrawal closes the domain. No remote handoff may use that stale result.
 */
export function recoveryWriteCredential(db: SqliteDatabase, domain: string, credential: () => string | Promise<string>) {
  return async () => {
    assertBusinessWrite(db, domain);
    const value = await credential();
    assertBusinessWrite(db, domain);
    return value;
  };
}
