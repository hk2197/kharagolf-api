-- Task #2081 — Add three new manual-entry alert tunables to
-- `ops_alert_settings` (singleton + history) and the matching CHECK
-- constraints. Mirrors the existing four manual-entry knobs
-- (`rateThresholdPct`, `minSample`, `consecutiveZero`, `cooldownHours`).
--
-- New singleton columns. All three are nullable on purpose so the
-- resolver's DB → env → default precedence (`opsAlertSettings.ts`)
-- can fall through cleanly when an operator hasn't set an override:
--
--   * `manual_entry_lookback_hours`  (int)  — how far back the cron
--     looks when computing the muted-skip pile-up `since` window. Used
--     to drive the dynamic breach detail string ("in the last Nh" /
--     "in the last N days") so operators can widen the audit window
--     during incident triage without redeploying.
--
--   * `manual_entry_dry_run`  (bool) — when true, the cron evaluates
--     breaches and logs them, but skips the chat dispatch, the email
--     loop, the page_history insert, and the cooldown stamp. Returns
--     `reason: "dry_run"` so the dashboard can show the would-be page
--     without paging on-call.
--
--   * `manual_entry_recipient_lookup_limit`  (int) — caps the
--     deduplicated recipient list (super_admins ∪ OPS_ALERT_EMAILS)
--     before the email loop. A safety belt against accidental fan-out
--     when a runaway super_admin import or env-var typo would
--     otherwise page hundreds of inboxes at 3 a.m.
--
-- New history columns. Same prev/new audit pattern as every other
-- column on `ops_alert_settings_history` (introduced in Task #1546):
-- six new nullable columns, two per tunable. Existing audit rows
-- backfill cleanly with NULL because none of these knobs existed at
-- the time of those PATCHes.
--
-- New CHECK constraints. The lookback window must be positive (the
-- cron multiplies it by 60*60*1000 to derive the `since` cutoff) and
-- the recipient lookup limit must be positive (a 0 / negative cap
-- would silently disable the email page entirely). The dry-run flag
-- intentionally has no CHECK — boolean nullable is the resolver's
-- "no DB override, fall through to env / default" sentinel.
--
-- Wrapped in `IF NOT EXISTS` for replay-safety, mirroring every
-- other migration in this directory.

ALTER TABLE "ops_alert_settings"
  ADD COLUMN IF NOT EXISTS "manual_entry_lookback_hours" integer;

ALTER TABLE "ops_alert_settings"
  ADD COLUMN IF NOT EXISTS "manual_entry_dry_run" boolean;

ALTER TABLE "ops_alert_settings"
  ADD COLUMN IF NOT EXISTS "manual_entry_recipient_lookup_limit" integer;

ALTER TABLE "ops_alert_settings"
  DROP CONSTRAINT IF EXISTS "ops_alert_settings_me_lookback_hours_chk";
ALTER TABLE "ops_alert_settings"
  ADD CONSTRAINT "ops_alert_settings_me_lookback_hours_chk"
    CHECK ("manual_entry_lookback_hours" IS NULL OR "manual_entry_lookback_hours" > 0);

ALTER TABLE "ops_alert_settings"
  DROP CONSTRAINT IF EXISTS "ops_alert_settings_me_recipient_lookup_limit_chk";
ALTER TABLE "ops_alert_settings"
  ADD CONSTRAINT "ops_alert_settings_me_recipient_lookup_limit_chk"
    CHECK ("manual_entry_recipient_lookup_limit" IS NULL OR "manual_entry_recipient_lookup_limit" > 0);

ALTER TABLE "ops_alert_settings_history"
  ADD COLUMN IF NOT EXISTS "prev_manual_entry_lookback_hours" integer;
ALTER TABLE "ops_alert_settings_history"
  ADD COLUMN IF NOT EXISTS "new_manual_entry_lookback_hours" integer;

ALTER TABLE "ops_alert_settings_history"
  ADD COLUMN IF NOT EXISTS "prev_manual_entry_dry_run" boolean;
ALTER TABLE "ops_alert_settings_history"
  ADD COLUMN IF NOT EXISTS "new_manual_entry_dry_run" boolean;

ALTER TABLE "ops_alert_settings_history"
  ADD COLUMN IF NOT EXISTS "prev_manual_entry_recipient_lookup_limit" integer;
ALTER TABLE "ops_alert_settings_history"
  ADD COLUMN IF NOT EXISTS "new_manual_entry_recipient_lookup_limit" integer;
