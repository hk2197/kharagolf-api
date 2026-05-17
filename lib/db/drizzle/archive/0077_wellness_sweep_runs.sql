-- Migration 0077 — wellness_sweep_runs (Task #849)
--
-- Persist the result of each hourly wellness-sweep job so the admin dashboard
-- tile renders immediately after a server restart (instead of going blank for
-- up to ~60 min until the next sweep ticks) and so we can render a short
-- trend chart of attempted / succeeded / needs_reauth counts.
--
-- See `sweepWellnessConnections` and `getLastWellnessSweepResult` in
-- artifacts/api-server/src/lib/wearables.ts. Rows older than 90 days are
-- pruned by the sweep itself.

BEGIN;

CREATE TABLE IF NOT EXISTS "wellness_sweep_runs" (
  "id"           serial PRIMARY KEY NOT NULL,
  "ran_at"       timestamp with time zone DEFAULT now() NOT NULL,
  "attempted"    integer NOT NULL,
  "succeeded"    integer NOT NULL,
  "needs_reauth" integer NOT NULL,
  "alerted"      boolean DEFAULT false NOT NULL
);

CREATE INDEX IF NOT EXISTS "wellness_sweep_runs_ran_at_idx"
  ON "wellness_sweep_runs" USING btree ("ran_at");

COMMIT;
