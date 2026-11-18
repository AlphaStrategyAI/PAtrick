-- Existing revisions have no trustworthy configuration version and remain unassociated.
CREATE UNIQUE INDEX source_revision_provenance_identity
  ON source_revisions(revision_id, source_id, account_id, data_domain);
CREATE UNIQUE INDEX source_version_provenance_identity
  ON source_versions(source_id, config_revision, account_id, data_domain);

CREATE TABLE source_revision_provenance (
  revision_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  FOREIGN KEY (revision_id, source_id, account_id, data_domain)
    REFERENCES source_revisions(revision_id, source_id, account_id, data_domain),
  FOREIGN KEY (source_id, config_revision, account_id, data_domain)
    REFERENCES source_versions(source_id, config_revision, account_id, data_domain)
) STRICT;

CREATE TRIGGER source_revision_provenance_no_update BEFORE UPDATE ON source_revision_provenance BEGIN
  SELECT RAISE(ABORT, 'SOURCE_REVISION_PROVENANCE_IMMUTABLE');
END;
CREATE TRIGGER source_revision_provenance_no_delete BEFORE DELETE ON source_revision_provenance BEGIN
  SELECT RAISE(ABORT, 'SOURCE_REVISION_PROVENANCE_IMMUTABLE');
END;

CREATE TRIGGER source_revision_provenance_no_replace BEFORE INSERT ON source_revision_provenance
WHEN EXISTS (SELECT 1 FROM source_revision_provenance WHERE revision_id = NEW.revision_id) BEGIN
  SELECT RAISE(ABORT, 'SOURCE_REVISION_PROVENANCE_IMMUTABLE');
END;
