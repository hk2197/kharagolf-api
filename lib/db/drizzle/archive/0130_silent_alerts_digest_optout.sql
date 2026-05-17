-- Task #1663 — Weekly silent-failure alerts CSV digest for super admins.
--
-- Adds:
--
--   * `user_notification_prefs.notify_silent_alerts_digest` — per-user
--     opt-out for the weekly super-admin CSV of zero-delivery
--     manual-entry alerts (the "silent failures" mailed by
--     `sendSilentAlertsDigestToSuperAdmins`). Defaults to true so
--     existing super admins keep receiving the digest; the cron skips
--     opted-out recipients and counts them on the dispatch log instead.
--     Mirrors the email-side opt-out semantics of
--     `notify_member_prefs_digest` (Task #1489) and
--     `notify_erasure_storage_digest` (Task #1242).

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_silent_alerts_digest" boolean NOT NULL DEFAULT true;

-- The cron writes a system-level marker row to `member_audit_log`
-- (entity = "silent_alerts_digest", action = "send") to persist the
-- 6.5-day dedup floor across process restarts. System-level cron
-- dispatches have no natural organization, so relax the column from
-- NOT NULL to nullable. Existing rows are unaffected — every legacy
-- audit row already has a real organization_id; only future
-- system-level markers will use NULL.
ALTER TABLE "member_audit_log"
  ALTER COLUMN "organization_id" DROP NOT NULL;
