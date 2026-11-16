CREATE TABLE mandate_types (
  type_id TEXT PRIMARY KEY CHECK(length(type_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  effects_json TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('L0', 'L1', 'L2', 'L3')),
  budget_micros INTEGER NOT NULL CHECK(budget_micros >= 0),
  config_version INTEGER NOT NULL CHECK(config_version >= 0),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE mandates (
  mandate_id TEXT PRIMARY KEY CHECK(length(mandate_id) > 0),
  type_id TEXT NOT NULL REFERENCES mandate_types(type_id),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'stopped')),
  actions_json TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  effects_json TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('L0', 'L1', 'L2', 'L3')),
  budget_micros INTEGER NOT NULL CHECK(budget_micros >= 0),
  expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  scope_hash TEXT NOT NULL CHECK(length(scope_hash) = 64),
  config_version INTEGER NOT NULL CHECK(config_version >= 0),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE capability_profiles (
  profile_id TEXT PRIMARY KEY CHECK(length(profile_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('L0', 'L1', 'L2', 'L3')),
  actions_json TEXT NOT NULL,
  report_id TEXT NOT NULL,
  report_version INTEGER NOT NULL CHECK(report_version >= 0),
  config_version INTEGER NOT NULL CHECK(config_version >= 0),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX capability_account_domain ON capability_profiles(account_id, data_domain);

CREATE TABLE work_generations (
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  root_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL REFERENCES mandates(mandate_id),
  phase TEXT NOT NULL CHECK(phase IN ('judgment', 'collect_evidence', 'delivery')),
  next_action TEXT NOT NULL,
  awaiting_answer INTEGER NOT NULL CHECK(awaiting_answer IN (0, 1)),
  evidence_ready INTEGER NOT NULL CHECK(evidence_ready IN (0, 1)),
  collection_id TEXT,
  control_state TEXT NOT NULL CHECK(control_state IN ('running', 'paused', 'processing', 'stopped')),
  process_tree_stopped INTEGER NOT NULL CHECK(process_tree_stopped IN (0, 1)),
  effects_reconciled INTEGER NOT NULL CHECK(effects_reconciled IN (0, 1)),
  attempt_closed INTEGER NOT NULL CHECK(attempt_closed IN (0, 1)),
  current_attempt_id TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (work_id, generation)
) STRICT;

CREATE TABLE consultations (
  request_id TEXT PRIMARY KEY CHECK(length(request_id) > 0),
  account_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  parent_work_id TEXT,
  result_version INTEGER NOT NULL CHECK(result_version >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending', 'answered', 'cancelled', 'failed')),
  domains_json TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  budget_micros INTEGER NOT NULL CHECK(budget_micros >= 0),
  permission_revision INTEGER NOT NULL CHECK(permission_revision >= 0),
  cancelled_at TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE maintenance_jobs (
  job_id TEXT PRIMARY KEY CHECK(length(job_id) > 0),
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('standard_evaluation', 'ui_translation')),
  status TEXT NOT NULL CHECK(status IN ('open', 'cancelled')),
  budget_micros INTEGER NOT NULL CHECK(budget_micros >= 0),
  result_ref TEXT NOT NULL CHECK(length(result_ref) > 0),
  expires_at TEXT NOT NULL,
  cancelled_at TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE execution_grants (
  grant_id TEXT PRIMARY KEY CHECK(length(grant_id) > 0),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('work', 'consultation', 'maintenance')),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  work_id TEXT,
  generation INTEGER,
  request_id TEXT,
  parent_work_id TEXT,
  result_version INTEGER,
  job_id TEXT,
  owner_id TEXT,
  caller_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  mandate_id TEXT,
  next_action TEXT NOT NULL,
  allowed_effects_json TEXT NOT NULL,
  allowed_domains_json TEXT NOT NULL,
  readonly_tools_json TEXT NOT NULL,
  basis_hash TEXT,
  phase TEXT,
  collection_id TEXT,
  scope_hash TEXT,
  permission_revision INTEGER NOT NULL CHECK(permission_revision >= 0),
  kind TEXT,
  result_ref TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (subject_kind = 'work'
      AND work_id IS NOT NULL AND generation IS NOT NULL
      AND request_id IS NULL AND parent_work_id IS NULL AND result_version IS NULL
      AND job_id IS NULL AND owner_id IS NULL
      AND mandate_id IS NOT NULL AND basis_hash IS NOT NULL AND length(basis_hash) = 64
      AND phase IS NOT NULL AND kind IS NULL AND result_ref IS NULL)
    OR (subject_kind = 'consultation'
      AND request_id IS NOT NULL AND result_version IS NOT NULL
      AND work_id IS NULL AND generation IS NULL AND job_id IS NULL AND owner_id IS NULL
      AND mandate_id IS NULL AND basis_hash IS NULL AND phase IS NULL
      AND kind IS NULL AND result_ref IS NULL)
    OR (subject_kind = 'maintenance'
      AND job_id IS NOT NULL AND owner_id IS NOT NULL AND kind IS NOT NULL AND result_ref IS NOT NULL
      AND work_id IS NULL AND generation IS NULL AND request_id IS NULL AND parent_work_id IS NULL
      AND result_version IS NULL AND mandate_id IS NULL AND basis_hash IS NULL AND phase IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX one_active_work_grant
ON execution_grants(work_id, generation) WHERE subject_kind = 'work' AND revoked_at IS NULL;

CREATE UNIQUE INDEX one_active_consultation_grant
ON execution_grants(request_id) WHERE subject_kind = 'consultation' AND revoked_at IS NULL;

CREATE UNIQUE INDEX one_active_maintenance_grant
ON execution_grants(job_id) WHERE subject_kind = 'maintenance' AND revoked_at IS NULL;

CREATE TABLE business_budgets (
  business_id TEXT PRIMARY KEY CHECK(length(business_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('work', 'consultation', 'maintenance')),
  limit_micros INTEGER NOT NULL CHECK(limit_micros >= 0),
  held_micros INTEGER NOT NULL CHECK(held_micros >= 0),
  spent_micros INTEGER NOT NULL CHECK(spent_micros >= 0),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (held_micros + spent_micros <= limit_micros)
) STRICT;

CREATE TABLE budget_reservations (
  reservation_id TEXT PRIMARY KEY CHECK(length(reservation_id) > 0),
  business_id TEXT NOT NULL REFERENCES business_budgets(business_id),
  grant_id TEXT NOT NULL REFERENCES execution_grants(grant_id),
  attempt_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  amount_micros INTEGER NOT NULL CHECK(amount_micros >= 0),
  status TEXT NOT NULL CHECK(status IN ('held', 'settled', 'uncertain')),
  dispatched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX budget_reservation_call ON budget_reservations(business_id, call_id);

CREATE TABLE usage_receipts (
  usage_id TEXT PRIMARY KEY CHECK(length(usage_id) > 0),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES budget_reservations(reservation_id),
  amount_micros INTEGER NOT NULL CHECK(amount_micros >= 0),
  proof TEXT NOT NULL CHECK(length(proof) > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE work_control_receipts (
  receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id) > 0),
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  account_id TEXT NOT NULL,
  command_type TEXT NOT NULL CHECK(command_type IN ('pause', 'resume', 'stop')),
  state TEXT NOT NULL CHECK(state IN ('paused', 'running', 'processing', 'stopped', 'denied')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  created_at TEXT NOT NULL
) STRICT;
