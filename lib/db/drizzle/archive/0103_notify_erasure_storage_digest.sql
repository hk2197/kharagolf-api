-- Task #1242 — per-user opt-out for the daily controller digest of stuck
-- erasure cleanups (`sendErasureStorageFailuresDigest`, added in Task
-- #1078). The digest goes to every org_admin / membership_secretary /
-- treasurer on an org; this flag lets a controller (e.g. a treasurer
-- focused on finance) silence just this email without affecting other
-- org-admin notifications. Defaults to true so existing controllers keep
-- receiving the digest. The cron skips opted-out recipients and counts
-- them on a separate `suppressed` log field instead of mixing them with
-- `recipientsEmailed`. Honoured via either the in-portal toggle or the
-- one-click List-Unsubscribe link rendered in the email itself.
ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_erasure_storage_digest" boolean NOT NULL DEFAULT true;
