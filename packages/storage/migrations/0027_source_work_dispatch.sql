CREATE TABLE source_trigger_rules (
  source_id TEXT PRIMARY KEY REFERENCES source_configs(source_id),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  mandate_type_id TEXT NOT NULL REFERENCES mandate_types(type_id),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE work_refs (
  work_id TEXT PRIMARY KEY CHECK(length(work_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source_configs(source_id),
  object_id TEXT NOT NULL,
  root_event_id TEXT NOT NULL CHECK(length(root_event_id) > 0),
  cause_event_id TEXT NOT NULL CHECK(length(cause_event_id) > 0),
  source_revision TEXT NOT NULL CHECK(length(source_revision) > 0),
  hub_lane TEXT NOT NULL CHECK(length(hub_lane) > 0),
  completion_condition TEXT NOT NULL CHECK(length(completion_condition) > 0),
  delivery_ref TEXT,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, object_id)
) STRICT;

CREATE INDEX product_work_refs_scope ON work_refs(account_id, data_domain, updated_at DESC);
