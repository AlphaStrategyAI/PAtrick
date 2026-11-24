import type { WithdrawalEntry, WithdrawalHead } from './types.js';

export type RecoveryWithdrawalStore = Readonly<{
  identity: string;
  fileIdentity: string;
  read(domain: string, seq: number, hash: string): WithdrawalEntry | undefined;
  append(entry: WithdrawalEntry): boolean;
  importHistory(domain: string, head: WithdrawalHead, entries: Iterable<WithdrawalEntry>): void;
  pendingHash(domain: string, seq: number, writerEpoch: string): string | undefined;
  hasEvent(domain: string, eventId: string): boolean;
  close(): void;
}>;

export function openRecoveryWithdrawalStore(path: string, options?: { create?: boolean }): RecoveryWithdrawalStore;
