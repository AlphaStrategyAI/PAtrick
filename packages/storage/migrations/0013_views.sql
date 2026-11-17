CREATE TABLE product_view_checkpoints (
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  hub_seq INTEGER NOT NULL CHECK(hub_seq >= 0),
  domain_seq INTEGER NOT NULL CHECK(domain_seq >= 0),
  notification_seq INTEGER NOT NULL CHECK(notification_seq >= 0),
  notification_floor INTEGER NOT NULL CHECK(notification_floor BETWEEN 0 AND notification_seq),
  observed_at TEXT NOT NULL,
  trusted_as_of TEXT,
  freshness TEXT NOT NULL CHECK(freshness IN ('fresh','syncing','stale','unknown')),
  health_payload TEXT CHECK(health_payload IS NULL OR json_valid(health_payload)),
  PRIMARY KEY(account_id, data_domain)
) STRICT;

CREATE TABLE product_view_keys (
  name TEXT PRIMARY KEY CHECK(name = 'cursor'),
  bytes BLOB NOT NULL CHECK(length(bytes) = 32)
) STRICT;

INSERT INTO product_view_keys (name,bytes) VALUES ('cursor',randomblob(32));

CREATE INDEX product_active_projection_scopes ON caller_scopes(account_id,data_domain) WHERE revoked_at IS NULL;
CREATE INDEX product_delivery_event_lookup ON domain_events(account_id,data_domain,aggregate_id,aggregate_version,seq DESC)
  WHERE json_extract(payload,'$.type')='work.delivered';
CREATE INDEX product_work_generation_scope ON work_generations(account_id,data_domain,work_id,generation DESC);
CREATE INDEX product_open_question_lookup ON question_bindings(account_id,data_domain,work_id,generation,updated_at DESC,question_version DESC)
  WHERE status='open';

CREATE TABLE product_work_views (
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  visible INTEGER NOT NULL CHECK(visible IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('researching','awaiting_answer','verifying','paused','blocked','delivered')),
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(account_id, data_domain, work_id)
) STRICT;

CREATE INDEX product_work_visible_order ON product_work_views(account_id, data_domain, updated_at DESC, work_id)
  WHERE visible = 1;

CREATE TABLE product_view_events (
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq > 0),
  kind TEXT NOT NULL CHECK(kind IN ('work.changed','work.removed','projection.changed')),
  resource_id TEXT,
  resource_revision INTEGER,
  as_of TEXT NOT NULL,
  hub_seq INTEGER NOT NULL CHECK(hub_seq >= 0),
  domain_seq INTEGER NOT NULL CHECK(domain_seq >= 0),
  PRIMARY KEY(account_id, data_domain, seq)
) STRICT;
