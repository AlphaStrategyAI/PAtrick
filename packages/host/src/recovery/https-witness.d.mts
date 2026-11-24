import type { Server } from 'node:https';
import type { RecoveryWitnessPort, RecoveryWitnessRecord } from './witness.js';

type TlsIdentity = { key: string | Buffer; cert: string | Buffer; ca: string | Buffer };
type NextRecord = Omit<RecoveryWitnessRecord, 'revision'>;
type Client = { fingerprint: string; domains: readonly string[]; writerId?: string };

export type RecoveryWitnessStore = Readonly<{
  read(domain: string): RecoveryWitnessRecord | undefined;
  initialize(record: NextRecord): RecoveryWitnessRecord;
  compareAndSwap(domain: string, revision: string, next: NextRecord, writerId: string): 'invalid' | 'denied' | 'conflict' | 'applied';
  close(): void;
}>;
export function openRecoveryWitnessStore(path: string, options?: { create?: boolean }): RecoveryWitnessStore;
export function createRecoveryWitnessServer(options: TlsIdentity & {
  authorityId: string; clients: readonly Client[]; store: RecoveryWitnessStore;
}): Server;
export function createHttpsRecoveryWitnessPort(options: TlsIdentity & {
  origin: string; authorityId: string;
}): RecoveryWitnessPort;
