-- Task #1546 — audit log for ops alert tunable changes.
--
-- The singleton `ops_alert_settings` row (Task #1305) only keeps the
-- *latest* override values + last-editor metadata. If the alert
-- thresholds get tweaked repeatedly during a noisy provider incident,
-- there's no way to reconstruct the timeline. This table appends one
-- row per PATCH so ops can answer "who widened the threshold to 50,
-- when, and what was it before?" during a postmortem.

CREATE TABLE IF NOT EXISTS "ops_alert_settings_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "changed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "changed_by_user_id" integer,
  "prev_threshold" integer,
  "new_threshold" integer,
  "prev_window_hours" integer,
  "new_window_hours" integer,
  CONSTRAINT "ops_alert_settings_history_changed_by_user_id_app_users_id_fk"
    FOREIGN KEY ("changed_by_user_id") REFERENCES "app_users" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "ops_alert_settings_history_changed_at_idx"
  ON "ops_alert_settings_history" ("changed_at");
