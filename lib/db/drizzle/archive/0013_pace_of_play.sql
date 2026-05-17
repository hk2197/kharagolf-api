-- Task #107: Pace of Play Monitoring
-- Creates tables for tracking group positions, pace status, alerts, and marshal checkpoints.

CREATE TABLE IF NOT EXISTS "hole_par_times" (
  "id" serial PRIMARY KEY NOT NULL,
  "course_id" integer NOT NULL REFERENCES "courses"("id") ON DELETE CASCADE,
  "hole_number" integer NOT NULL,
  "par_minutes" integer NOT NULL DEFAULT 14,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "hole_par_time_unique" UNIQUE ("course_id", "hole_number")
);
CREATE INDEX IF NOT EXISTS "hole_par_times_course_idx" ON "hole_par_times"("course_id");

CREATE TABLE IF NOT EXISTS "pace_alert_settings" (
  "id" serial PRIMARY KEY NOT NULL,
  "tournament_id" integer NOT NULL UNIQUE REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "warning_threshold_minutes" integer NOT NULL DEFAULT 10,
  "critical_threshold_minutes" integer NOT NULL DEFAULT 20,
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "group_checkpoints" (
  "id" serial PRIMARY KEY NOT NULL,
  "tournament_id" integer NOT NULL REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "tee_time_id" integer NOT NULL REFERENCES "tee_times"("id") ON DELETE CASCADE,
  "round" integer NOT NULL DEFAULT 1,
  "hole_number" integer NOT NULL,
  "source" text NOT NULL DEFAULT 'marshal',
  "recorded_by_user_id" integer REFERENCES "app_users"("id"),
  "latitude" text,
  "longitude" text,
  "notes" text,
  "checked_in_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "group_checkpoints_tournament_idx" ON "group_checkpoints"("tournament_id");
CREATE INDEX IF NOT EXISTS "group_checkpoints_tee_time_idx" ON "group_checkpoints"("tee_time_id");
CREATE INDEX IF NOT EXISTS "group_checkpoints_round_hole_idx" ON "group_checkpoints"("round", "hole_number");

CREATE TABLE IF NOT EXISTS "group_pace_records" (
  "id" serial PRIMARY KEY NOT NULL,
  "tournament_id" integer NOT NULL REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "tee_time_id" integer NOT NULL REFERENCES "tee_times"("id") ON DELETE CASCADE,
  "round" integer NOT NULL DEFAULT 1,
  "current_hole" integer NOT NULL DEFAULT 0,
  "actual_elapsed_minutes" integer NOT NULL DEFAULT 0,
  "target_elapsed_minutes" integer NOT NULL DEFAULT 0,
  "deviation_minutes" integer NOT NULL DEFAULT 0,
  "pace_status" text NOT NULL DEFAULT 'on_pace',
  "last_hole_completed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "group_pace_record_unique" UNIQUE ("tee_time_id", "round")
);
CREATE INDEX IF NOT EXISTS "group_pace_records_tournament_idx" ON "group_pace_records"("tournament_id");

CREATE TABLE IF NOT EXISTS "pace_alerts" (
  "id" serial PRIMARY KEY NOT NULL,
  "tournament_id" integer NOT NULL REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "tee_time_id" integer NOT NULL REFERENCES "tee_times"("id") ON DELETE CASCADE,
  "round" integer NOT NULL DEFAULT 1,
  "alert_type" text NOT NULL DEFAULT 'warning',
  "deviation_minutes" integer NOT NULL,
  "current_hole" integer NOT NULL,
  "acknowledged_at" timestamptz,
  "acknowledged_by_user_id" integer REFERENCES "app_users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "pace_alerts_tournament_idx" ON "pace_alerts"("tournament_id");
CREATE INDEX IF NOT EXISTS "pace_alerts_tee_time_idx" ON "pace_alerts"("tee_time_id");
