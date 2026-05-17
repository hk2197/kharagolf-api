-- Task #1259 — Bound the profile-share event table by rolling old rows up
-- into a per-day aggregate. The raw `profile_share_events` table receives
-- one row per share click (Task #625) and has no natural pruning point.
-- A scheduled job in the API server (`pruneAndRollupProfileShareEvents`)
-- summarises events older than the rollup window into one row per
-- (user_id, method, day) here, then deletes the raw events. Read paths
-- (public share-stats, portal share-stats, admin profile-share leaderboard)
-- UNION raw events with these aggregates so totals stay correct after
-- rollup. Mirrors the badge-share rollup table added in Task #1096.

CREATE TABLE IF NOT EXISTS "profile_share_daily_aggregates" (
  "user_id" integer                  NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "method"  "profile_share_method"   NOT NULL,
  "day"     timestamp with time zone NOT NULL,
  "count"   integer                  NOT NULL DEFAULT 0,
  CONSTRAINT "profile_share_daily_aggregates_user_id_method_day_pk"
    PRIMARY KEY ("user_id", "method", "day")
);

CREATE INDEX IF NOT EXISTS "profile_share_daily_aggregates_user_idx"
  ON "profile_share_daily_aggregates" ("user_id");

CREATE INDEX IF NOT EXISTS "profile_share_daily_aggregates_day_idx"
  ON "profile_share_daily_aggregates" ("day");
