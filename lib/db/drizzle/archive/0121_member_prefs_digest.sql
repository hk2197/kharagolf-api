-- Task #1489 — Monthly per-org "member notification preferences" digest.
--
-- Adds two columns:
--
--   * `user_notification_prefs.notify_member_prefs_digest` — per-user
--     opt-out for the monthly controller digest (CSV of every member's
--     per-channel + per-category notify preferences). Mirrors the
--     email-side opt-out semantics of `notify_erasure_storage_digest`
--     (Task #1242). Defaults to true so existing controllers keep
--     receiving the digest; the cron skips opted-out recipients and
--     counts them on a separate `suppressed` log field.
--
--   * `organizations.member_prefs_digest_last_sent_on` — per-org dedup
--     watermark stamping the current month (UTC `YYYY-MM`) of the most
--     recent successful send. The cron polls daily and skips orgs whose
--     stamp already matches the current month, so a server restart in
--     the middle of a calendar month cannot trigger a duplicate send.

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_member_prefs_digest" boolean NOT NULL DEFAULT true;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "member_prefs_digest_last_sent_on" text;
