-- Task 322: per-levy CSV pack option for the club-wide ledger digest.
-- Treasurers can now choose to receive a ZIP attachment containing one CSV
-- per levy (kept books separated by fundraiser) alongside or instead of the
-- single combined CSV, while keeping the same email cadence.

ALTER TABLE levy_ledger_email_org_schedules
  ADD COLUMN IF NOT EXISTS delivery_format text NOT NULL DEFAULT 'combined';

-- Allowed values: 'combined' | 'per_levy_zip' | 'both'.
-- Older rows default to 'combined' so the existing behaviour is preserved.
