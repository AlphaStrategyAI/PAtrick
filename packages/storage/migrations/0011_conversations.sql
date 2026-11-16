ALTER TABLE consultations ADD COLUMN caller_request_id TEXT;
ALTER TABLE consultations ADD COLUMN request_fingerprint TEXT;
ALTER TABLE consultations ADD COLUMN raw_text TEXT;
ALTER TABLE consultations ADD COLUMN final_result TEXT;
ALTER TABLE consultations ADD COLUMN conversation_id TEXT;

CREATE UNIQUE INDEX consultation_caller_request
ON consultations(account_id, caller_id, caller_request_id)
WHERE caller_request_id IS NOT NULL;

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY CHECK(length(conversation_id) > 0),
  account_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('work', 'consultation')),
  origin TEXT NOT NULL,
  work_id TEXT,
  context_ref TEXT,
  return_to TEXT,
  caller_request_id TEXT,
  request_fingerprint TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX conversation_caller_request
ON conversations(account_id, caller_id, caller_request_id)
WHERE caller_request_id IS NOT NULL;

CREATE TABLE messages (
  message_id TEXT PRIMARY KEY CHECK(length(message_id) > 0),
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  work_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  kind TEXT NOT NULL CHECK(kind IN (
    'user_text',
    'research_summary',
    'decision_card',
    'receipt',
    'outcome',
    'feedback',
    'final_answer'
  )),
  raw_text TEXT NOT NULL,
  source_revision INTEGER,
  result_version INTEGER,
  caller_request_id TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX messages_by_conversation ON messages(conversation_id, created_at, message_id);

CREATE UNIQUE INDEX message_caller_request
ON messages(conversation_id, caller_request_id)
WHERE caller_request_id IS NOT NULL;
