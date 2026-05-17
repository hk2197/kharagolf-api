-- Recovery & wellness integrations: Whoop / Garmin / Apple Health / Google Fit.
-- Daily aggregated metrics + per-user consent rows for sharing wellness data.

CREATE TABLE IF NOT EXISTS "wellness_daily_metrics" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "metric_date" text NOT NULL,
  "source" text NOT NULL,
  "readiness_score" integer,
  "sleep_minutes" integer,
  "sleep_score" integer,
  "hrv_ms" numeric(5,1),
  "resting_hr" integer,
  "steps" integer,
  "active_calories" integer,
  "strain_score" numeric(4,1),
  "raw" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "wellness_daily_user_date_source_unique"
  ON "wellness_daily_metrics" ("user_id", "metric_date", "source");
CREATE INDEX IF NOT EXISTS "wellness_daily_user_idx"
  ON "wellness_daily_metrics" ("user_id", "metric_date");

CREATE TABLE IF NOT EXISTS "wellness_consents" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "granted" boolean NOT NULL DEFAULT false,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  "source" text,
  "ip_address" text
);

CREATE UNIQUE INDEX IF NOT EXISTS "wellness_consent_user_scope_unique"
  ON "wellness_consents" ("user_id", "scope");
CREATE INDEX IF NOT EXISTS "wellness_consent_user_idx"
  ON "wellness_consents" ("user_id");
