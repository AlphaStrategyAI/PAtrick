import type { Server } from 'node:https';
import type { WithdrawalEntry } from './types.js';
import type { RecoveryWitnessPort, RecoveryWitnessRecord } from './witness.js';
import type { RecoveryWithdrawalLogPort } from './withdrawals.js';
import type { RecoveryWithdrawalStore } from './withdrawal-store.mjs';

type TlsIdentity = { key: string | Buffer; cert: string | Buffer; ca: string | Buffer };
type NextRecord = Omit<RecoveryWitnessRecord, 'revision'>;
type Client = { fingerprint: string; domains: readonly string[]; writerId?: string; withdrawals?: true };
type WriteOutcome = 'invalid' | 'denied' | 'conflict' | 'applied';
type AuthorityIdentity = TlsIdentity & { origin: string; authorityId: string };

export type RecoveryWitnessStore = Readonly<{
  read(domain: string): RecoveryWitnessRecord | undefined;
  configureWithdrawals(log: RecoveryWithdrawalStore | undefined, domains: Iterable<string>): void;
  initialize(record: NextRecord): RecoveryWitnessRecord;
  compareAndSwap(domain: string, revision: string, next: NextRecord, writerId: string, log?: RecoveryWithdrawalStore): WriteOutcome;
  appendWithdrawal(entry: WithdrawalEntry, writerId: string, log: RecoveryWithdrawalStore): WriteOutcome;
  close(): void;
}>;
export function openRecoveryWitnessStore(path: string, options?: { create?: boolean }): RecoveryWitnessStore;
export function createRecoveryWitnessServer(options: TlsIdentity & {
  authorityId: string; clients: readonly Client[]; store: RecoveryWitnessStore; withdrawalStore?: RecoveryWithdrawalStore;
}): Server;
export function createHttpsRecoveryWitnessPort(options: AuthorityIdentity): RecoveryWitnessPort;
export function createHttpsRecoveryWithdrawalLogPort(options: AuthorityIdentity): RecoveryWithdrawalLogPort & {
  readComplete(domain: string, record: RecoveryWitnessRecord): Promise<WithdrawalEntry[]>;
};
