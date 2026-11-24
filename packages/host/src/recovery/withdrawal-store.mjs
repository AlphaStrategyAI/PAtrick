import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { openAuthorityStore } from './authority-store.mjs';
import { canonical, digest } from './files.ts';

export const withdrawalPageSize = 16;
export const withdrawalEntryLimit = 16 * 1024;
export const emptyWithdrawalHash = digest('');
const domainId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const writerEpochPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const entryFields = ['domain', 'seq', 'writerEpoch', 'previousHash', 'hash', 'event'];
const eventFields = ['eventId', 'targetKind', 'targetId', 'targetVersion', 'epoch', 'reason', 'createdAt'];

function check(condition, code) {
  if (!condition) throw new Error('RECOVERY_WITHDRAWAL_' + code);
}

function exact(value, fields) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const integer = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const present = value => typeof value === 'string' && value.length > 0;

export function validWithdrawalHead(domain, seq, hash) {
  return matches(domainId, domain) && integer(seq, 0) && matches(hashPattern, hash) && (seq !== 0 || hash === emptyWithdrawalHash);
}

export function encodeWithdrawal(entry) {
  if (!exact(entry, entryFields) || !validWithdrawalHead(entry.domain, entry.seq, entry.hash) || entry.seq === 0
    || !matches(writerEpochPattern, entry.writerEpoch) || !validWithdrawalHead(entry.domain, entry.seq - 1, entry.previousHash)
    || !exact(entry.event, eventFields)) return;
  const { event } = entry;
  if (!present(event.eventId) || !present(event.targetKind) || !present(event.targetId) || !present(event.createdAt)
    || typeof event.reason !== 'string' || !integer(event.targetVersion, 0) || !integer(event.epoch, 1)) return;
  const content = canonical(entry);
  if (Buffer.byteLength(content) > withdrawalEntryLimit) return;
  const { hash, ...payload } = entry;
  if (digest(canonical(payload)) === hash) return content;
}

export function openRecoveryWithdrawalStore(path, { create = false } = {}) {
  const database = openAuthorityStore(path, { create, check, schema: `
    CREATE TABLE withdrawal_entries (
      domain TEXT NOT NULL, sequence INTEGER NOT NULL, entry_hash TEXT NOT NULL,
      writer_epoch TEXT NOT NULL, event_id TEXT NOT NULL, entry_json TEXT NOT NULL,
      PRIMARY KEY(domain, sequence, entry_hash), UNIQUE(domain, sequence, writer_epoch), UNIQUE(domain, event_id)
    ) STRICT;
  ` });
  try {
    const select = database.prepare('SELECT entry_json FROM withdrawal_entries WHERE domain = ? AND sequence = ? AND entry_hash = ?');
    const pending = database.prepare('SELECT entry_hash FROM withdrawal_entries WHERE domain = ? AND sequence = ? AND writer_epoch = ?');
    const event = database.prepare('SELECT 1 FROM withdrawal_entries WHERE domain = ? AND event_id = ?');
    const insert = database.prepare('INSERT INTO withdrawal_entries VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
    if (create) {
      database.exec('CREATE TABLE IF NOT EXISTS withdrawal_store_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), identity TEXT NOT NULL) STRICT');
      database.prepare('INSERT INTO withdrawal_store_identity VALUES (1, ?) ON CONFLICT DO NOTHING').run(randomUUID());
    }
    const identity = database.prepare('SELECT identity FROM withdrawal_store_identity WHERE singleton = 1').get()?.identity;
    check(matches(writerEpochPattern, identity), 'STORE_INVALID');
    const file = lstatSync(path, { bigint: true });
    const fileIdentity = `${file.dev}:${file.ino}`;
    function read(domain, seq, hash) {
      const row = select.get(domain, seq, hash);
      if (!row) return undefined;
      const entry = JSON.parse(row.entry_json);
      check(encodeWithdrawal(entry) === row.entry_json && entry.domain === domain && entry.seq === seq && entry.hash === hash, 'STORE_INVALID');
      return entry;
    }
    return Object.freeze({
      identity,
      fileIdentity,
      read,
      append(entry) {
        const content = encodeWithdrawal(entry);
        if (!content) return false;
        insert.run(entry.domain, entry.seq, entry.hash, entry.writerEpoch, entry.event.eventId, content);
        const persisted = select.get(entry.domain, entry.seq, entry.hash);
        return persisted?.entry_json === content;
      },
      pendingHash(domain, seq, writerEpoch) {
        return pending.get(domain, seq, writerEpoch)?.entry_hash;
      },
      hasEvent(domain, eventId) {
        return event.get(domain, eventId) !== undefined;
      },
      close() { database.close(); },
    });
  } catch (error) {
    database.close();
    throw error;
  }
}
