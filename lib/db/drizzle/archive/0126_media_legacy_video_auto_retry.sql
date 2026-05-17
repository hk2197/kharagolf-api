-- Task #1584 — Bounded background auto-retry for legacy NULL-duration videos.
--
-- Task #1327 added the manual admin "Re-check" action for legacy
-- video rows whose Task #855 backfill couldn't measure their length.
-- That recovers many transient ffprobe / object-storage failures, but
-- still requires a human to press the button. This migration adds the
-- two columns the new `recheckLegacyVideoDurations` cron uses to:
--
--   * count consecutive failed background re-probes per row, and
--   * stamp a "give up" reason once the auto-retry cap is reached so
--     the row stops being retried forever and only then shows up on
--     the admin "unverifiable videos" page (with an "auto-retried N
--     times" badge).
--
-- Columns:
--
--   * duration_auto_recheck_count   — int, NOT NULL DEFAULT 0. Bumped
--     by the cron each time a re-probe still produces NULL duration.
--     Reset to 0 when a probe (manual or auto) finally succeeds.
--
--   * duration_unverifiable_reason  — text, nullable. NULL means the
--     cron has not yet given up. After LEGACY_VIDEO_AUTO_RETRY_CAP
--     consecutive failures the cron writes either:
--       'object_missing'           — storage returned ObjectNotFoundError
--                                    on the most recent attempt; the
--                                    file was deleted from the bucket.
--       'permanently_unverifiable' — ffprobe consistently could not
--                                    read a duration.
--     A subsequent successful recheck (manual or auto) clears the
--     reason back to NULL and the row drops off the admin list.
--
-- Both columns are added with IF NOT EXISTS so a partial replay during
-- a deploy retry is safe.

ALTER TABLE "media"
  ADD COLUMN IF NOT EXISTS "duration_auto_recheck_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "duration_unverifiable_reason" text;

-- Partial index so the cron's "find next batch to re-probe" query
-- (which excludes already-given-up rows) stays cheap even as the media
-- table grows. Existing per-org / per-course indexes don't help here
-- because the cron sweeps all orgs in one pass.
CREATE INDEX IF NOT EXISTS "media_legacy_video_recheck_idx"
  ON "media" ("duration_last_checked_at")
  WHERE "media_type" = 'video'
    AND "duration_seconds" IS NULL
    AND "duration_unverifiable_reason" IS NULL;
