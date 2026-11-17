CREATE TABLE IF NOT EXISTS recovery_sets (
  set_id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  status TEXT NOT NULL CHECK(status IN ('capturing','local_verified','off_host_verified','incomplete')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS recovery_domain_gates (
  data_domain TEXT PRIMARY KEY,
  writer_epoch TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('blocked','protection_pending','open','importing','imported')),
  activation_id TEXT,
  witness_revision TEXT,
  receipt_id TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS recovery_receipts (
  receipt_id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('drill','activate','owner_import')),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS recovery_quarantined_records (
  receipt_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  data_domain TEXT,
  row_json TEXT NOT NULL CHECK(json_valid(row_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(receipt_id,table_name,record_id)
) STRICT;

CREATE TABLE IF NOT EXISTS recovery_withdrawal_log (
  data_domain TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  writer_epoch TEXT NOT NULL,
  previous_hash TEXT NOT NULL CHECK(length(previous_hash)=64),
  entry_hash TEXT NOT NULL CHECK(length(entry_hash)=64),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  protection TEXT NOT NULL CHECK(protection IN ('protection_pending','protected')),
  PRIMARY KEY(data_domain,sequence),
  UNIQUE(data_domain,entry_hash)
) STRICT;

CREATE TABLE IF NOT EXISTS recovery_withdrawal_pending (
  event_id TEXT PRIMARY KEY REFERENCES withdrawal_events(event_id),
  data_domain TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS recovery_withdrawal_blocks_writes AFTER INSERT ON withdrawal_events BEGIN
  INSERT INTO recovery_withdrawal_pending(event_id,data_domain,created_at) VALUES (NEW.event_id,NEW.data_domain,NEW.created_at);
  INSERT INTO recovery_domain_gates(data_domain,writer_epoch,status,reason,updated_at)
    VALUES (NEW.data_domain,'unregistered','protection_pending','withdrawal_requires_independent_protection',NEW.created_at)
    ON CONFLICT(data_domain) DO UPDATE SET status='protection_pending',reason='withdrawal_requires_independent_protection',updated_at=NEW.created_at;
END;

INSERT OR IGNORE INTO recovery_withdrawal_pending(event_id,data_domain,created_at)
  SELECT event_id,data_domain,created_at FROM withdrawal_events;
INSERT INTO recovery_domain_gates(data_domain,writer_epoch,status,reason,updated_at)
  SELECT data_domain,'unregistered','protection_pending','historical_withdrawal_requires_independent_protection',MAX(created_at)
  FROM withdrawal_events GROUP BY data_domain
  ON CONFLICT(data_domain) DO UPDATE SET status='protection_pending',reason='historical_withdrawal_requires_independent_protection',updated_at=excluded.updated_at;

CREATE TABLE IF NOT EXISTS recovery_imports (
  import_id TEXT PRIMARY KEY,
  data_domain TEXT NOT NULL,
  writer_epoch TEXT NOT NULL,
  control_receipt_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('importing','complete','blocked')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  elapsed_ms INTEGER CHECK(elapsed_ms>=0),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS recovery_owner_control_once ON recovery_imports(data_domain,control_receipt_ref);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_one_active_import ON recovery_imports(data_domain) WHERE status='importing';

CREATE TABLE IF NOT EXISTS recovery_import_objects (
  import_id TEXT NOT NULL REFERENCES recovery_imports(import_id),
  data_domain TEXT NOT NULL,
  writer_epoch TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>=0),
  isolated_path TEXT NOT NULL,
  PRIMARY KEY(import_id,relative_path)
) STRICT;

CREATE TRIGGER IF NOT EXISTS recovery_log_immutable_delete BEFORE DELETE ON recovery_withdrawal_log BEGIN
  SELECT RAISE(ABORT,'RECOVERY_LOG_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS recovery_log_immutable_update BEFORE UPDATE ON recovery_withdrawal_log
WHEN NEW.data_domain<>OLD.data_domain OR NEW.sequence<>OLD.sequence OR NEW.writer_epoch<>OLD.writer_epoch
  OR NEW.previous_hash<>OLD.previous_hash OR NEW.entry_hash<>OLD.entry_hash OR NEW.event_json<>OLD.event_json
  OR (OLD.protection='protected' AND NEW.protection<>'protected')
BEGIN
  SELECT RAISE(ABORT,'RECOVERY_LOG_IMMUTABLE');
END;
