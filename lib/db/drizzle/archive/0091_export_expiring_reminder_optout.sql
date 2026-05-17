-- Task #1075 — "Let members opt out of the export-expiring reminder".
--
-- Two surfaces for the opt-out:
--   1. A per-user global preference on `user_notification_prefs` so a member
--      can silence the 24h-before reminder for *every* future data export.
--   2. A per-request flag on `member_data_requests` so the original
--      `completed_export` ready email can carry a one-click "don't remind me
--      about this download" link. The token column is the opaque secret
--      embedded in that link; the timestamp column is stamped by the public
--      unsubscribe endpoint when the member taps it.
--
-- Both surfaces are read by `sendDataExportExpiringReminders` and
-- `sendDataExportPurgeReminders`, which now count suppressed rows on a
-- separate `suppressed` log field instead of mixing them with `notified`.
ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_data_export_expiring" boolean NOT NULL DEFAULT true;

ALTER TABLE "member_data_requests"
  ADD COLUMN IF NOT EXISTS "expiring_reminder_unsub_token" text;
ALTER TABLE "member_data_requests"
  ADD COLUMN IF NOT EXISTS "expiring_reminder_opted_out_at" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS "member_data_requests_expiring_unsub_token_unique"
  ON "member_data_requests" ("expiring_reminder_unsub_token");
