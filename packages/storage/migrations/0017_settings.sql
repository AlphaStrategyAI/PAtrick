CREATE TABLE settings_validations (
  validation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  caller_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT NOT NULL,
  draft_hash TEXT NOT NULL CHECK(length(draft_hash)=64),
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch>=0),
  base_revision INTEGER NOT NULL CHECK(base_revision>=0),
  device_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL CHECK(length(scope_hash)=64),
  valid INTEGER NOT NULL CHECK(valid IN (0,1)),
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX settings_validations_scope ON settings_validations(account_id,data_domain,expires_at);

CREATE TABLE settings_changes (
  change_id TEXT PRIMARY KEY REFERENCES command_inbox(command_id),
  validation_id TEXT NOT NULL UNIQUE REFERENCES settings_validations(validation_id),
  control_receipt_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  caller_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('applying','applied','observed','uncertain')),
  receipt TEXT NOT NULL CHECK(json_valid(receipt)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX settings_changes_scope ON settings_changes(account_id,data_domain,created_at DESC,change_id);
CREATE UNIQUE INDEX settings_one_unresolved_target ON settings_changes(account_id,data_domain,target_id)
  WHERE phase IN ('applying','applied','uncertain');

CREATE TABLE account_preferences (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id),
  revision INTEGER NOT NULL CHECK(revision>0),
  preferences TEXT NOT NULL CHECK(json_valid(preferences)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE preference_receipts (
  command_id TEXT PRIMARY KEY REFERENCES command_inbox(command_id),
  body TEXT NOT NULL CHECK(json_valid(body))
) STRICT;

CREATE TABLE settings_preflight_receipts (
  command_id TEXT PRIMARY KEY REFERENCES command_inbox(command_id),
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch>=0),
  body TEXT NOT NULL CHECK(json_valid(body))
) STRICT;
