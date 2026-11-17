import type { SqliteDatabase } from '@patrick/storage';
import { canonical, digest } from './files.js';
import type { RecoveryDatabases } from './types.js';

export type RecoveryLocalCut = { inventory: string; serviceVersion: number; hubVersion: number };
const tables = [
  'answer_intents', 'answer_receipts', 'effect_intents', 'effect_receipts', 'settings_changes', 'consultations',
  'notification_intents', 'pending_ingest', 'channel_tests', 'withdrawal_events',
  'recovery_withdrawal_log', 'recovery_withdrawal_pending', 'hub_snapshots', 'domain_events',
];

export function tableInventory(database: SqliteDatabase, table: string, domain: string): Array<Record<string, unknown>> {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
  const scoped = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((column) => column.name === 'data_domain');
  const rows = (scoped ? database.prepare(`SELECT * FROM ${table} WHERE data_domain=?`).all(domain)
    : database.prepare(`SELECT * FROM ${table}`).all()) as Array<Record<string, unknown>>;
  return rows.sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

export function localRecoveryCut(databases: RecoveryDatabases, domain: string): RecoveryLocalCut {
  const inventory = Object.fromEntries((['service', 'hub'] as const).map((role) => [
    role, Object.fromEntries(tables.map((table) => [table, tableInventory(databases[role], table, domain)])),
  ]));
  return {
    inventory: digest(canonical(inventory)), serviceVersion: databases.service.pragma('data_version', { simple: true }) as number,
    hubVersion: databases.hub.pragma('data_version', { simple: true }) as number,
  };
}
