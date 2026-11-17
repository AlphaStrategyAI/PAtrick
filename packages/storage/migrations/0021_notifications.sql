CREATE TABLE notification_intents (
  intent_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  object_id TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK(event_version >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('decision','blocker','delivered','progress')),
  channel TEXT NOT NULL CHECK(channel IN ('feishu')),
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch > 0),
  binding_hash TEXT NOT NULL CHECK(length(binding_hash)=64),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','quiet','digest','sending','uncertain','retry_wait','sent','superseded','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_at TEXT,
  lease_until TEXT,
  evidence_hash TEXT CHECK(evidence_hash IS NULL OR length(evidence_hash)=64),
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,data_domain,object_id,event_version,channel)
) STRICT;
CREATE INDEX notification_scope_status ON notification_intents(account_id,data_domain,status,updated_at,intent_id);
CREATE TABLE notification_attempts (
  intent_id TEXT NOT NULL REFERENCES notification_intents(intent_id),
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  started_at TEXT NOT NULL,
  handed_off_at TEXT,
  finished_at TEXT,
  outcome TEXT CHECK(outcome IN ('sent','uncertain','not_delivered','superseded','blocked')),
  evidence_hash TEXT CHECK(evidence_hash IS NULL OR length(evidence_hash)=64),
  PRIMARY KEY(intent_id,attempt)
) STRICT;

CREATE TABLE diagnostic_previews (
  preview_id TEXT PRIMARY KEY REFERENCES command_inbox(command_id),
  data_domain TEXT NOT NULL,
  permission_epoch INTEGER NOT NULL CHECK(permission_epoch >= 0),
  view_epoch INTEGER NOT NULL CHECK(view_epoch >= 0),
  view_revision INTEGER NOT NULL CHECK(view_revision >= 0),
  hub_seq INTEGER NOT NULL CHECK(hub_seq >= 0),
  domain_seq INTEGER NOT NULL CHECK(domain_seq >= 0),
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64),
  report_json TEXT NOT NULL CHECK(length(report_json) <= 4096 AND json_valid(report_json) AND json_type(report_json) = 'object'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at > created_at)
) STRICT;

CREATE TABLE notification_maintenance_runs (
  hub_run INTEGER PRIMARY KEY CHECK(hub_run > 0),
  schedule_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('running','done','cancelled')),
  holder TEXT,
  lease_until TEXT,
  CHECK ((status='running' AND holder IS NOT NULL AND lease_until IS NOT NULL)
    OR (status<>'running' AND holder IS NULL AND lease_until IS NULL))
) STRICT;
CREATE INDEX notification_dispatch_scope ON notification_intents(account_id,data_domain,intent_id)
  WHERE status IN ('pending','quiet','sending','uncertain','retry_wait');
