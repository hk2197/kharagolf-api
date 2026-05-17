-- Task #1305 — admin-tunable thresholds for the retry-exhaustion ops
-- alert (artifacts/api-server/src/lib/notifyExhaustionOpsAlert.ts).
--
-- Singleton row (`id` = 1) so ops can edit threshold + lookback window
-- from the super-admin UI and the cron picks up the change on its next
-- run without a redeploy. Both tunables are nullable: NULL means "fall
-- back to the env var (or hardcoded default) at read time", which
-- preserves the historical behaviour for environments that haven't
-- customised anything yet.

CREATE TABLE IF NOT EXISTS "ops_alert_settings" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "notify_exhaustion_threshold" integer,
  "notify_exhaustion_window_hours" integer,
  "updated_by_user_id" integer,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ops_alert_settings_singleton_chk"
    CHECK ("id" = 1),
  CONSTRAINT "ops_alert_settings_threshold_positive_chk"
    CHECK ("notify_exhaustion_threshold" IS NULL OR "notify_exhaustion_threshold" > 0),
  CONSTRAINT "ops_alert_settings_window_positive_chk"
    CHECK ("notify_exhaustion_window_hours" IS NULL OR "notify_exhaustion_window_hours" > 0),
  CONSTRAINT "ops_alert_settings_updated_by_user_id_app_users_id_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "app_users" ("id") ON DELETE SET NULL
);

-- Seed the singleton row with NULL tunables. The helper that reads it
-- (artifacts/api-server/src/lib/opsAlertSettings.ts) falls back to the
-- env var / hardcoded default when a column is NULL, so behaviour is
-- unchanged for environments that haven't customised anything.
INSERT INTO "ops_alert_settings" ("id", "notify_exhaustion_threshold", "notify_exhaustion_window_hours")
VALUES (1, NULL, NULL)
ON CONFLICT ("id") DO NOTHING;
