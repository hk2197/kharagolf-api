-- Task #1290 — daily/weekly digest of stuck side-game receipt deliveries.
-- Mirrors the wallet auto-refund digest tables (Task #1073). Org admins
-- configure a per-org schedule + recipient list and the cron emails the
-- elapsed-period CSV of stuck receipts (exhausted retries OR permanently
-- skipped) so support can follow up without anyone remembering to log in.

CREATE TABLE IF NOT EXISTS "side_game_receipt_digest_schedules" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL,
  "frequency" text NOT NULL,
  "recipients" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "last_sent_at" timestamp with time zone,
  "next_run_at" timestamp with time zone NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "side_game_receipt_digest_schedules"
    ADD CONSTRAINT "side_game_receipt_digest_schedules_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "side_game_receipt_digest_schedules"
    ADD CONSTRAINT "side_game_receipt_digest_schedules_created_by_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "app_users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "side_game_receipt_digest_schedules_unique"
  ON "side_game_receipt_digest_schedules" ("organization_id");

CREATE INDEX IF NOT EXISTS "side_game_receipt_digest_schedules_next_run_idx"
  ON "side_game_receipt_digest_schedules" ("next_run_at") WHERE "enabled" = true;

CREATE TABLE IF NOT EXISTS "side_game_receipt_digest_runs" (
  "id" serial PRIMARY KEY,
  "schedule_id" integer NOT NULL,
  "organization_id" integer NOT NULL,
  "sent_at" timestamp with time zone NOT NULL DEFAULT now(),
  "period_start" timestamp with time zone,
  "period_end" timestamp with time zone NOT NULL,
  "recipients" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "row_count" integer NOT NULL DEFAULT 0,
  "exhausted_count" integer NOT NULL DEFAULT 0,
  "skipped_count" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL,
  "error_message" text
);

DO $$ BEGIN
  ALTER TABLE "side_game_receipt_digest_runs"
    ADD CONSTRAINT "side_game_receipt_digest_runs_schedule_fk"
    FOREIGN KEY ("schedule_id") REFERENCES "side_game_receipt_digest_schedules"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "side_game_receipt_digest_runs"
    ADD CONSTRAINT "side_game_receipt_digest_runs_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "side_game_receipt_digest_runs_schedule_idx"
  ON "side_game_receipt_digest_runs" ("schedule_id", "sent_at");
