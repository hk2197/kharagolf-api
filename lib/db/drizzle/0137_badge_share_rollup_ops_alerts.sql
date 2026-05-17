-- Task #1814 — Singleton table that persists the last time the
-- badge-share rollup auto-pager (Task #1478) actually emailed
-- super-admins + on-call.
--
-- Two motivations rolled into one migration:
--
--   1. Cross-restart cooldown. The alert job previously kept the
--      cooldown timestamp in a process-local variable; a rolling
--      restart inside the cooldown window let the next replica
--      re-page on-call. Promoting the timestamp to a singleton row
--      (PK `id = 1`, UPSERT) means the cooldown survives deploys.
--
--   2. Operator visibility. The super-admin badge-share-rollup panel
--      now reads this row to render a "Last ops alert: 2h ago" line
--      under the existing stale-cron banner so admins can confirm the
--      alert pipeline is actually firing — and correlate the loud red
--      banner with the email they (should have) received — without
--      grepping inboxes or logs.
--
-- The table is intentionally separate from `badge_share_rollup_runs`
-- (which the rollup itself UPSERTs at the end of every successful
-- run): co-locating the alert timestamp on that row would force the
-- rollup to read-then-write to preserve it, or accidentally clobber
-- it. A dedicated singleton has no such coupling.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

CREATE TABLE IF NOT EXISTS "badge_share_rollup_ops_alerts" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "last_alerted_at" timestamp with time zone NOT NULL
);
