CREATE TABLE standards (
  standard_id TEXT PRIMARY KEY CHECK(length(standard_id) > 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  active_version INTEGER CHECK(active_version IS NULL OR active_version >= 1),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE standard_versions (
  standard_id TEXT NOT NULL REFERENCES standards(standard_id),
  version INTEGER NOT NULL CHECK(version >= 1),
  data_domain TEXT NOT NULL,
  scope_text TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  exceptions_text TEXT NOT NULL,
  counterexamples_text TEXT NOT NULL,
  source_text TEXT NOT NULL,
  document_id TEXT,
  source_revision INTEGER,
  content_hash TEXT,
  base_version INTEGER,
  status TEXT NOT NULL CHECK(status IN ('active', 'retained', 'withdrawn')),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (standard_id, version)
) STRICT;

CREATE TABLE standard_candidates (
  candidate_id TEXT PRIMARY KEY CHECK(length(candidate_id) > 0),
  standard_id TEXT NOT NULL REFERENCES standards(standard_id),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  draft_key TEXT NOT NULL,
  base_version INTEGER,
  document_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  pointer_revision INTEGER NOT NULL CHECK(pointer_revision >= 0),
  rules_json TEXT NOT NULL,
  evidence_watermark INTEGER NOT NULL CHECK(evidence_watermark >= 0),
  permission_hash TEXT NOT NULL CHECK(length(permission_hash) = 64),
  edit_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('open', 'adopted', 'stale', 'not_adopted')),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE evaluation_policies (
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version >= 1),
  data_domain TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  min_samples INTEGER NOT NULL CHECK(min_samples >= 1),
  threshold_thousandths INTEGER NOT NULL CHECK(threshold_thousandths >= 0 AND threshold_thousandths <= 1000),
  budget_micros INTEGER NOT NULL CHECK(budget_micros >= 0),
  external_method_id TEXT NOT NULL,
  external_method_revision TEXT NOT NULL,
  external_rules_json TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (policy_id, policy_version)
) STRICT;

CREATE UNIQUE INDEX evaluation_policies_domain_version
  ON evaluation_policies(data_domain, policy_version);

CREATE TABLE evaluation_datasets (
  dataset_id TEXT PRIMARY KEY CHECK(length(dataset_id) > 0),
  data_domain TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  training_ids TEXT NOT NULL,
  holdout_ids TEXT NOT NULL,
  split_hash TEXT NOT NULL CHECK(length(split_hash) = 64),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (policy_id, policy_version) REFERENCES evaluation_policies(policy_id, policy_version)
) STRICT;

CREATE TABLE cases (
  dataset_id TEXT NOT NULL REFERENCES evaluation_datasets(dataset_id),
  case_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('training', 'holdout')),
  situation TEXT NOT NULL,
  visible_evidence TEXT NOT NULL,
  options_json TEXT NOT NULL,
  expected_choice TEXT NOT NULL,
  case_version INTEGER NOT NULL CHECK(case_version >= 1),
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (dataset_id, case_id)
) STRICT;

CREATE TABLE case_outcomes (
  outcome_id TEXT PRIMARY KEY CHECK(length(outcome_id) > 0),
  dataset_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('accepted', 'rejected', 'rework', 'failure', 'unknown')),
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (dataset_id, case_id) REFERENCES cases(dataset_id, case_id)
) STRICT;

CREATE TABLE evaluation_reports (
  report_id TEXT PRIMARY KEY CHECK(length(report_id) > 0),
  candidate_id TEXT NOT NULL REFERENCES standard_candidates(candidate_id),
  standard_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('pass', 'fail', 'insufficient', 'leak')),
  training_correct INTEGER NOT NULL CHECK(training_correct >= 0),
  training_total INTEGER NOT NULL CHECK(training_total >= 0),
  holdout_correct INTEGER NOT NULL CHECK(holdout_correct >= 0),
  holdout_total INTEGER NOT NULL CHECK(holdout_total >= 0),
  baseline_correct INTEGER,
  external_correct INTEGER NOT NULL CHECK(external_correct >= 0),
  threshold_thousandths INTEGER NOT NULL,
  min_samples INTEGER NOT NULL,
  budget_micros INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  evidence_watermark INTEGER NOT NULL CHECK(evidence_watermark >= 0),
  permission_hash TEXT NOT NULL CHECK(length(permission_hash) = 64),
  base_version INTEGER,
  pointer_revision INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  frozen_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX evaluation_reports_freeze
  ON evaluation_reports(candidate_id, policy_version, source_revision, content_hash, evidence_watermark, permission_hash);

CREATE TABLE adoption_facts (
  fact_id TEXT PRIMARY KEY CHECK(length(fact_id) > 0),
  candidate_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  standard_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  active_version INTEGER NOT NULL CHECK(active_version >= 1),
  standard_revision INTEGER NOT NULL CHECK(standard_revision >= 1),
  projection_intent_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE judgment_bases (
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  basis_hash TEXT NOT NULL CHECK(length(basis_hash) = 64),
  standards_json TEXT NOT NULL,
  external_method_id TEXT,
  external_method_revision TEXT,
  evidence_watermark INTEGER NOT NULL CHECK(evidence_watermark >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (work_id, generation)
) STRICT;
