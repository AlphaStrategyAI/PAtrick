CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch >= 0),
  policy_revision INTEGER NOT NULL CHECK(policy_revision >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL CHECK(counter >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE bootstrap_tickets (
  ticket_hash TEXT PRIMARY KEY CHECK(length(ticket_hash) = 64),
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE auth_challenges (
  challenge_id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(account_id),
  purpose TEXT NOT NULL CHECK(purpose IN ('registration', 'authentication', 'control')),
  challenge TEXT NOT NULL,
  challenge_hash TEXT NOT NULL CHECK(length(challenge_hash) = 64),
  origin TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  caller_id TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch >= 0),
  expires_at TEXT NOT NULL,
  authenticated_at TEXT NOT NULL,
  credential_ref TEXT NOT NULL
) STRICT;

CREATE TABLE caller_scopes (
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  caller_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  permission TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (account_id, caller_id, data_domain, permission)
) STRICT;

CREATE TABLE control_proposals (
  proposal_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  proposal_hash TEXT NOT NULL CHECK(length(proposal_hash) = 64),
  target TEXT NOT NULL,
  action TEXT NOT NULL,
  scope TEXT NOT NULL,
  base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
  challenge_hash TEXT NOT NULL CHECK(length(challenge_hash) = 64),
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE control_receipts (
  receipt_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES control_proposals(proposal_id),
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  caller_id TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch >= 0),
  authenticated_at TEXT NOT NULL,
  proposal_hash TEXT NOT NULL CHECK(length(proposal_hash) = 64),
  challenge_hash TEXT NOT NULL CHECK(length(challenge_hash) = 64),
  base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
  credential_ref TEXT NOT NULL,
  command_id TEXT NOT NULL REFERENCES command_inbox(command_id),
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE command_records (
  command_id TEXT PRIMARY KEY REFERENCES command_inbox(command_id),
  account_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
