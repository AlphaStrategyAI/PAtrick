-- A directory generation records successful local collection commits, not authorization.
CREATE UNIQUE INDEX source_directory_generation_identity
  ON source_configs(source_id, account_id, data_domain, connector_type);

CREATE TABLE directory_commit_generations (
  source_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  connector_type TEXT NOT NULL DEFAULT 'directory' CHECK(connector_type = 'directory'),
  commit_generation INTEGER NOT NULL CHECK(commit_generation BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY(source_id, account_id, data_domain, connector_type)
    REFERENCES source_configs(source_id, account_id, data_domain, connector_type)
) STRICT;

INSERT INTO directory_commit_generations(source_id, account_id, data_domain, commit_generation)
SELECT source_id, account_id, data_domain, 0 FROM source_configs WHERE connector_type = 'directory';

CREATE TRIGGER source_directory_generation_insert AFTER INSERT ON source_configs
WHEN NEW.connector_type = 'directory' BEGIN
  INSERT INTO directory_commit_generations(source_id, account_id, data_domain, commit_generation)
  VALUES (NEW.source_id, NEW.account_id, NEW.data_domain, 0);
END;

CREATE TRIGGER directory_generation_no_reset BEFORE UPDATE ON directory_commit_generations
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.account_id IS NOT OLD.account_id
  OR NEW.data_domain IS NOT OLD.data_domain OR NEW.connector_type IS NOT OLD.connector_type
  OR NEW.commit_generation <> OLD.commit_generation + 1 BEGIN
  SELECT RAISE(ABORT, 'SOURCE_GENERATION_IMMUTABLE');
END;
CREATE TRIGGER directory_generation_no_delete BEFORE DELETE ON directory_commit_generations BEGIN
  SELECT RAISE(ABORT, 'SOURCE_GENERATION_IMMUTABLE');
END;
CREATE TRIGGER directory_generation_no_replace BEFORE INSERT ON directory_commit_generations
WHEN EXISTS (SELECT 1 FROM directory_commit_generations WHERE source_id=NEW.source_id) BEGIN
  SELECT RAISE(ABORT, 'SOURCE_GENERATION_IMMUTABLE');
END;
