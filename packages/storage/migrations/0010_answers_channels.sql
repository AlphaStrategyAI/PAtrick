CREATE TABLE question_bindings (
  question_id TEXT NOT NULL,
  question_version INTEGER NOT NULL CHECK(question_version >= 0),
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK(proposal_revision >= 0),
  options_hash TEXT NOT NULL CHECK(length(options_hash) = 64),
  hub_card_id INTEGER NOT NULL,
  judgment_basis_hash TEXT NOT NULL CHECK(length(judgment_basis_hash) = 64),
  options_json TEXT NOT NULL,
  custom_rules_json TEXT NOT NULL,
  custom_allowed INTEGER NOT NULL CHECK(custom_allowed IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('open', 'closed', 'superseded')),
  successor_question_id TEXT,
  expected_material TEXT,
  collection_id TEXT,
  withdrawal_watermark INTEGER NOT NULL CHECK(withdrawal_watermark >= 0),
  schema_version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (question_id, question_version)
) STRICT;

CREATE TABLE question_locks (
  question_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('open', 'sending', 'verified', 'closed')),
  holder_intent_id TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE decision_submissions (
  submission_id TEXT PRIMARY KEY CHECK(length(submission_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  question_id TEXT NOT NULL,
  question_version INTEGER NOT NULL,
  raw_custom TEXT,
  disposition TEXT NOT NULL CHECK(disposition IN ('proceed', 'deferred', 'clarification_required')),
  reason_code TEXT,
  answer_intent_id TEXT,
  replacement_ref TEXT,
  option_id TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE answer_intents (
  intent_id TEXT PRIMARY KEY CHECK(length(intent_id) > 0),
  account_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK(length(command_fingerprint) = 64),
  question_id TEXT NOT NULL,
  question_version INTEGER NOT NULL,
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  proposal_revision INTEGER NOT NULL,
  options_hash TEXT NOT NULL,
  entry TEXT NOT NULL CHECK(entry IN ('web', 'feishu')),
  answer_kind TEXT NOT NULL CHECK(answer_kind IN ('option', 'custom')),
  option_id TEXT,
  option_index INTEGER,
  raw_custom TEXT,
  disposition TEXT,
  reason_code TEXT,
  next_action TEXT,
  difference TEXT,
  missing_json TEXT NOT NULL,
  collection_id TEXT,
  expected_material TEXT,
  connection_id TEXT,
  incarnation INTEGER,
  epoch INTEGER,
  config_revision INTEGER,
  binding_revision INTEGER,
  inbound_event_id TEXT,
  channel_permit TEXT,
  cutoff INTEGER,
  send_status TEXT NOT NULL CHECK(send_status IN ('stored', 'accepted', 'uncertain', 'rejected', 'skipped')),
  hub_card_id INTEGER,
  hub_answer_event_id TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, caller_id, client_request_id)
) STRICT;

CREATE TABLE answer_receipts (
  receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) > 0),
  intent_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  question_id TEXT NOT NULL,
  question_version INTEGER NOT NULL,
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  validity TEXT NOT NULL CHECK(validity IN (
    'verified', 'stale', 'rejected', 'conflict', 'deferred', 'clarification_required', 'uncertain', 'audit_only'
  )),
  disposition TEXT NOT NULL CHECK(disposition IN ('proceed', 'deferred', 'clarification_required')),
  reason_code TEXT,
  hub_answer_event_id TEXT,
  result_revision INTEGER NOT NULL CHECK(result_revision >= 0),
  successor_question_id TEXT,
  difference TEXT,
  missing_json TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX one_verified_hub_answer
ON answer_receipts(hub_answer_event_id)
WHERE validity = 'verified' AND hub_answer_event_id IS NOT NULL;

CREATE UNIQUE INDEX one_verified_question
ON answer_receipts(question_id)
WHERE validity = 'verified';

CREATE TABLE resume_intents (
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  question_id TEXT NOT NULL,
  answer_event_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('answer', 'evidence_ready')),
  state TEXT NOT NULL CHECK(state IN ('ready', 'claimed')),
  next_action TEXT NOT NULL,
  evidence_ref TEXT,
  attempt_id TEXT,
  PRIMARY KEY (work_id, generation, question_id, answer_event_id, phase)
) STRICT;

CREATE TABLE question_replacements (
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  question_id TEXT NOT NULL,
  question_version INTEGER NOT NULL CHECK(question_version >= 0),
  successor_question_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  difference TEXT NOT NULL,
  close_receipt TEXT,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (work_id, generation, question_id, question_version)
) STRICT;

CREATE TABLE evidence_proofs (
  proof_id TEXT PRIMARY KEY CHECK(length(proof_id) > 0),
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  answer_event_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  expected_material TEXT NOT NULL,
  withdrawal_watermark INTEGER NOT NULL CHECK(withdrawal_watermark >= 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (work_id, generation, question_id, answer_event_id)
) STRICT;

CREATE TABLE collection_rounds (
  round_id TEXT PRIMARY KEY CHECK(length(round_id) > 0),
  question_id TEXT NOT NULL,
  material TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  closed INTEGER NOT NULL CHECK(closed IN (0, 1)),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (question_id, material)
) STRICT;

CREATE TABLE stage_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) > 0),
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE work_stages (
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  stage TEXT NOT NULL CHECK(stage IN ('open', 'waiting_evidence', 'evidence_ready', 'delivering')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (work_id, generation)
) STRICT;

CREATE TABLE channel_connections (
  connection_id TEXT PRIMARY KEY CHECK(length(connection_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK(credential_version >= 0),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 0),
  channel_incarnation INTEGER NOT NULL CHECK(channel_incarnation >= 0),
  connection_epoch INTEGER NOT NULL CHECK(connection_epoch >= 0),
  binding_revision INTEGER NOT NULL CHECK(binding_revision >= 0),
  current_pairing_id TEXT,
  current_test_id TEXT,
  owner_open_id TEXT,
  chat_id TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'not_configured', 'checking', 'needs_binding', 'needs_test', 'needs_enable',
    'ready', 'degraded', 'draining', 'disabled', 'requires_reauthorization'
  )),
  transport_mode TEXT NOT NULL CHECK(transport_mode IN ('probe', 'active', 'draining', 'disabled')),
  reason_code TEXT,
  cutoff_seq INTEGER,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX one_feishu_app ON channel_connections(app_id, tenant_key);

CREATE TABLE channel_pairings (
  pairing_id TEXT PRIMARY KEY CHECK(length(pairing_id) > 0),
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  code_hash TEXT NOT NULL CHECK(length(code_hash) = 64),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  candidate_open_id TEXT,
  candidate_chat_id TEXT,
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK(config_revision >= 0),
  credential_version INTEGER NOT NULL CHECK(credential_version >= 0),
  binding_revision INTEGER NOT NULL CHECK(binding_revision >= 0),
  incarnation INTEGER NOT NULL CHECK(incarnation >= 0),
  epoch INTEGER NOT NULL CHECK(epoch >= 0),
  status TEXT NOT NULL CHECK(status IN ('open', 'candidate', 'consumed', 'expired', 'rejected')),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE channel_bindings (
  binding_id TEXT PRIMARY KEY CHECK(length(binding_id) > 0),
  connection_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  owner_open_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK(config_revision >= 0),
  credential_version INTEGER NOT NULL CHECK(credential_version >= 0),
  binding_revision INTEGER NOT NULL CHECK(binding_revision >= 0),
  incarnation INTEGER NOT NULL CHECK(incarnation >= 0),
  epoch INTEGER NOT NULL CHECK(epoch >= 0),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE channel_tests (
  test_id TEXT PRIMARY KEY CHECK(length(test_id) > 0),
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('previewed', 'sending', 'sent', 'verified', 'unknown', 'expired')),
  message_id TEXT,
  inbound_evidence TEXT,
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK(config_revision >= 0),
  credential_version INTEGER NOT NULL CHECK(credential_version >= 0),
  binding_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL CHECK(incarnation >= 0),
  epoch INTEGER NOT NULL CHECK(epoch >= 0),
  reason_code TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE channel_permits (
  permit_id TEXT PRIMARY KEY CHECK(length(permit_id) > 0),
  connection_id TEXT NOT NULL,
  inbound_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  permit_recorded INTEGER NOT NULL CHECK(permit_recorded IN (0, 1)),
  dispatch_seq INTEGER,
  terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)),
  incarnation INTEGER NOT NULL CHECK(incarnation >= 0),
  epoch INTEGER NOT NULL CHECK(epoch >= 0),
  config_revision INTEGER NOT NULL CHECK(config_revision >= 0),
  binding_revision INTEGER NOT NULL CHECK(binding_revision >= 0),
  cutoff INTEGER,
  disposition TEXT,
  intent_id TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, inbound_id)
) STRICT;

CREATE TABLE channel_audit (
  audit_id TEXT PRIMARY KEY CHECK(length(audit_id) > 0),
  connection_id TEXT NOT NULL,
  inbound_id TEXT NOT NULL,
  disposition TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE channel_receipts (
  receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) > 0),
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE channel_inbound (
  app_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, message_id)
) STRICT;
