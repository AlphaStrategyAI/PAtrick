import type { RecoveryDatabaseQuery } from './types.js';

export const autoloopFactsTableSql = 'CREATE TABLE facts(seq INTEGER PRIMARY KEY, fact TEXT NOT NULL)';
export const autoloopCardIndexSql = "CREATE INDEX projection_card_hash ON projections(card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))) WHERE collection='cards'";

const tables = {
  facts: autoloopFactsTableSql,
  projection_meta: 'CREATE TABLE projection_meta(id INTEGER PRIMARY KEY,seq INTEGER NOT NULL,next TEXT NOT NULL,format TEXT NOT NULL)',
  projection_pending: 'CREATE TABLE projection_pending(key TEXT PRIMARY KEY,card_id INTEGER,channel TEXT)',
  projection_refs: 'CREATE TABLE projection_refs(collection TEXT,key TEXT,seq INTEGER,PRIMARY KEY(collection,key,seq))',
  projections: 'CREATE TABLE projections(collection TEXT,key TEXT,data TEXT NOT NULL,PRIMARY KEY(collection,key))',
};

const projectionIndexes: Record<string, string[]> = {
  events: ['source key', 'routed id', 'paused id', 'id'],
  runs: ['state id', 'rule lane state id', 'id', 'finished_at'],
  run_events: ['run_id', 'event_id'],
  cards: ['key id', 'state id', 'rule lane state id', 'rule lane answer_event id', 'answer_event', 'run_id', 'id', 'fyi created_at'],
  timers: ['event_id id', 'rule lane key id', 'rule lane event_id id'],
  deliveries: ['channel', 'card_id'],
  due: ['at'],
};

const projectionViews = {
  events: 'id source key type subject summary detail link routed paused received_at',
  runs: 'id rule agent grp lane state attempts not_before claim last_result cancel_at resume session link created_at claimed_at seen_at finished_at manual summary error usage',
  run_events: 'run_id event_id',
  cards: 'id key kind title text options recommend about state fyi quiet choice answer by result rule lane grp source agent session run_id answer_event version created_at decided_at closed_at',
  deliveries: 'card_id channel version ref tries first_try_at not_before error given_up',
  timers: 'id rule lane key source agent session about at event_id created_at',
  schedules: 'rule cron next_at skipped_at',
  seen: 'kind name seen_at',
  keys: 'kind name hash created_at',
  pauses: 'name by reason since until',
};

const jsonField = (name: string) => `json_extract(data,'$.${name}')`;
const numberedProjections = new Set(['events', 'runs', 'cards', 'timers']);
const optional = new Map<string, string>([
  ['index:pending_channel', 'CREATE INDEX pending_channel ON projection_pending(channel,card_id)'],
  ['index:projection_card_hash', autoloopCardIndexSql],
  ['index:projection_delivery_due', `CREATE INDEX projection_delivery_due ON projections(collection,${jsonField('given_up')},key) WHERE collection='deliveries' AND ${jsonField('not_before')} IS NOT NULL`],
]);
for (const [table, groups] of Object.entries(projectionIndexes)) {
  const order = numberedProjections.has(table) ? jsonField('id') : 'key';
  for (const [position, columns] of groups.entries()) {
    const indexed = [...new Set([...columns.split(' ').map(jsonField), order])];
    const name = `projection_${table}_${position}`;
    optional.set(`index:${name}`, `CREATE INDEX ${name} ON projections(collection,${indexed.join(',')}) WHERE collection='${table}'`);
  }
}
for (const [name, fields] of Object.entries(projectionViews)) {
  const columns = fields.split(' ').map((field) => `${jsonField(field)} AS ${field}`).join(',');
  optional.set(`view:${name}`, `CREATE VIEW ${name} AS SELECT ${columns} FROM projections WHERE collection='${name}'`);
}

export function readPinnedAutoloopSchema(db: RecoveryDatabaseQuery) {
  const entries = db.prepare(`SELECT type, name, sql FROM main.sqlite_schema
    WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name`).all() as { type: string; name: string; sql: string }[];
  const required = new Map(Object.entries(tables));
  for (const { type, name, sql } of entries) {
    const expected = type === 'table' ? required.get(name) : optional.get(`${type}:${name}`);
    if (!expected || expected !== sql) throw new Error('RECOVERY_HUB_READER_REQUIRED');
    if (type === 'table') required.delete(name);
  }
  if (required.size) throw new Error('RECOVERY_HUB_READER_REQUIRED');
  return entries;
}
