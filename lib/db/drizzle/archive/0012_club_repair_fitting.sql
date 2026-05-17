-- TASK #99: Club Repair & Fitting Tracker
-- Creates repair_jobs and fitting_sessions tables

DO $$ BEGIN
  CREATE TYPE "public"."repair_job_status" AS ENUM('received', 'in_progress', 'ready_for_pickup', 'collected');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."repair_job_type" AS ENUM('regrip', 'reshaft', 'loft_lie_adjustment', 'cleaning', 'other');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fitting_session_status" AS ENUM('booked', 'completed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "repair_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "member_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "member_name" text NOT NULL,
  "member_email" text,
  "job_type" "repair_job_type" NOT NULL DEFAULT 'other',
  "description" text NOT NULL,
  "status" "repair_job_status" NOT NULL DEFAULT 'received',
  "technician_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "technician_name" text,
  "expected_completion_date" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "notification_sent_at" timestamp with time zone,
  "notes" text,
  "created_by" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "repair_jobs_org_idx" ON "repair_jobs" ("organization_id");
CREATE INDEX IF NOT EXISTS "repair_jobs_member_idx" ON "repair_jobs" ("member_id");
CREATE INDEX IF NOT EXISTS "repair_jobs_technician_idx" ON "repair_jobs" ("technician_id");
CREATE INDEX IF NOT EXISTS "repair_jobs_status_idx" ON "repair_jobs" ("status");

CREATE TABLE IF NOT EXISTS "fitting_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "member_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "member_name" text NOT NULL,
  "member_email" text,
  "scheduled_at" timestamp with time zone NOT NULL,
  "status" "fitting_session_status" NOT NULL DEFAULT 'booked',
  "technician_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "technician_name" text,
  "recommended_specs" jsonb DEFAULT '{}',
  "notes" text,
  "created_by" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "fitting_sessions_org_idx" ON "fitting_sessions" ("organization_id");
CREATE INDEX IF NOT EXISTS "fitting_sessions_member_idx" ON "fitting_sessions" ("member_id");
CREATE INDEX IF NOT EXISTS "fitting_sessions_status_idx" ON "fitting_sessions" ("status");
