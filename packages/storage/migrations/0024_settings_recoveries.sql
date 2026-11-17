CREATE TABLE settings_recoveries (
  command_id TEXT PRIMARY KEY REFERENCES command_inbox(command_id),
  change_id TEXT NOT NULL REFERENCES settings_changes(change_id),
  validation_id TEXT NOT NULL UNIQUE REFERENCES settings_validations(validation_id),
  control_receipt_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  caller_id TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch>=0),
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
  phase TEXT NOT NULL CHECK(phase IN ('pending','observed','unresolved','superseded')),
  receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX settings_recoveries_change ON settings_recoveries(change_id,created_at);
