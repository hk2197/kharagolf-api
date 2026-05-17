-- Task #1821 — Append-only per-run history for the badge_share rollup
-- so the super-admin storage-savings panel can render a 7-day trend
-- sparkline of the savings percent / compression ratio.
--
-- The existing `badge_share_rollup_runs` table is a singleton (one row,
-- UPSERTed on every run) and therefore has no history to chart from.
-- This new table captures one append-only row per successful run with
-- the savings KPIs the panel displays. Retention is bounded to >= 30
-- days by `MAX_RUN_HISTORY_AGE_MS` in `badgeShareRollup.ts`, well above
-- the 7-day default sparkline window, so the table stays small even if
-- the cron's daily cadence ever increases.
--
-- `savings_percent` / `savings_ratio` are nullable for the same reason
-- they are nullable on `BadgeShareRollupAdminSummary.storageSavings`:
-- the rollup may run without yet collapsing any events (no aggregates),
-- in which case the panel renders the point as "no data" instead of a
-- misleading zero.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

CREATE TABLE IF NOT EXISTS "badge_share_rollup_run_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "ran_at" timestamp with time zone NOT NULL DEFAULT now(),
  "current_raw_event_count" integer NOT NULL DEFAULT 0,
  "current_aggregate_row_count" integer NOT NULL DEFAULT 0,
  "aggregated_event_count" integer NOT NULL DEFAULT 0,
  "savings_percent" numeric(6, 3),
  "savings_ratio" numeric(12, 3)
);

CREATE INDEX IF NOT EXISTS "badge_share_rollup_run_history_ran_at_idx"
  ON "badge_share_rollup_run_history" USING btree ("ran_at");
