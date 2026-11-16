CREATE TABLE schema_migrations (
  position INTEGER PRIMARY KEY,
  file TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64)
) STRICT;

CREATE TABLE command_inbox (
  account_id TEXT NOT NULL, caller_id TEXT NOT NULL, client_request_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  command_fingerprint TEXT NOT NULL CHECK(length(command_fingerprint) = 64),
  PRIMARY KEY (account_id, caller_id, client_request_id)
) STRICT;

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE object_revisions (
  object_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  blob_ref TEXT REFERENCES blobs(sha256),
  command_id TEXT REFERENCES command_inbox(command_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (object_id, revision)
) STRICT;

CREATE TABLE domain_events (
  seq INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version >= 0),
  causation_id TEXT,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE outbox (
  event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  destination TEXT NOT NULL,
  result TEXT CHECK(result IS NULL OR result IN ('accepted', 'duplicate')),
  acked_at TEXT,
  PRIMARY KEY (event_id, destination)
) STRICT;

CREATE TABLE projection_cursors (
  name TEXT PRIMARY KEY,
  hub_seq INTEGER NOT NULL CHECK(hub_seq >= 0),
  domain_seq INTEGER NOT NULL CHECK(domain_seq >= 0),
  updated_at TEXT NOT NULL
) STRICT;
