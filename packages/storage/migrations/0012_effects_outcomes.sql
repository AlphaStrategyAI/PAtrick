CREATE TABLE work_pr_builds (
  build_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  grant_id TEXT NOT NULL REFERENCES execution_grants(grant_id),
  attempt_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id),
  source_config_revision INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  basis_hash TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  artifact TEXT NOT NULL,
  output_hash TEXT REFERENCES blobs(sha256),
  patch TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  FOREIGN KEY (work_id, generation) REFERENCES work_generations(work_id, generation),
  UNIQUE (work_id, generation)
) STRICT;

CREATE TABLE work_pr_cases (
  root_id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id),
  FOREIGN KEY (dataset_id, case_id) REFERENCES cases(dataset_id, case_id),
  UNIQUE (dataset_id, case_id)
) STRICT;

CREATE TRIGGER work_pr_builds_immutable_update BEFORE UPDATE ON work_pr_builds BEGIN
  SELECT RAISE(ABORT, 'WORK_BUILD_IMMUTABLE');
END;
CREATE TRIGGER work_pr_builds_immutable_delete BEFORE DELETE ON work_pr_builds BEGIN
  SELECT RAISE(ABORT, 'WORK_BUILD_IMMUTABLE');
END;
CREATE TRIGGER work_pr_cases_immutable_update BEFORE UPDATE ON work_pr_cases BEGIN
  SELECT RAISE(ABORT, 'WORK_CASE_IMMUTABLE');
END;
CREATE TRIGGER work_pr_cases_immutable_delete BEFORE DELETE ON work_pr_cases BEGIN
  SELECT RAISE(ABORT, 'WORK_CASE_IMMUTABLE');
END;

CREATE TABLE effect_intents (
  intent_id TEXT PRIMARY KEY,
  effect_key TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  work_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK(origin = 'business'),
  action TEXT NOT NULL CHECK(action = 'publish_pr'),
  build_id TEXT NOT NULL REFERENCES work_pr_builds(build_id),
  authorization_ref TEXT NOT NULL REFERENCES execution_grants(grant_id),
  authorization_epoch INTEGER NOT NULL CHECK(authorization_epoch >= 0),
  resource TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  expected_remote_version TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  dataset_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  FOREIGN KEY (work_id, generation) REFERENCES work_generations(work_id, generation),
  FOREIGN KEY (dataset_id, case_id) REFERENCES cases(dataset_id, case_id),
  UNIQUE (account_id, data_domain, work_id, generation, action),
  UNIQUE (repo_id, branch)
) STRICT;

CREATE TABLE effect_receipts (
  intent_id TEXT PRIMARY KEY REFERENCES effect_intents(intent_id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'blocked', 'uncertain', 'conflict', 'verified')),
  reason TEXT,
  remote_number INTEGER CHECK(remote_number > 0),
  verified_base_sha TEXT,
  verified_head_sha TEXT,
  verified_tree_sha TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'verified' AND remote_number IS NOT NULL AND verified_base_sha IS NOT NULL
      AND verified_head_sha IS NOT NULL AND verified_tree_sha IS NOT NULL)
    OR (status <> 'verified' AND verified_base_sha IS NULL AND verified_head_sha IS NULL AND verified_tree_sha IS NULL)
  )
) STRICT;

CREATE INDEX effect_verified_numbers ON effect_receipts(remote_number) WHERE status = 'verified';

CREATE TRIGGER effect_verified_receipt_immutable
BEFORE UPDATE ON effect_receipts WHEN OLD.status = 'verified'
BEGIN
  SELECT RAISE(ABORT, 'VERIFIED_RECEIPT_IMMUTABLE');
END;

CREATE TABLE effect_dispatches (
  dispatch_seq INTEGER PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES effect_intents(intent_id),
  phase TEXT NOT NULL CHECK(phase IN ('build_blob', 'build_tree', 'build_commit', 'create_ref', 'create_pr', 'rebuild_tree', 'rebuild_commit', 'update_ref')),
  expected_remote_version TEXT NOT NULL,
  authorization_ref TEXT NOT NULL REFERENCES execution_grants(grant_id),
  created_at TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  expected_head_sha TEXT,
  CHECK ((phase = 'create_pr' AND expected_head_sha IS NOT NULL AND length(expected_head_sha) = 40)
    OR (phase <> 'create_pr' AND expected_head_sha IS NULL)),
  UNIQUE (intent_id, phase, operation_key)
) STRICT;

CREATE TABLE effect_pr_rebuilds (
  rebuild_id INTEGER PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES effect_intents(intent_id),
  remote_number INTEGER CHECK(remote_number > 0),
  parent_head_sha TEXT,
  observed_base_sha TEXT NOT NULL,
  base_tree_sha TEXT NOT NULL,
  patch_digest TEXT NOT NULL,
  source_revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id),
  replacement_tree_sha TEXT NOT NULL CHECK(length(replacement_tree_sha) = 40),
  replacement_head_sha TEXT NOT NULL CHECK(length(replacement_head_sha) = 40),
  payload TEXT NOT NULL,
  applied_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER effect_pr_rebuild_recipe_immutable BEFORE UPDATE OF intent_id, remote_number, parent_head_sha,
  observed_base_sha, base_tree_sha, patch_digest, source_revision_id, replacement_tree_sha, replacement_head_sha, payload, created_at
  ON effect_pr_rebuilds BEGIN
  SELECT RAISE(ABORT, 'REBUILD_RECIPE_IMMUTABLE');
END;

CREATE INDEX effect_pr_rebuilds_intent ON effect_pr_rebuilds(intent_id, rebuild_id);

CREATE TABLE effect_observations (
  intent_id TEXT NOT NULL REFERENCES effect_intents(intent_id),
  observation_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('head_changed', 'identity_anomaly')),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (intent_id, observation_key)
) STRICT;
CREATE TABLE outcome_watches (
  intent_id TEXT PRIMARY KEY REFERENCES effect_intents(intent_id),
  dataset_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  remote_ref TEXT NOT NULL UNIQUE,
  observed_revision TEXT,
  FOREIGN KEY (dataset_id, case_id) REFERENCES cases(dataset_id, case_id)
) STRICT;
