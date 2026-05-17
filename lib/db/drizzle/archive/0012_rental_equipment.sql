-- Task #100: Rental Equipment Management


-- post-merge-guard: fresh-DB guard (table:tee_bookings)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tee_bookings') AS post_merge_dep_present \gset
\if :post_merge_dep_present

DO $$ BEGIN
  CREATE TYPE "rental_asset_condition" AS ENUM ('excellent', 'good', 'fair', 'poor', 'damaged', 'retired');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "rental_booking_status" AS ENUM ('reserved', 'checked_out', 'returned', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "rental_categories" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "daily_rate" numeric(10, 2) NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'USD',
  "icon" text NOT NULL DEFAULT 'package',
  "is_active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "rental_categories_org_idx" ON "rental_categories" ("organization_id");

CREATE TABLE IF NOT EXISTS "rental_assets" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "category_id" integer NOT NULL REFERENCES "rental_categories"("id") ON DELETE CASCADE,
  "asset_code" text NOT NULL,
  "description" text,
  "condition" rental_asset_condition NOT NULL DEFAULT 'good',
  "daily_rate_override" numeric(10, 2),
  "notes" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "retired_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "rental_assets_org_code_unique" ON "rental_assets" ("organization_id", "asset_code");
CREATE INDEX IF NOT EXISTS "rental_assets_org_idx" ON "rental_assets" ("organization_id");
CREATE INDEX IF NOT EXISTS "rental_assets_category_idx" ON "rental_assets" ("category_id");

CREATE TABLE IF NOT EXISTS "rental_bookings" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "asset_id" integer NOT NULL REFERENCES "rental_assets"("id") ON DELETE RESTRICT,
  "tee_booking_id" integer REFERENCES "tee_bookings"("id") ON DELETE SET NULL,
  "member_id" integer REFERENCES "club_members"("id") ON DELETE SET NULL,
  "booked_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "member_name" text,
  "status" rental_booking_status NOT NULL DEFAULT 'reserved',
  "rental_date" timestamptz NOT NULL,
  "expected_return_at" timestamptz,
  "checked_out_at" timestamptz,
  "checked_out_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "returned_at" timestamptz,
  "returned_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "rate_charged" numeric(10, 2),
  "currency" text NOT NULL DEFAULT 'USD',
  "damage_reported" boolean NOT NULL DEFAULT false,
  "damage_notes" text,
  "damage_photo_urls" jsonb NOT NULL DEFAULT '[]',
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "rental_bookings_org_idx" ON "rental_bookings" ("organization_id");
CREATE INDEX IF NOT EXISTS "rental_bookings_asset_idx" ON "rental_bookings" ("asset_id");
CREATE INDEX IF NOT EXISTS "rental_bookings_tee_booking_idx" ON "rental_bookings" ("tee_booking_id");
CREATE INDEX IF NOT EXISTS "rental_bookings_member_idx" ON "rental_bookings" ("member_id");

-- Prevent double-allocation: one active booking per asset at a time
CREATE UNIQUE INDEX IF NOT EXISTS "rental_bookings_asset_active_unique"
  ON "rental_bookings" ("asset_id")
  WHERE status IN ('reserved', 'checked_out');

\else
\echo 'parent table tee_bookings not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

