-- Expand the source type enum without changing existing keys or downstream references.
-- The migrator verifies live foreign keys before committing this one table-rebuild migration.
CREATE TABLE http_rebuild_source_configs (
  source_id TEXT PRIMARY KEY CHECK(length(source_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  connector_type TEXT NOT NULL CHECK(connector_type IN ('github', 'directory', 'rss', 'webpage')),
  normalized_target TEXT NOT NULL,
  physical_root TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  excludes_json TEXT NOT NULL,
  credential_ref TEXT,
  frequency TEXT NOT NULL,
  history TEXT NOT NULL CHECK(history IN ('none', 'backfill')),
  has_trigger_rule INTEGER NOT NULL CHECK(has_trigger_rule IN (0, 1)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('enabled', 'paused', 'offline', 'placeholder', 'disconnected')),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((status = 'enabled' AND enabled = 1) OR (status IN ('paused', 'offline', 'placeholder', 'disconnected') AND enabled = 0)),
  UNIQUE(account_id, data_domain, connector_type, normalized_target),
  UNIQUE(physical_root)
) STRICT;

CREATE TABLE http_rebuild_source_versions (
  source_id TEXT NOT NULL REFERENCES source_configs(source_id),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  connector_type TEXT NOT NULL CHECK(connector_type IN ('github', 'directory', 'rss', 'webpage')),
  normalized_target TEXT NOT NULL,
  physical_root TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  excludes_json TEXT NOT NULL,
  credential_ref TEXT,
  frequency TEXT NOT NULL,
  history TEXT NOT NULL CHECK(history IN ('none', 'backfill')),
  has_trigger_rule INTEGER NOT NULL CHECK(has_trigger_rule IN (0, 1)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('enabled', 'paused', 'offline', 'placeholder', 'disconnected')),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, config_revision),
  CHECK((status = 'enabled' AND enabled = 1) OR (status IN ('paused', 'offline', 'placeholder', 'disconnected') AND enabled = 0))
) STRICT;

INSERT INTO http_rebuild_source_configs SELECT * FROM source_configs;
INSERT INTO http_rebuild_source_versions SELECT * FROM source_versions;

DROP TABLE source_versions;
DROP TABLE source_configs;
ALTER TABLE http_rebuild_source_configs RENAME TO source_configs;
ALTER TABLE http_rebuild_source_versions RENAME TO source_versions;

CREATE TABLE http_source_response_evidence (
  event_id TEXT PRIMARY KEY REFERENCES collection_receipts(event_id),
  source_id TEXT NOT NULL REFERENCES source_configs(source_id),
  config_revision INTEGER NOT NULL CHECK(config_revision > 0),
  response_url TEXT NOT NULL,
  response_hash TEXT NOT NULL REFERENCES blobs(sha256),
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_preview_receipts (
  command_id TEXT PRIMARY KEY REFERENCES command_inbox(command_id),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  baseline TEXT NOT NULL CHECK(json_valid(baseline) AND json_type(baseline)='array' AND json_array_length(baseline)<=500)
) STRICT;

CREATE TABLE http_source_config_receipts (
  event_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_configs(source_id),
  config_revision INTEGER NOT NULL CHECK(config_revision > 1),
  kind TEXT NOT NULL CHECK(kind IN ('modify', 'pause', 'resume', 'disconnect')),
  cursor TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(source_id, config_revision)
) STRICT;

CREATE TABLE http_source_schedule (
  source_id TEXT PRIMARY KEY REFERENCES source_configs(source_id),
  config_revision INTEGER NOT NULL CHECK(config_revision > 0),
  lease_token TEXT,
  lease_until TEXT,
  next_at TEXT NOT NULL,
  CHECK((lease_token IS NULL) = (lease_until IS NULL))
) STRICT;

CREATE TABLE http_source_baselines (
  source_id TEXT PRIMARY KEY REFERENCES source_configs(source_id),
  entries TEXT NOT NULL CHECK(json_valid(entries) AND json_type(entries)='array' AND json_array_length(entries)<=500)
) STRICT;

-- A history approval keeps the exact local sweep response. It cannot advance the
-- regular sweep cursor or write a normal collection receipt.
CREATE TABLE http_source_history_plans (
  plan_id TEXT PRIMARY KEY REFERENCES command_inbox(command_id),
  source_id TEXT NOT NULL REFERENCES source_configs(source_id),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch >= 1),
  config_revision INTEGER NOT NULL CHECK(config_revision > 0),
  evidence_event_id TEXT NOT NULL REFERENCES http_source_response_evidence(event_id),
  response_hash TEXT NOT NULL REFERENCES blobs(sha256),
  selection_hash TEXT NOT NULL CHECK(length(selection_hash)=64),
  plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
  summary TEXT NOT NULL CHECK(json_valid(summary) AND json_type(summary)='object'),
  preview_snapshot TEXT CHECK(preview_snapshot IS NULL OR json_valid(preview_snapshot)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(expires_at > created_at),
  FOREIGN KEY (source_id, config_revision) REFERENCES source_versions(source_id, config_revision)
) STRICT;

CREATE TABLE http_source_history_receipts (
  plan_id TEXT PRIMARY KEY REFERENCES http_source_history_plans(plan_id),
  receipt_id TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL,
  selected_objects INTEGER NOT NULL CHECK(selected_objects BETWEEN 0 AND 500),
  imported_objects INTEGER NOT NULL CHECK(imported_objects >= 0),
  existing_objects INTEGER NOT NULL CHECK(existing_objects >= 0),
  CHECK(imported_objects + existing_objects = selected_objects)
) STRICT;
