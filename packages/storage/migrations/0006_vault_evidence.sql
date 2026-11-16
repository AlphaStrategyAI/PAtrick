CREATE TABLE vaults (
  vault_id TEXT PRIMARY KEY CHECK(length(vault_id) > 0),
  source_id TEXT NOT NULL CHECK(length(source_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  capture_host TEXT NOT NULL,
  root_path TEXT NOT NULL,
  isolation_root TEXT NOT NULL,
  root_identity TEXT NOT NULL,
  physical_root TEXT NOT NULL,
  scope_hash TEXT NOT NULL CHECK(length(scope_hash) = 64),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  connection_epoch INTEGER NOT NULL CHECK(connection_epoch >= 0),
  status TEXT NOT NULL CHECK(status IN (
    'not_connected', 'checking', 'needs_install', 'needs_permission',
    'awaiting_confirmation', 'connected', 'degraded'
  )),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(physical_root),
  UNIQUE(account_id, data_domain)
) STRICT;

CREATE TABLE vault_clients (
  device_id TEXT NOT NULL,
  vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
  mapping_revision INTEGER NOT NULL CHECK(mapping_revision >= 0),
  app_status TEXT NOT NULL CHECK(app_status IN ('ready', 'missing', 'stopped', 'unknown')),
  editor_status TEXT NOT NULL CHECK(editor_status IN ('ready', 'missing', 'stopped', 'unknown')),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (device_id, vault_id)
) STRICT;

CREATE TABLE authority_facts (
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  active_version INTEGER,
  evaluation_threshold TEXT NOT NULL,
  delegation TEXT NOT NULL,
  PRIMARY KEY (account_id, data_domain)
) STRICT;

CREATE TABLE vault_documents (
  document_id TEXT PRIMARY KEY CHECK(length(document_id) > 0),
  vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
  relative_path TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('note', 'attachment', 'draft')),
  knowledge_id TEXT,
  patrick_id TEXT,
  body_text TEXT,
  content_hash TEXT,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  observed_seq INTEGER NOT NULL CHECK(observed_seq >= 0),
  tombstone INTEGER NOT NULL CHECK(tombstone IN (0, 1)),
  parse_error TEXT,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(vault_id, relative_path),
  CHECK((tombstone = 0 AND content_hash IS NOT NULL AND length(content_hash) = 64) OR (tombstone = 1 AND content_hash IS NULL))
) STRICT;

CREATE TABLE vault_revisions (
  vault_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES vault_documents(document_id),
  observed_seq INTEGER NOT NULL CHECK(observed_seq >= 1),
  revision_id TEXT NOT NULL UNIQUE,
  content_hash TEXT,
  identity_key TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  tombstone INTEGER NOT NULL CHECK(tombstone IN (0, 1)),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, observed_seq),
  FOREIGN KEY (content_hash) REFERENCES blobs(sha256),
  CHECK((tombstone = 0 AND content_hash IS NOT NULL AND length(content_hash) = 64) OR (tombstone = 1 AND content_hash IS NULL))
) STRICT;

CREATE TABLE knowledge_records (
  knowledge_id TEXT PRIMARY KEY CHECK(length(knowledge_id) > 0),
  canonical_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  status TEXT NOT NULL CHECK(status IN ('candidate', 'available', 'withdrawn')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE knowledge_aliases (
  knowledge_id TEXT NOT NULL REFERENCES knowledge_records(knowledge_id),
  alias TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  PRIMARY KEY (data_domain, alias)
) STRICT;

CREATE TABLE knowledge_members (
  knowledge_id TEXT NOT NULL REFERENCES knowledge_records(knowledge_id),
  member_kind TEXT NOT NULL CHECK(member_kind IN ('claim', 'entity')),
  member_id TEXT NOT NULL,
  evidence_id TEXT,
  PRIMARY KEY (knowledge_id, member_kind, member_id)
) STRICT;

CREATE TABLE evidence_refs (
  evidence_id TEXT PRIMARY KEY CHECK(length(evidence_id) > 0),
  knowledge_id TEXT NOT NULL REFERENCES knowledge_records(knowledge_id),
  data_domain TEXT NOT NULL,
  document_id TEXT,
  revision_id TEXT,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('supported', 'disputed', 'stale', 'retracted')),
  withdrawal_epoch INTEGER,
  span TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE evidence_dependencies (
  dependency_id TEXT PRIMARY KEY CHECK(length(dependency_id) > 0),
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  data_domain TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE withdrawal_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) > 0),
  data_domain TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_version INTEGER NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch >= 1),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  knowledge_id UNINDEXED,
  data_domain UNINDEXED,
  tokens,
  tokenize = 'unicode61'
);

CREATE TABLE edit_intents (
  edit_id TEXT PRIMARY KEY CHECK(length(edit_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
  operation TEXT NOT NULL CHECK(operation IN ('edit_original', 'supplement_knowledge', 'create_standard', 'revise_standard')),
  active_key TEXT NOT NULL CHECK(length(active_key) > 0),
  draft_key TEXT,
  target_id TEXT,
  base_version INTEGER,
  document_id TEXT,
  relative_path TEXT,
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
  closed_at TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX edit_intents_one_active
  ON edit_intents(account_id, data_domain, active_key)
  WHERE closed_at IS NULL;

CREATE TABLE draft_intents (
  edit_id TEXT PRIMARY KEY REFERENCES edit_intents(edit_id),
  vault_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  document_id TEXT NOT NULL,
  template_hash TEXT,
  proof_hash TEXT,
  proof_identity TEXT,
  write_state TEXT NOT NULL CHECK(write_state IN ('pending', 'written', 'exists', 'conflict')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE edit_receipts (
  edit_id TEXT NOT NULL REFERENCES edit_intents(edit_id),
  receipt_revision INTEGER NOT NULL CHECK(receipt_revision >= 0),
  file_state TEXT NOT NULL CHECK(file_state IN ('preparing', 'awaiting_save', 'collected', 'invalid', 'conflict')),
  file_proof_ref TEXT,
  business_state TEXT NOT NULL CHECK(business_state IN (
    'not_started', 'pending', 'verifying', 'evaluating', 'adopted', 'not_adopted', 'stale'
  )),
  candidate_id TEXT,
  result_ref TEXT,
  projection_state TEXT NOT NULL CHECK(projection_state IN (
    'not_due', 'pending', 'current', 'failed', 'cleanup_pending', 'superseded'
  )),
  projection_intent_id TEXT,
  projection_revision INTEGER,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (edit_id, receipt_revision)
) STRICT;

CREATE TABLE projection_batches (
  data_domain TEXT NOT NULL,
  view_kind TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK(projection_revision >= 0),
  vault_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64),
  cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('pending', 'current', 'failed', 'cleanup_pending', 'superseded')),
  applied INTEGER NOT NULL CHECK(applied IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (data_domain, view_kind, projection_revision)
) STRICT;

CREATE TABLE projection_pointers (
  data_domain TEXT NOT NULL,
  view_kind TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK(projection_revision >= 0),
  intent_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (data_domain, view_kind)
) STRICT;

CREATE TABLE projection_locks (
  data_domain TEXT NOT NULL,
  view_kind TEXT NOT NULL,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (data_domain, view_kind)
) STRICT;
