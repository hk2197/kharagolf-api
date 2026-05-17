-- Task #1449 — Split the per-user opt-out for the daily controller
-- "stuck erasure cleanup" digest into two channels.
--
-- Until now `notify_erasure_storage_digest` (Task #1242) silenced both:
--   * the email cron (`sendErasureStorageFailuresDigest` → bespoke template
--     `sendErasureStorageFailuresDigestEmail`), and
--   * the in-app inbox row + push (Task #1241,
--     `privacy.erasure.storage_failures.controller_digest` via
--     `dispatchNotification`).
--
-- A controller who wanted to keep the email but mute the daily push had no
-- way to do so. This migration adds a sibling column that gates ONLY the
-- in-app/push side, leaving the existing column to gate the email side.
-- The dispatcher's `PER_EVENT_OPT_OUT_COLUMNS` map switches to this column
-- so opting out of push no longer silences the email.
--
-- Defaults to true so existing controllers keep receiving the in-app row +
-- push unless they explicitly opt out from the portal preferences UI.

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_erasure_storage_digest_push" boolean NOT NULL DEFAULT true;
