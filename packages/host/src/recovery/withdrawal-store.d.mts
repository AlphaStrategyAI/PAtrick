import type { WithdrawalEntry } from './types.js';

export type RecoveryWithdrawalStore = Readonly<{
  identity: string;
  read(domain: string, seq: number, hash: string): WithdrawalEntry | undefined;
  append(entry: WithdrawalEntry): boolean;
  hasPending(domain: string, seq: number, writerEpoch: string): boolean;
  close(): void;
}>;

export function openRecoveryWithdrawalStore(path: string, options?: { create?: boolean }): RecoveryWithdrawalStore;
