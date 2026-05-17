-- Task #1249 — Re-check saved external logo / favicon URLs in the
-- background so newly broken hosts get caught.
--
-- Task #1089 verifies the URL at save time, but a host that goes down a
-- week later silently breaks the public mini-site until an admin
-- happens to look. A daily cron (`recheckExternalMarketingImages` in
-- `artifacts/api-server/src/lib/cron.ts`) re-probes each saved external
-- URL with the same SSRF-guarded verifier and uses the columns added
-- here to:
--   * skip rows checked within the last day (`*_last_checked_at`),
--   * tolerate transient blips before clearing the URL
--     (`*_consecutive_failures` — auto-clear at 3 ≈ 3 days),
--   * surface the failure mode in the admin alert email
--     (`*_last_error`).
--
-- The columns are NULL / 0 on existing rows so the cron treats every
-- saved URL as "due for its first re-check" on next tick — exactly what
-- we want for the backfill case.
ALTER TABLE "club_marketing_sites"
  ADD COLUMN IF NOT EXISTS "logo_image_url_last_checked_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "logo_image_url_consecutive_failures" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "logo_image_url_last_error" text,
  ADD COLUMN IF NOT EXISTS "favicon_url_last_checked_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "favicon_url_consecutive_failures" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "favicon_url_last_error" text;
