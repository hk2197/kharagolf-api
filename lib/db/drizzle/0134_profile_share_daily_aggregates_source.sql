-- Task #1781 — Preserve the web-vs-mobile share split after old events
-- get archived. Task #1458 added a `bySource` breakdown to the portal
-- share-stats endpoint, but the per-day rollup that prunes
-- `profile_share_events` after ~30 days only stored
-- `(user_id, method, day, count)` — the `source` column was dropped, so
-- the `bySource` totals shown on the privacy page only reflected events
-- still in the raw table and steadily under-counted for owners with
-- older history.
--
-- This migration adds `source` to `profile_share_daily_aggregates` and
-- promotes it into the primary key so future rollups can keep the
-- breakdown intact. The column is `NOT NULL` because primary key
-- columns cannot be null; legacy rollup rows (which had no source) get
-- backfilled with the sentinel `'unknown'`. Read paths that surface
-- `bySource` continue to exclude `'unknown'` (and NULL on the raw
-- table) so the chips only reflect events that were actually tagged.
--
-- Wrapped in IF NOT EXISTS / DO blocks so reruns and fresh DB
-- bootstraps both succeed.

ALTER TABLE "profile_share_daily_aggregates"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profile_share_daily_aggregates_user_id_method_day_pk'
      AND conrelid = 'public.profile_share_daily_aggregates'::regclass
  ) THEN
    ALTER TABLE "profile_share_daily_aggregates"
      DROP CONSTRAINT "profile_share_daily_aggregates_user_id_method_day_pk";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profile_share_daily_aggregates_user_id_method_day_source_pk'
      AND conrelid = 'public.profile_share_daily_aggregates'::regclass
  ) THEN
    ALTER TABLE "profile_share_daily_aggregates"
      ADD CONSTRAINT "profile_share_daily_aggregates_user_id_method_day_source_pk"
      PRIMARY KEY ("user_id", "method", "day", "source");
  END IF;
END $$;
