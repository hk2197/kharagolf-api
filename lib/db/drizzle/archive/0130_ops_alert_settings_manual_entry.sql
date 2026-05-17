-- Task #1664 — extend the ops alert tunables singleton + audit log with
-- the four manual-entry alert health knobs (rate threshold %, min
-- sample, consecutive-zero count, cooldown hours).
--
-- Background: Task #1387 added an hourly cron that pages super-admins
-- + on-call when manual-entry alert delivery health drops, but its four
-- tunables only lived in env config (`OPS_MANUAL_ENTRY_ALERT_*`). This
-- migration mirrors the Task #1305 / #1546 pattern that already worked
-- for the retry-exhaustion alert: store nullable overrides on the
-- existing `ops_alert_settings` singleton and append prev/new values to
-- `ops_alert_settings_history` on every PATCH.
--
-- All four override columns are nullable: NULL = "fall back to env /
-- hardcoded default at read time", which preserves the historical
-- behaviour for environments that haven't customised anything yet.
-- The CHECK constraints reject zero / negative values up-front so the
-- API doesn't have to repeat the validation, and the rate threshold
-- caps at 100 so the UI can't store a value the cron can never
-- satisfy.

ALTER TABLE "ops_alert_settings"
  ADD COLUMN IF NOT EXISTS "manual_entry_rate_threshold_pct" integer,
  ADD COLUMN IF NOT EXISTS "manual_entry_min_sample" integer,
  ADD COLUMN IF NOT EXISTS "manual_entry_consecutive_zero" integer,
  ADD COLUMN IF NOT EXISTS "manual_entry_cooldown_hours" integer;

ALTER TABLE "ops_alert_settings"
  DROP CONSTRAINT IF EXISTS "ops_alert_settings_me_rate_threshold_chk";
ALTER TABLE "ops_alert_settings"
  ADD CONSTRAINT "ops_alert_settings_me_rate_threshold_chk"
  CHECK (
    "manual_entry_rate_threshold_pct" IS NULL
    OR (
      "manual_entry_rate_threshold_pct" > 0
      AND "manual_entry_rate_threshold_pct" <= 100
    )
  );

ALTER TABLE "ops_alert_settings"
  DROP CONSTRAINT IF EXISTS "ops_alert_settings_me_min_sample_chk";
ALTER TABLE "ops_alert_settings"
  ADD CONSTRAINT "ops_alert_settings_me_min_sample_chk"
  CHECK ("manual_entry_min_sample" IS NULL OR "manual_entry_min_sample" > 0);

ALTER TABLE "ops_alert_settings"
  DROP CONSTRAINT IF EXISTS "ops_alert_settings_me_consecutive_zero_chk";
ALTER TABLE "ops_alert_settings"
  ADD CONSTRAINT "ops_alert_settings_me_consecutive_zero_chk"
  CHECK ("manual_entry_consecutive_zero" IS NULL OR "manual_entry_consecutive_zero" > 0);

ALTER TABLE "ops_alert_settings"
  DROP CONSTRAINT IF EXISTS "ops_alert_settings_me_cooldown_hours_chk";
ALTER TABLE "ops_alert_settings"
  ADD CONSTRAINT "ops_alert_settings_me_cooldown_hours_chk"
  CHECK ("manual_entry_cooldown_hours" IS NULL OR "manual_entry_cooldown_hours" > 0);

ALTER TABLE "ops_alert_settings_history"
  ADD COLUMN IF NOT EXISTS "prev_manual_entry_rate_threshold_pct" integer,
  ADD COLUMN IF NOT EXISTS "new_manual_entry_rate_threshold_pct" integer,
  ADD COLUMN IF NOT EXISTS "prev_manual_entry_min_sample" integer,
  ADD COLUMN IF NOT EXISTS "new_manual_entry_min_sample" integer,
  ADD COLUMN IF NOT EXISTS "prev_manual_entry_consecutive_zero" integer,
  ADD COLUMN IF NOT EXISTS "new_manual_entry_consecutive_zero" integer,
  ADD COLUMN IF NOT EXISTS "prev_manual_entry_cooldown_hours" integer,
  ADD COLUMN IF NOT EXISTS "new_manual_entry_cooldown_hours" integer;
