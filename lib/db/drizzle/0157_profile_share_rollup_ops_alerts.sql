-- Task #2261 — Append-only audit log of every "the daily profile-share
-- rollup has been silent for too long" notification email the
-- auto-pager (`runProfileShareRollupStaleOpsAlertJob`, Task #1813)
-- actually sent out.
--
-- Two concerns rolled into one table:
--
--   1. Cross-restart, cross-replica debounce. The auto-pager gates on
--      the most recent `paged_at` in this table, so a sustained outage
--      paged at 09:00 does not page again at 10:00, 11:00, ... — even
--      across a deploy that lands inside the cooldown window or across
--      multiple cron processes racing. The previous in-process
--      timestamp gate was vulnerable to rolling deploys re-paging
--      on-call; promoting the state to the DB closes that hole.
--      Mirrors the singleton-cooldown pattern in
--      `badge_share_rollup_ops_alerts` (Task #1814) but appends per
--      page so we also get history.
--
--   2. Operator visibility. The super-admin profile-share-rollup panel
--      now reads from this table to render a "Recent ops alerts" feed
--      so admins can tell at a glance: was anyone paged about this
--      outage already, and when? Mirrors the sibling badge-share
--      rollup panel work and the existing
--      `manual_entry_alert_page_history` (Task #1665) shape so the
--      same UI conventions carry across.
--
-- One row is inserted only when the auto-pager actually sent at least
-- one email (i.e. the cooldown gate passed AND ≥1 recipient was
-- reached). Skipped runs (`not_stale`, `no_raw_events`, `in_cooldown`,
-- `no_recipients`, `send_failed`) leave no row, so the panel only
-- ever shows real pages.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

CREATE TABLE IF NOT EXISTS "profile_share_rollup_ops_alerts" (
  "id" serial PRIMARY KEY NOT NULL,
  "paged_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_run_ran_at" timestamp with time zone,
  "rollup_age_ms" integer NOT NULL,
  "stale_threshold_ms" integer NOT NULL,
  "current_raw_event_count" integer NOT NULL DEFAULT 0,
  "current_aggregate_row_count" integer NOT NULL DEFAULT 0,
  "cooldown_hours" numeric(6, 2) NOT NULL,
  "recipient_count" integer NOT NULL DEFAULT 0,
  "recipient_emails" text[] NOT NULL DEFAULT ARRAY[]::text[]
);

CREATE INDEX IF NOT EXISTS "profile_share_rollup_ops_alerts_paged_at_idx"
  ON "profile_share_rollup_ops_alerts" USING btree ("paged_at");
