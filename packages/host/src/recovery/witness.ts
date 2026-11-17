import { randomUUID } from 'node:crypto';
import { canonical, digest } from './files.js';
import type { WithdrawalEntry, WithdrawalHead } from './types.js';

export type RecoveryHandoffCertificate = {
  id: string; cutId: string; previousWriterId: string; fenceProof: string; withdrawalsReconciled: boolean;
};
export type RecoveryWitnessRecord = {
  domain: string; revision: string; writerEpoch: string; writerId: string; state: 'open' | 'sealed';
  withdrawal: WithdrawalHead; certificate: RecoveryHandoffCertificate | null; activationId: string | null; parentSealedRevision: string | null;
};
export type RecoveryWitnessPort = {
  independence: 'independent_authority'; consistency: 'linearizable'; authorityId: string;
  readAuthoritative(domain: string): Promise<RecoveryWitnessRecord>;
  compareAndSwap(domain: string, expectedRevision: string, next: Omit<RecoveryWitnessRecord, 'revision'>): Promise<boolean>;
};
export type RecoveryWriterClaim = 'acquired' | 'lost' | 'unconfirmed';
export type RecoveryWitness = ReturnType<typeof createRecoveryWitness>;

export function createRecoveryWitness(options: {
  writerId: string; port?: RecoveryWitnessPort; verifySealedProof?: (record: RecoveryWitnessRecord) => Promise<boolean>;
}) {
  const port = options.port;
  function admitted() {
    return port?.independence === 'independent_authority' && port.consistency === 'linearizable' && Boolean(port.authorityId);
  }
  async function current(domain: string): Promise<RecoveryWitnessRecord | undefined> {
    if (!admitted()) return undefined;
    try {
      const record = await port!.readAuthoritative(domain);
      if (record.domain !== domain || !record.revision || !record.writerId || !record.writerEpoch
        || !['open', 'sealed'].includes(record.state) || !Number.isSafeInteger(record.withdrawal.seq)
        || record.withdrawal.seq < 0 || !/^[a-f0-9]{64}$/.test(record.withdrawal.hash)) return undefined;
      return structuredClone(record);
    } catch { return undefined; }
  }
  async function sealed(record: RecoveryWitnessRecord) {
    try {
      return record.state === 'sealed' && Boolean(record.certificate?.id && record.certificate.cutId
        && record.certificate.previousWriterId === record.writerId && record.certificate.fenceProof && record.certificate.withdrawalsReconciled
        && options.verifySealedProof && await options.verifySealedProof(record));
    } catch { return false; }
  }
  return {
    current,
    verifySealed: sealed,
    async advanceWithdrawalHead(domain: string, writerEpoch: string, entry: WithdrawalEntry): Promise<boolean> {
      const { hash, ...payload } = entry;
      if (!Number.isSafeInteger(entry.seq) || entry.seq < 1 || !Number.isSafeInteger(entry.event.epoch) || entry.event.epoch < 1
        || !entry.event.eventId || hash !== withdrawalEntryHash(payload)) return false;
      entry = structuredClone(entry);
      const before = await current(domain);
      if (!before || before.state !== 'open' || before.writerId !== options.writerId || before.writerEpoch !== writerEpoch
        || entry.domain !== domain || entry.writerEpoch !== writerEpoch) return false;
      if (before.withdrawal.seq === entry.seq && before.withdrawal.hash === entry.hash) return true;
      if (before.withdrawal.seq + 1 !== entry.seq || before.withdrawal.hash !== entry.previousHash) return false;
      const { revision, ...record } = before;
      try {
        await port!.compareAndSwap(domain, revision, { ...record, withdrawal: { seq: entry.seq, hash: entry.hash } });
      } catch { void 0; }
      const after = await current(domain);
      return Boolean(after && after.state === 'open' && after.writerId === options.writerId && after.writerEpoch === writerEpoch
        && after.withdrawal.seq === entry.seq && after.withdrawal.hash === entry.hash);
    },
    async claimRecoveryWriter(domain: string, sealedRevision: string, activationId: string): Promise<RecoveryWriterClaim> {
      if (!domain || !sealedRevision || !activationId || !admitted()) return 'unconfirmed';
      const before = await current(domain);
      if (!before) return 'unconfirmed';
      if (before.state === 'open') {
        return before.activationId === activationId && before.writerId === options.writerId
          && before.parentSealedRevision === sealedRevision ? 'acquired' : 'lost';
      }
      if (before.revision !== sealedRevision) return 'lost';
      if (!await sealed(before)) return 'unconfirmed';
      const { revision, ...previous } = before;
      if (revision !== sealedRevision) return 'lost';
      const next: Omit<RecoveryWitnessRecord, 'revision'> = {
        ...previous, state: 'open', writerId: options.writerId, writerEpoch: randomUUID(),
        activationId, parentSealedRevision: sealedRevision,
      };
      try { await port!.compareAndSwap(domain, sealedRevision, next); } catch { void 0; }
      const after = await current(domain);
      if (!after) return 'unconfirmed';
      if (after.state === 'open' && after.writerId === options.writerId && after.activationId === activationId
        && after.parentSealedRevision === sealedRevision && after.writerEpoch === next.writerEpoch) return 'acquired';
      return after.revision === sealedRevision && after.state === 'sealed' ? 'unconfirmed' : 'lost';
    },
    async sealRecoveryWriter(domain: string, openRevision: string, certificate: RecoveryHandoffCertificate, head: WithdrawalHead): Promise<boolean> {
      const before = await current(domain);
      if (!before || before.state !== 'open' || before.writerId !== options.writerId || before.revision !== openRevision
        || certificate.previousWriterId !== options.writerId || !certificate.fenceProof || !certificate.withdrawalsReconciled
        || before.withdrawal.seq !== head.seq || before.withdrawal.hash !== head.hash) return false;
      const { revision, ...previous } = before;
      if (revision !== openRevision) return false;
      const next = { ...previous, state: 'sealed' as const, certificate, activationId: null, parentSealedRevision: null };
      if (!options.verifySealedProof || !await options.verifySealedProof({ ...next, revision: openRevision })) return false;
      try { await port!.compareAndSwap(domain, openRevision, next); } catch { void 0; }
      const after = await current(domain);
      return Boolean(after && after.state === 'sealed' && after.writerEpoch === before.writerEpoch
        && canonical(after.certificate) === canonical(certificate) && after.withdrawal.hash === head.hash && after.withdrawal.seq === head.seq);
    },
  };
}

export function withdrawalEntryHash(entry: Omit<WithdrawalEntry, 'hash'>): string {
  return digest(canonical(entry));
}

export function verifyWithdrawalChain(domain: string, entries: readonly WithdrawalEntry[], expected: WithdrawalHead): boolean {
  let head = { seq: 0, hash: digest('') };
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.domain !== domain || entry.seq !== head.seq + 1 || entry.previousHash !== head.hash || !entry.writerEpoch
      || seen.has(entry.event.eventId) || !Number.isSafeInteger(entry.event.epoch) || entry.event.epoch < 1) return false;
    const { hash, ...payload } = entry;
    if (hash !== withdrawalEntryHash(payload)) return false;
    seen.add(entry.event.eventId);
    head = { seq: entry.seq, hash };
  }
  return head.seq === expected.seq && head.hash === expected.hash;
}
