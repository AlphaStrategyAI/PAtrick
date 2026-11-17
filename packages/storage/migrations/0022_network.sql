-- A single device row serializes every fixed network mutation across supervisor instances.
-- A pending lock has no automatic expiry: an interrupted external effect needs reconciliation.
CREATE TABLE network_device_state (
  device_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0 AND epoch <= 9007199254740991),
  owner_id TEXT,
  lock_token TEXT
) STRICT;

CREATE TABLE network_repair_operations (
  device_id TEXT NOT NULL REFERENCES network_device_state(device_id),
  proposal_id TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  expected_epoch INTEGER NOT NULL CHECK(expected_epoch >= 0),
  target_id TEXT NOT NULL,
  repair_id TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK(length(policy_digest) = 64),
  started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
  receipt_json TEXT CHECK(receipt_json IS NULL OR
    (length(receipt_json) <= 8192 AND json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
  PRIMARY KEY (device_id, proposal_id),
  UNIQUE (device_id, confirmation_id)
) STRICT;

CREATE TABLE network_repair_attempts (
  device_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 4),
  prior_epoch INTEGER NOT NULL CHECK(prior_epoch >= 0),
  apply_epoch INTEGER NOT NULL CHECK(apply_epoch = prior_epoch + 1),
  prior_rule TEXT NOT NULL CHECK(length(prior_rule) = 64),
  changed_rule TEXT CHECK(changed_rule IS NULL OR length(changed_rule) = 64),
  restore_epoch INTEGER CHECK(restore_epoch IS NULL OR (restore_epoch = apply_epoch + 1 AND changed_rule IS NOT NULL)),
  PRIMARY KEY (device_id, proposal_id, attempt),
  FOREIGN KEY (device_id, proposal_id) REFERENCES network_repair_operations(device_id, proposal_id)
) STRICT;

CREATE TABLE network_target_blockers (
  device_id TEXT NOT NULL REFERENCES network_device_state(device_id),
  target_id TEXT NOT NULL,
  retry_at INTEGER,
  mfa_question_id TEXT,
  PRIMARY KEY (device_id, target_id)
) STRICT;
