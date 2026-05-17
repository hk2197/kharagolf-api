-- Task #1260 — Persist last-run state for the daily badge_share rollup
-- (Task #1096) so a super-admin "storage savings" panel can show the
-- most recent run's summary plus current row counts even after the API
-- server restarts (the cron previously only emitted a log line).
--
-- Singleton row keyed on `id = 1`; the rollup UPSERTs onto that PK at
-- the end of every successful run.
CREATE TABLE IF NOT EXISTS "badge_share_rollup_runs" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "ran_at" timestamp with time zone NOT NULL DEFAULT now(),
  "rolled_up_events" integer NOT NULL DEFAULT 0,
  "upserted_aggregate_rows" integer NOT NULL DEFAULT 0,
  "pruned_aggregate_rows" integer NOT NULL DEFAULT 0
);
