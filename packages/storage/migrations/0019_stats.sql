CREATE TABLE stats_facts (
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('owner_decision','automatic_decision','delivered_work')),
  fact_key TEXT NOT NULL,
  first_seq INTEGER NOT NULL CHECK(first_seq > 0),
  occurred_at TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0,1)),
  invalidated_seq INTEGER CHECK(invalidated_seq IS NULL OR invalidated_seq > 0),
  PRIMARY KEY(account_id,data_domain,kind,fact_key)
) STRICT;

CREATE INDEX stats_valid_activity_window
  ON stats_facts(account_id,data_domain,kind,occurred_at,fact_key) WHERE valid=1;
CREATE INDEX stats_input_scope_seq ON domain_events(account_id,data_domain,seq);
CREATE INDEX stats_standards_scope ON standards(account_id,data_domain,active_version) WHERE active_version IS NOT NULL;
CREATE INDEX stats_knowledge_scope ON knowledge_records(account_id,data_domain,canonical_id) WHERE status='available';
CREATE INDEX stats_mandates_scope ON mandates(account_id,data_domain,type_id,status,expires_at);

CREATE TABLE stats_input_cursors (
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  work_epoch INTEGER NOT NULL CHECK(work_epoch > 0),
  domain_seq INTEGER NOT NULL CHECK(domain_seq >= 0),
  PRIMARY KEY(account_id,data_domain)
) STRICT;

-- Populated only by trusted producer-specific admission. Fact presence and a local
-- cursor are not evidence that the producer's history is complete.
CREATE TABLE stats_producer_coverage (
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  kind TEXT NOT NULL,
  producer TEXT NOT NULL,
  work_epoch INTEGER NOT NULL CHECK(work_epoch > 0),
  domain_seq INTEGER NOT NULL CHECK(domain_seq >= 0),
  hub_seq INTEGER NOT NULL CHECK(hub_seq >= 0),
  available_since TEXT NOT NULL,
  verified_through TEXT NOT NULL CHECK(verified_through >= available_since),
  complete_history INTEGER NOT NULL CHECK(complete_history IN (0,1)),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK((kind='owner_decision' AND producer='answer_gate')
     OR (kind='automatic_decision' AND producer='decision_commit')
     OR (kind='delivered_work' AND producer='pr_delivery')),
  PRIMARY KEY(account_id,data_domain,kind,work_epoch)
) STRICT;

CREATE TABLE stats_checkpoints (
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  hub_seq INTEGER NOT NULL CHECK(hub_seq >= 0),
  domain_seq INTEGER NOT NULL CHECK(domain_seq >= 0),
  work_epoch INTEGER NOT NULL CHECK(work_epoch > 0),
  work_notification_seq INTEGER NOT NULL CHECK(work_notification_seq >= 0),
  work_as_of TEXT NOT NULL,
  as_of TEXT NOT NULL,
  refresh_after TEXT,
  activity_proofs TEXT NOT NULL CHECK(json_valid(activity_proofs)),
  active_standards INTEGER NOT NULL CHECK(active_standards >= 0),
  knowledge_entries INTEGER NOT NULL CHECK(knowledge_entries >= 0),
  delegation_types INTEGER NOT NULL CHECK(delegation_types >= 0),
  active_delegation_types INTEGER NOT NULL CHECK(active_delegation_types >= 0),
  work_open INTEGER NOT NULL CHECK(work_open >= 0),
  work_awaiting_answer INTEGER NOT NULL CHECK(work_awaiting_answer >= 0),
  work_blocked INTEGER NOT NULL CHECK(work_blocked >= 0),
  PRIMARY KEY(account_id,data_domain)
) STRICT;
