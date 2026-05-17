-- Task #1474 — Persist last-run state for the daily profile_share rollup
-- (Task #1259) so a super-admin "storage savings" panel can show the
-- most recent run's summary plus current row counts even after the API
-- server restarts (the cron previously only emitted a log line). Mirrors
-- `badge_share_rollup_runs` (Task #1260) so the same panel can render
-- both rollups side by side.
--
-- Singleton row keyed on `id = 1`; the rollup UPSERTs onto that PK at
-- the end of every successful run.
CREATE TABLE IF NOT EXISTS "profile_share_rollup_runs" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "ran_at" timestamp with time zone NOT NULL DEFAULT now(),
  "rolled_up_events" integer NOT NULL DEFAULT 0,
  "upserted_aggregate_rows" integer NOT NULL DEFAULT 0,
  "pruned_aggregate_rows" integer NOT NULL DEFAULT 0
);
