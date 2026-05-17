-- Task #1910 — DB-backed override for the retry-exhaustion ops alert
-- recipient list. Mirrors the threshold-tunable pattern (Task #1305) so
-- super admins can edit the recipient list from the dashboard and have
-- the cron pick the change up on its next run, without a redeploy.
--
-- Two columns added on the singleton settings row:
--
--   * `notify_exhaustion_recipients` — text[] override (NULL means
--     "inherit from OPS_ALERT_EMAILS env var"). An explicitly empty
--     array is also treated as "inherit" by the resolver: the task
--     spec calls for an empty save to visibly fall back to env so an
--     admin can never accidentally silence the breach email by
--     clearing the list (the env recipient list is the floor, not the
--     ceiling).
--
-- And matching prev/new audit columns on `ops_alert_settings_history`
-- so the super-admin "Recent changes" panel can show who edited the
-- recipient list and to what — same prev/new convention as the other
-- audit columns.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed; the
-- DEFAULT clauses on the audit columns are deliberately omitted (they
-- are nullable + always written explicitly by the upsert helper).

ALTER TABLE "ops_alert_settings"
  ADD COLUMN IF NOT EXISTS "notify_exhaustion_recipients" text[];

ALTER TABLE "ops_alert_settings_history"
  ADD COLUMN IF NOT EXISTS "prev_notify_exhaustion_recipients" text[];

ALTER TABLE "ops_alert_settings_history"
  ADD COLUMN IF NOT EXISTS "new_notify_exhaustion_recipients" text[];
