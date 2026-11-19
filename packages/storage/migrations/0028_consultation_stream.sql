ALTER TABLE consultations ADD COLUMN partial_text TEXT NOT NULL DEFAULT '';

ALTER TABLE consultations ADD COLUMN partial_updated_at TEXT;
