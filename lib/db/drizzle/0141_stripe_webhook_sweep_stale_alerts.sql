-- Task #1883 — Append-only audit log of every "the daily Stripe webhook
-- sweep has been silent for too long" notification email the watchdog
-- (`runStripeWebhookSweepStaleOpsAlertJob`) actually sent out.
--
-- Two concerns rolled into one table:
--
--   1. Cross-restart, cross-replica debounce. The watchdog gates on the
--      most recent `paged_at` in this table, so a sustained outage paged
--      at 09:00 does not page again at 10:00, 11:00, ... — even across a
--      deploy that lands inside the cooldown window or across multiple
--      cron processes racing. Mirrors the singleton-cooldown pattern in
--      `badge_share_rollup_ops_alerts` (Task #1814) but appends per page
--      so we also get history.
--
--   2. Operator visibility. The admin Stripe webhook audit page (and
--      future digest tooling) needs to render a "Last alert: 2h ago —
--      paged 3 admins" line so admins can confirm the watchdog actually
--      fired and to whom, without grepping inboxes or server logs.
--
-- One row is inserted only when the watchdog actually sent at least one
-- email (i.e. the cooldown gate passed AND ≥1 recipient was reached).
-- Skipped runs (`not_stale`, `in_cooldown`, `no_recipients`,
-- `send_failed`) leave no row, so the banner only ever shows real pages.
--
-- Retention is bounded by the same daily prune that already keeps
-- `stripe_webhook_sweep_runs` to ~90 days (see `cron.ts`), so the table
-- stays small even on long-running deployments.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

CREATE TABLE IF NOT EXISTS "stripe_webhook_sweep_stale_alerts" (
  "id" serial PRIMARY KEY NOT NULL,
  "paged_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_sweep_ran_at" timestamp with time zone,
  "stale_threshold_ms" integer NOT NULL,
  "recipient_count" integer NOT NULL DEFAULT 0,
  "recipient_emails" text[] NOT NULL DEFAULT ARRAY[]::text[]
);

CREATE INDEX IF NOT EXISTS "stripe_webhook_sweep_stale_alerts_paged_at_idx"
  ON "stripe_webhook_sweep_stale_alerts" USING btree ("paged_at");
