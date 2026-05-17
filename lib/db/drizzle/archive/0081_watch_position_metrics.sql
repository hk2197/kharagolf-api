-- Task #877 — Per-minute counter of watch GPS `position` messages so we can
-- confirm the volume drop introduced by Task #722's client-side debounce, and
-- catch a regression if a future change re-floods the channel.
CREATE TABLE IF NOT EXISTS "watch_position_metrics" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "session_id" text NOT NULL,
  "tournament_id" integer,
  "battery_mode" boolean DEFAULT false NOT NULL,
  "bucket_minute" timestamp with time zone NOT NULL,
  "position_count" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "watch_position_metrics_bucket_minute_idx"
  ON "watch_position_metrics" ("bucket_minute");

CREATE UNIQUE INDEX IF NOT EXISTS "watch_position_metrics_session_bucket_uq"
  ON "watch_position_metrics" ("session_id", "bucket_minute");
