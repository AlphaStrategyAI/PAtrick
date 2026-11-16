CREATE TABLE source_configs (
  source_id TEXT PRIMARY KEY CHECK(length(source_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  connector_type TEXT NOT NULL CHECK(connector_type IN ('github', 'directory')),
  normalized_target TEXT NOT NULL,
  physical_root TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  excludes_json TEXT NOT NULL,
  credential_ref TEXT,
  frequency TEXT NOT NULL,
  history TEXT NOT NULL CHECK(history IN ('none', 'backfill')),
  has_trigger_rule INTEGER NOT NULL CHECK(has_trigger_rule IN (0, 1)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('enabled', 'paused', 'offline', 'placeholder')),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((status = 'enabled' AND enabled = 1) OR (status IN ('paused', 'offline', 'placeholder') AND enabled = 0)),
  UNIQUE(account_id, data_domain, connector_type, normalized_target),
  UNIQUE(physical_root)
) STRICT;

CREATE TABLE source_versions (
  source_id TEXT NOT NULL REFERENCES source_configs(source_id),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  connector_type TEXT NOT NULL CHECK(connector_type IN ('github', 'directory')),
  normalized_target TEXT NOT NULL,
  physical_root TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  excludes_json TEXT NOT NULL,
  credential_ref TEXT,
  frequency TEXT NOT NULL,
  history TEXT NOT NULL CHECK(history IN ('none', 'backfill')),
  has_trigger_rule INTEGER NOT NULL CHECK(has_trigger_rule IN (0, 1)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('enabled', 'paused', 'offline', 'placeholder')),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, config_revision),
  CHECK((status = 'enabled' AND enabled = 1) OR (status IN ('paused', 'offline', 'placeholder') AND enabled = 0))
) STRICT;

CREATE TABLE source_cursors (
  source_id TEXT PRIMARY KEY REFERENCES source_configs(source_id),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  cursor TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('baseline', 'first_collected', 'advanced')),
  sweep_count INTEGER NOT NULL CHECK(sweep_count >= 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE collection_receipts (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) > 0),
  source_id TEXT NOT NULL REFERENCES source_configs(source_id),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  kind TEXT NOT NULL CHECK(kind IN ('enable', 'first_collection', 'success', 'failure', 'pause', 'withdraw')),
  cursor TEXT,
  object_count INTEGER NOT NULL CHECK(object_count >= 0),
  evidence_ref TEXT,
  observed_at TEXT NOT NULL,
  accepted INTEGER NOT NULL CHECK(accepted IN (0, 1)),
  reason TEXT
) STRICT;

CREATE TABLE source_objects (
  source_id TEXT NOT NULL REFERENCES source_configs(source_id),
  object_id TEXT NOT NULL,
  locator TEXT NOT NULL,
  trust_class TEXT NOT NULL,
  tombstone INTEGER NOT NULL CHECK(tombstone IN (0, 1)),
  observed_seq INTEGER NOT NULL CHECK(observed_seq >= 0),
  PRIMARY KEY (source_id, object_id)
) STRICT;

CREATE TABLE source_revisions (
  source_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  observed_seq INTEGER NOT NULL CHECK(observed_seq >= 1),
  revision_id TEXT NOT NULL UNIQUE,
  content_hash TEXT,
  trust_class TEXT NOT NULL,
  tombstone INTEGER NOT NULL CHECK(tombstone IN (0, 1)),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, object_id, observed_seq),
  FOREIGN KEY (content_hash) REFERENCES blobs(sha256),
  FOREIGN KEY (source_id, object_id) REFERENCES source_objects(source_id, object_id),
  CHECK((tombstone = 0 AND content_hash IS NOT NULL AND length(content_hash) = 64) OR (tombstone = 1 AND content_hash IS NULL))
) STRICT;

CREATE TABLE webhook_deliveries (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) > 0),
  source_id TEXT NOT NULL REFERENCES source_configs(source_id),
  received_at TEXT NOT NULL
) STRICT;

CREATE TABLE dependency_checks (
  check_id TEXT PRIMARY KEY CHECK(length(check_id) > 0),
  source_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  observed_seq INTEGER NOT NULL CHECK(observed_seq >= 1),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_id, object_id) REFERENCES source_objects(source_id, object_id)
) STRICT;

CREATE TABLE delete_sweeps (
  source_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  missing_streak INTEGER NOT NULL CHECK(missing_streak >= 0),
  PRIMARY KEY (source_id, object_id),
  FOREIGN KEY (source_id, object_id) REFERENCES source_objects(source_id, object_id)
) STRICT;
