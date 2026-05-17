-- Task #1124 — "Track whether members opened the export-expiring reminder".
--
-- The Task #922 / Task #972 reminder crons fan out an `export_expiring`
-- notice ~24h before the 7-day signed download URL expires, but we have no
-- telemetry on whether members actually open it. Without that signal admins
-- can't tell whether the courtesy nudge is reducing the rate at which
-- members re-request a fresh export the next day.
--
-- We mint a per-request opaque tracking token at send time, embed a 1x1
-- pixel + a click-tracking redirect for the download CTA in the email, and
-- stamp these timestamps the first time each event fires. The controller
-- dashboard exposes an "X% of expiring-export reminders opened" widget that
-- reads from these columns.
--
-- The token is intentionally separate from the Task #1075 unsubscribe
-- token so the public open/click endpoints can never be coerced into
-- silencing a member's reminder.
ALTER TABLE "member_data_requests"
  ADD COLUMN IF NOT EXISTS "expiring_reminder_tracking_token" text;
ALTER TABLE "member_data_requests"
  ADD COLUMN IF NOT EXISTS "expiring_reminder_email_opened_at" timestamptz;
ALTER TABLE "member_data_requests"
  ADD COLUMN IF NOT EXISTS "expiring_reminder_email_clicked_at" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS "member_data_requests_expiring_tracking_token_unique"
  ON "member_data_requests" ("expiring_reminder_tracking_token");
