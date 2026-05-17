-- Task #2056 — Audit log of super-admin "Send test page" clicks for the
-- watch GPS spike alert wiring.
--
-- Background. Task #1653 added the dashboard button that fires a
-- clearly-labelled test page through the same Slack / PagerDuty
-- senders the real watch GPS spike alert uses, so a typo in the env
-- vars surfaces NOW instead of silently swallowing a real spike. The
-- only record of who fired it was a single info log line, so during
-- incident reviews leadership couldn't prove the wiring had been
-- exercised recently.
--
-- This table captures one row per POST
-- /super-admin/watch-position-metrics/test-ops-alert-chat. Per-channel
-- `attempted` / `ok` / `error` columns mirror the response body the
-- toast already shows, so the dashboard can render
-- "Last test page: 3h ago by Asha (Slack ✓ · PagerDuty ✗)" plus a
-- 30-day frequency chart without joining `app_users`.
--
-- `actor_user_id` is intentionally left without a FK to `app_users` —
-- a deleted super-admin user must NOT wipe historical audit rows that
-- prove paging was tested. `actor_name` is cached at insert time so
-- the row survives a later displayName change. Both are nullable so
-- the best-effort audit insert in `recordWatchGpsOpsAlertTestPage`
-- never blocks the wiring-test outcome from reaching the operator.
--
-- IF NOT EXISTS guards on the table + index so a partial replay
-- during a deploy retry is safe, and so dev DBs that already had the
-- table created out-of-band (via `executeSql`) accept the migration
-- cleanly.

CREATE TABLE IF NOT EXISTS "watch_gps_ops_alert_test_pages" (
  "id" serial PRIMARY KEY NOT NULL,
  "actor_user_id" integer,
  "actor_name" text,
  "slack_attempted" boolean DEFAULT false NOT NULL,
  "slack_ok" boolean DEFAULT false NOT NULL,
  "slack_error" text,
  "pager_duty_attempted" boolean DEFAULT false NOT NULL,
  "pager_duty_ok" boolean DEFAULT false NOT NULL,
  "pager_duty_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- History/series queries (`getWatchGpsOpsAlertTestPageHistory`) walk
-- by created_at: a single index on the timestamp covers both the
-- "most recent row" lookup and the 30-day window scan.
CREATE INDEX IF NOT EXISTS "watch_gps_ops_alert_test_pages_created_at_idx"
  ON "watch_gps_ops_alert_test_pages" ("created_at");
