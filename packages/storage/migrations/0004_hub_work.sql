CREATE TABLE hub_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) > 0),
  root TEXT NOT NULL,
  cause TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  hops INTEGER NOT NULL CHECK(hops >= 0 AND hops <= 8),
  kind TEXT NOT NULL CHECK(kind IN (
    'draft.requested',
    'draft.ready',
    'work.requested',
    'consultation.requested',
    'answer.verified',
    'evidence.ready'
  )),
  request_id TEXT,
  stage_key TEXT,
  hub_event INTEGER NOT NULL CHECK(hub_event >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE hub_snapshots (
  cursor_name TEXT PRIMARY KEY,
  hub_seq INTEGER NOT NULL CHECK(hub_seq >= 0),
  snapshot TEXT NOT NULL,
  imported_at TEXT NOT NULL
) STRICT;

CREATE TABLE raw_custom_answers (
  submission_id TEXT PRIMARY KEY CHECK(length(submission_id) > 0),
  raw_custom TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
