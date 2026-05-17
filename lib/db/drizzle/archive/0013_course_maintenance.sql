-- Task #108: Course Maintenance & Greenkeeper Logs

DO $$ BEGIN
  CREATE TYPE "course_area" AS ENUM (
    'hole_1', 'hole_2', 'hole_3', 'hole_4', 'hole_5', 'hole_6',
    'hole_7', 'hole_8', 'hole_9', 'hole_10', 'hole_11', 'hole_12',
    'hole_13', 'hole_14', 'hole_15', 'hole_16', 'hole_17', 'hole_18',
    'driving_range', 'practice_green', 'clubhouse_surrounds', 'car_park', 'general'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "condition_rating" AS ENUM ('excellent', 'good', 'fair', 'poor', 'closed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "maintenance_task_status" AS ENUM ('pending', 'in_progress', 'completed', 'overdue', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "maintenance_task_priority" AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "equipment_type" AS ENUM (
    'mower_fairway', 'mower_green', 'mower_rough', 'mower_tee',
    'irrigation_pump', 'irrigation_controller', 'aerator', 'scarifier',
    'topdresser', 'sprayer', 'tractor', 'utility_vehicle', 'other'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "course_notice_type" AS ENUM (
    'closure', 'gur', 'preferred_lies', 'temporary_green', 'hazard', 'general'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "course_condition_reports" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "reported_by_id" integer NOT NULL REFERENCES "app_users"("id"),
  "area" "course_area" NOT NULL,
  "green_speed" numeric(4, 1),
  "fairway_condition" "condition_rating",
  "green_condition" "condition_rating",
  "tee_condition" "condition_rating",
  "rough_condition" "condition_rating",
  "bunker_condition" "condition_rating",
  "notes" text,
  "photo_urls" jsonb DEFAULT '[]',
  "report_date" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "cond_reports_org_idx" ON "course_condition_reports" ("organization_id");
CREATE INDEX IF NOT EXISTS "cond_reports_date_idx" ON "course_condition_reports" ("organization_id", "report_date");
CREATE INDEX IF NOT EXISTS "cond_reports_area_idx" ON "course_condition_reports" ("organization_id", "area");

CREATE TABLE IF NOT EXISTS "maintenance_tasks" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "created_by_id" integer NOT NULL REFERENCES "app_users"("id"),
  "assigned_to_id" integer REFERENCES "app_users"("id"),
  "title" text NOT NULL,
  "description" text,
  "area" "course_area",
  "priority" "maintenance_task_priority" NOT NULL DEFAULT 'medium',
  "status" "maintenance_task_status" NOT NULL DEFAULT 'pending',
  "due_date" timestamptz,
  "completed_at" timestamptz,
  "completion_notes" text,
  "photo_urls" jsonb DEFAULT '[]',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "maint_tasks_org_idx" ON "maintenance_tasks" ("organization_id");
CREATE INDEX IF NOT EXISTS "maint_tasks_status_idx" ON "maintenance_tasks" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "maint_tasks_assigned_idx" ON "maintenance_tasks" ("assigned_to_id");
CREATE INDEX IF NOT EXISTS "maint_tasks_due_idx" ON "maintenance_tasks" ("due_date");

CREATE TABLE IF NOT EXISTS "equipment_records" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "equipment_type" "equipment_type" NOT NULL,
  "serial_number" text,
  "make" text,
  "model" text,
  "purchase_date" timestamptz,
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "equipment_org_idx" ON "equipment_records" ("organization_id");

CREATE TABLE IF NOT EXISTS "equipment_service_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "equipment_id" integer NOT NULL REFERENCES "equipment_records"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "logged_by_id" integer NOT NULL REFERENCES "app_users"("id"),
  "service_type" text NOT NULL,
  "description" text,
  "hours_at_service" numeric(8, 1),
  "next_service_hours" numeric(8, 1),
  "next_service_date" timestamptz,
  "cost" numeric(10, 2),
  "photo_urls" jsonb DEFAULT '[]',
  "service_date" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "equip_service_log_equip_idx" ON "equipment_service_logs" ("equipment_id");
CREATE INDEX IF NOT EXISTS "equip_service_log_org_idx" ON "equipment_service_logs" ("organization_id");
CREATE INDEX IF NOT EXISTS "equip_service_log_date_idx" ON "equipment_service_logs" ("service_date");

CREATE TABLE IF NOT EXISTS "course_notices" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "created_by_id" integer NOT NULL REFERENCES "app_users"("id"),
  "title" text NOT NULL,
  "body" text NOT NULL,
  "notice_type" "course_notice_type" NOT NULL DEFAULT 'general',
  "area" "course_area",
  "is_published" boolean NOT NULL DEFAULT false,
  "is_pinned" boolean NOT NULL DEFAULT false,
  "expires_at" timestamptz,
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "course_notices_org_idx" ON "course_notices" ("organization_id");
CREATE INDEX IF NOT EXISTS "course_notices_published_idx" ON "course_notices" ("organization_id", "is_published");
