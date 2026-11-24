import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '@patrick/storage';
import { autoloopFactsTableSql, readPinnedAutoloopSchema } from './autoloop-schema.js';
import { canonical, digest } from './files.js';
import type { RecoveryDatabases } from './types.js';

export type RecoveryLocalCut = { inventory: string; serviceVersion: number; hubVersion: number };
const autoloopInventoryQueries = [
  'SELECT seq, fact FROM main.facts ORDER BY seq',
  'SELECT id, seq, next, format FROM main.projection_meta ORDER BY id',
  'SELECT key, card_id, channel FROM main.projection_pending ORDER BY key, card_id, channel',
  'SELECT collection, key, seq FROM main.projection_refs ORDER BY collection, key, seq',
  'SELECT collection, key, data FROM main.projections ORDER BY collection, key, data',
];
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
  const factTable = databases.hub.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='facts'").get() as
    { sql: string } | undefined;
  let inventoryHash = digest(canonical(inventory));
  if (factTable?.sql === autoloopFactsTableSql) {
    const hubInventory = createHash('sha256');
    hubInventory.update(canonical(readPinnedAutoloopSchema(databases.hub))).update('\n');
    for (const query of autoloopInventoryQueries) {
      hubInventory.update(query).update('\n');
      for (const row of databases.hub.prepare(query).iterate()) hubInventory.update(canonical(row)).update('\n');
    }
    inventoryHash = digest(canonical({ inventory, autoloopHub: hubInventory.digest('hex') }));
  }
  return {
    inventory: inventoryHash, serviceVersion: databases.service.pragma('data_version', { simple: true }) as number,
    hubVersion: databases.hub.pragma('data_version', { simple: true }) as number,
  };
}
