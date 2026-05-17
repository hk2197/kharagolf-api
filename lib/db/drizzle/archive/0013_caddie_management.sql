-- Task #106: Caddie Management & Booking


-- post-merge-guard: fresh-DB guard (table:tee_bookings)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tee_bookings') AS post_merge_dep_present \gset
\if :post_merge_dep_present

DO $$ BEGIN
  CREATE TYPE "caddie_experience_level" AS ENUM ('trainee', 'junior', 'standard', 'senior', 'master');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "caddie_assignment_status" AS ENUM ('requested', 'assigned', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "caddie_profiles" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "photo_url" text,
  "experience_level" caddie_experience_level NOT NULL DEFAULT 'standard',
  "years_experience" integer NOT NULL DEFAULT 0,
  "languages" jsonb NOT NULL DEFAULT '[]',
  "bio" text,
  "phone" text,
  "email" text,
  "fee_per_round" numeric(10, 2) NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'INR',
  "is_active" boolean NOT NULL DEFAULT true,
  "average_rating" numeric(3, 2),
  "total_ratings" integer NOT NULL DEFAULT 0,
  "total_rounds" integer NOT NULL DEFAULT 0,
  "total_earnings" numeric(12, 2) NOT NULL DEFAULT 0,
  "notes" text,
  "created_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "caddie_profiles_org_idx" ON "caddie_profiles" ("organization_id");
CREATE INDEX IF NOT EXISTS "caddie_profiles_user_idx" ON "caddie_profiles" ("user_id");

CREATE TABLE IF NOT EXISTS "caddie_availability" (
  "id" serial PRIMARY KEY NOT NULL,
  "caddie_id" integer NOT NULL REFERENCES "caddie_profiles"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "date" text NOT NULL,
  "is_available" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "caddie_availability_caddie_date_unique" ON "caddie_availability" ("caddie_id", "date");
CREATE INDEX IF NOT EXISTS "caddie_availability_org_date_idx" ON "caddie_availability" ("organization_id", "date");

CREATE TABLE IF NOT EXISTS "caddie_assignments" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "tee_booking_id" integer NOT NULL REFERENCES "tee_bookings"("id") ON DELETE CASCADE,
  "caddie_id" integer NOT NULL REFERENCES "caddie_profiles"("id") ON DELETE RESTRICT,
  "member_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "status" caddie_assignment_status NOT NULL DEFAULT 'assigned',
  "fee_charged" numeric(10, 2),
  "currency" text NOT NULL DEFAULT 'INR',
  "fee_added_to_booking" boolean NOT NULL DEFAULT false,
  "tip_amount" numeric(10, 2),
  "tip_recorded_at" timestamptz,
  "notes" text,
  "assigned_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "completed_at" timestamptz,
  "cancelled_at" timestamptz,
  "cancellation_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "caddie_assignments_org_idx" ON "caddie_assignments" ("organization_id");
CREATE INDEX IF NOT EXISTS "caddie_assignments_booking_idx" ON "caddie_assignments" ("tee_booking_id");
CREATE INDEX IF NOT EXISTS "caddie_assignments_caddie_idx" ON "caddie_assignments" ("caddie_id");
CREATE UNIQUE INDEX IF NOT EXISTS "caddie_assignments_booking_caddie_unique" ON "caddie_assignments" ("tee_booking_id", "caddie_id");

CREATE TABLE IF NOT EXISTS "caddie_ratings" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "assignment_id" integer NOT NULL REFERENCES "caddie_assignments"("id") ON DELETE CASCADE,
  "caddie_id" integer NOT NULL REFERENCES "caddie_profiles"("id") ON DELETE CASCADE,
  "rated_by_user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "rating" integer NOT NULL,
  "comment" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "caddie_ratings_assignment_user_unique" ON "caddie_ratings" ("assignment_id", "rated_by_user_id");
CREATE INDEX IF NOT EXISTS "caddie_ratings_caddie_idx" ON "caddie_ratings" ("caddie_id");

\else
\echo 'parent table tee_bookings not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

