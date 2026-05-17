-- Task #845 — Durable storage for AI Caddie prompt-size metrics.
--
-- The previous tracking (Task #687) used a per-process ring buffer of the
-- last 1,000 measurements, which lost all data on every API restart and
-- gave each replica its own isolated slice. One row per /portal/caddie/ask
-- call lets the super-admin endpoint serve true rolling aggregates and
-- powers longer-term trend analysis. A daily cron sweeps rows >90 days.
CREATE TABLE IF NOT EXISTS "caddie_prompt_metrics" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "context_mode" text NOT NULL,
  "estimated_input_tokens" integer NOT NULL,
  "total_tracked_shots" integer NOT NULL,
  "round_count" integer NOT NULL,
  "shot_line_count" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "caddie_prompt_metrics_created_at_idx"
  ON "caddie_prompt_metrics" ("created_at");
