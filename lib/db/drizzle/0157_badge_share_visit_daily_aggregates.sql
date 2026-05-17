-- Task #2255 — Bound the `badge_share_visit_events` table by rolling
-- old rows into a per-day aggregate, mirroring the
-- `badge_share_events` → `badge_share_daily_aggregates` rollup added
-- in Task #1096.
--
-- The visit-event table fires one row per public-badge page view (a
-- viral badge can pull in thousands per day) and previously had no
-- retention or rollup job, so storage grew unbounded and the
-- leaderboard JOINs got slower over time. The companion rollup job
-- (`pruneAndRollupBadgeShareVisitEvents`) summarises events older
-- than the rollup window into one row per (handle, badge_type, source,
-- day) here and then deletes the originals. The badge-share-leaderboard
-- endpoints UNION the raw events with these aggregates so totals (and
-- the conversion-rate ratio) stay correct after rollup.
--
-- `source` is part of the bucketing key so the read-side can keep
-- filtering out `source = 'crawler'` rows (link-preview renders, not
-- human visits) after rollup the same way it does on the raw table.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

CREATE TABLE IF NOT EXISTS "badge_share_visit_daily_aggregates" (
  "handle" text NOT NULL,
  "badge_type" text NOT NULL,
  "source" text NOT NULL DEFAULT 'unknown',
  "day" timestamp with time zone NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "badge_share_visit_daily_aggregates_handle_badge_type_source_day_pk"
    PRIMARY KEY ("handle", "badge_type", "source", "day")
);

CREATE INDEX IF NOT EXISTS "badge_share_visit_daily_aggregates_handle_idx"
  ON "badge_share_visit_daily_aggregates" USING btree ("handle");

CREATE INDEX IF NOT EXISTS "badge_share_visit_daily_aggregates_day_idx"
  ON "badge_share_visit_daily_aggregates" USING btree ("day");
