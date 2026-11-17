import { withImmediateTransaction, type SqliteDatabase } from '@patrick/storage';
import { canonical, digest } from './files.js';
import { requireRecoverySchema } from './restore.js';
import { withdrawalEntryHash, type RecoveryWitness } from './witness.js';
import type { WithdrawalEntry } from './types.js';

export type RecoveryWithdrawalLogPort = {
  independence: 'independent_authority';
  appendAndReadBack(entry: WithdrawalEntry): Promise<{ domain: string; seq: number; hash: string; verified: boolean }>;
};
type WithdrawalRow = {
  event_id: string; target_kind: string; target_id: string; target_version: number; epoch: number; reason: string; created_at: string;
};

export function createRecoveryWithdrawalJournal(options: {
  database: SqliteDatabase; witness?: RecoveryWitness; log?: RecoveryWithdrawalLogPort; now?: () => Date;
}) {
  const db = options.database;
  const now = options.now ?? (() => new Date());
  return {
    async protectPending(domain: string, writerEpoch: string): Promise<'protected' | 'protection_pending'> {
      requireRecoverySchema(db);
      const pending = db.prepare(`SELECT e.* FROM recovery_withdrawal_pending p
        JOIN withdrawal_events e ON e.event_id=p.event_id WHERE e.data_domain=? ORDER BY e.epoch,e.event_id`).all(domain) as WithdrawalRow[];
      if (!options.witness || !options.log || options.log.independence !== 'independent_authority') return 'protection_pending';
      for (const event of pending) {
        const entry = withImmediateTransaction(db, () => {
          const existing = db.prepare(`SELECT sequence,writer_epoch,previous_hash,entry_hash,event_json FROM recovery_withdrawal_log
            WHERE data_domain=? AND json_extract(event_json,'$.eventId')=?`).get(domain, event.event_id) as {
            sequence: number; writer_epoch: string; previous_hash: string; entry_hash: string; event_json: string;
          } | undefined;
          if (existing) {
            return {
              domain, seq: existing.sequence, writerEpoch: existing.writer_epoch, previousHash: existing.previous_hash,
              hash: existing.entry_hash, event: JSON.parse(existing.event_json) as WithdrawalEntry['event'],
            };
          }
          const previous = db.prepare('SELECT sequence,entry_hash FROM recovery_withdrawal_log WHERE data_domain=? ORDER BY sequence DESC LIMIT 1').get(domain) as
            { sequence: number; entry_hash: string } | undefined;
          const payload: Omit<WithdrawalEntry, 'hash'> = {
            domain, seq: (previous?.sequence ?? 0) + 1, writerEpoch, previousHash: previous?.entry_hash ?? digest(''),
            event: { eventId: event.event_id, targetKind: event.target_kind, targetId: event.target_id, targetVersion: event.target_version,
              epoch: event.epoch, reason: event.reason, createdAt: event.created_at },
          };
          const result = { ...payload, hash: withdrawalEntryHash(payload) };
          db.prepare('INSERT INTO recovery_withdrawal_log VALUES (?,?,?,?,?,?,?)').run(
            domain, result.seq, writerEpoch, result.previousHash, result.hash, canonical(result.event), 'protection_pending',
          );
          return result;
        });
        if (entry.writerEpoch !== writerEpoch) return 'protection_pending';
        try {
          const copied = await options.log.appendAndReadBack(entry);
          if (!copied.verified || copied.domain !== domain || copied.seq !== entry.seq || copied.hash !== entry.hash) return 'protection_pending';
          if (!await options.witness.advanceWithdrawalHead(domain, writerEpoch, entry)) return 'protection_pending';
        } catch { return 'protection_pending'; }
        withImmediateTransaction(db, () => {
          db.prepare("UPDATE recovery_withdrawal_log SET protection='protected' WHERE data_domain=? AND sequence=? AND entry_hash=?").run(domain, entry.seq, entry.hash);
          db.prepare('DELETE FROM recovery_withdrawal_pending WHERE event_id=?').run(event.event_id);
        });
      }
      const remaining = db.prepare('SELECT event_id FROM recovery_withdrawal_pending WHERE data_domain=? LIMIT 1').get(domain);
      if (remaining) return 'protection_pending';
      db.prepare(`UPDATE recovery_domain_gates SET status='blocked',reason='withdrawal_protected_requires_admission',updated_at=?
        WHERE data_domain=? AND status='protection_pending'`).run(now().toISOString(), domain);
      return 'protected';
    },
  };
}
