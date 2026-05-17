-- Task #1078 — daily controller digest for stuck erasure cleanup.
-- Adds a per-org dedup watermark so the cron can run on every restart
-- without double-emailing org_admins / membership_secretaries / treasurers.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "erasure_storage_digest_last_sent_on" text;
