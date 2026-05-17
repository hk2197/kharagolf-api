-- Task #1096 — Bound the badge-share event table by rolling old rows up
-- into a per-day aggregate. The raw `badge_share_events` table receives
-- one row per share click (Task #926) and has no natural pruning point.
-- A scheduled job in the API server (`pruneAndRollupBadgeShareEvents`)
-- summarises events older than the rollup window into one row per
-- (handle, badge_type, method, day) here, then deletes the raw events.
-- Read paths (portal stats + admin leaderboard) UNION raw events with
-- these aggregates so totals stay correct after rollup.


-- post-merge-guard: fresh-DB guard (type:badge_share_method)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'badge_share_method') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "badge_share_daily_aggregates" (
  "handle"      text                     NOT NULL,
  "badge_type"  text                     NOT NULL,
  "method"      "badge_share_method"     NOT NULL,
  "day"         timestamp with time zone NOT NULL,
  "count"       integer                  NOT NULL DEFAULT 0,
  CONSTRAINT "badge_share_daily_aggregates_handle_badge_type_method_day_pk"
    PRIMARY KEY ("handle", "badge_type", "method", "day")
);

CREATE INDEX IF NOT EXISTS "badge_share_daily_aggregates_handle_idx"
  ON "badge_share_daily_aggregates" ("handle");

CREATE INDEX IF NOT EXISTS "badge_share_daily_aggregates_day_idx"
  ON "badge_share_daily_aggregates" ("day");

\else
\echo 'parent type badge_share_method not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

