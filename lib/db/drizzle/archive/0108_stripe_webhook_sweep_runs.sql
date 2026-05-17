-- Migration 0108 — stripe_webhook_sweep_runs (Task #1294)
--
-- Persist the result of each daily `stripe_webhook_deliveries` retention
-- sweep (Task #1125) so the admin Stripe webhook audit page can show the
-- timestamp of the last successful prune and the number of rows it removed,
-- without admins having to grep server logs.
--
-- See `sweepOldStripeWebhookDeliveries` and `getLastStripeWebhookSweepResult`
-- in artifacts/api-server/src/lib/cron.ts. Rows older than 90 days are
-- pruned by the sweep itself to keep the table bounded.

BEGIN;

CREATE TABLE IF NOT EXISTS "stripe_webhook_sweep_runs" (
  "id"      serial PRIMARY KEY NOT NULL,
  "ran_at"  timestamp with time zone DEFAULT now() NOT NULL,
  "removed" integer NOT NULL
);

CREATE INDEX IF NOT EXISTS "stripe_webhook_sweep_runs_ran_at_idx"
  ON "stripe_webhook_sweep_runs" USING btree ("ran_at");

COMMIT;
