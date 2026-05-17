-- Task #1724 — per-event opt-out for the courtesy email a coach receives
-- when an organisation admin manually re-verifies their payout account
-- (`sendCoachPayoutAccountReverifiedByAdminEmail`, added in Task #1428).
-- Until now the only switch was the broader `billing` comm-prefs opt-out,
-- which also silences payout receipts and the cron-side needs-attention
-- email — far more than coaches who only want to mute the admin
-- courtesy notice. Mirrors the per-event pattern admins got for the
-- inverse direction (`notify_coach_payout_account_changes`, Task #1224).
-- Defaults to true so existing coaches keep receiving the notice;
-- setting it false skips just the admin-triggered courtesy email and
-- leaves every other payout-related notification intact.
ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_admin_payout_reverify" boolean NOT NULL DEFAULT true;
