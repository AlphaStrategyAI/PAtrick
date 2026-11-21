-- Verified hosts are what probes read. Pending hosts stay invisible until recheck promotes them.
CREATE TABLE connectivity_probe_targets (
  account_id TEXT NOT NULL,
  data_domain TEXT NOT NULL,
  verified_intranet TEXT NOT NULL CHECK(length(verified_intranet) BETWEEN 1 AND 253),
  verified_public TEXT NOT NULL CHECK(length(verified_public) BETWEEN 1 AND 253),
  verified_revision INTEGER NOT NULL CHECK(verified_revision >= 0 AND verified_revision <= 9007199254740991),
  pending_intranet TEXT CHECK(pending_intranet IS NULL OR length(pending_intranet) BETWEEN 1 AND 253),
  pending_public TEXT CHECK(pending_public IS NULL OR length(pending_public) BETWEEN 1 AND 253),
  pending_revision INTEGER CHECK(pending_revision IS NULL OR
    (pending_revision > verified_revision AND pending_revision <= 9007199254740991)),
  PRIMARY KEY (account_id, data_domain),
  CHECK((pending_intranet IS NULL) = (pending_public IS NULL)),
  CHECK((pending_intranet IS NULL) = (pending_revision IS NULL))
) STRICT;
