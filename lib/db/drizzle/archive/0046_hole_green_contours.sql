-- Task #358 — Per-hole green contour grids for the mobile 3D green renderer.
-- Stores a row-major grid of elevation samples around the green centre,
-- plus the grid origin (lat/lng), dimensions, and cell size in metres.
-- This table was originally created directly via psql; this migration
-- backfills the schema for other environments.

CREATE TABLE IF NOT EXISTS "hole_green_contours" (
  "id" serial PRIMARY KEY NOT NULL,
  "course_id" integer NOT NULL,
  "hole_number" integer NOT NULL,
  "origin_lat" numeric(10, 7) NOT NULL,
  "origin_lng" numeric(10, 7) NOT NULL,
  "rows" integer NOT NULL,
  "cols" integer NOT NULL,
  "cell_meters" numeric(6, 3) DEFAULT '1.5' NOT NULL,
  "elevations" jsonb NOT NULL,
  "source" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "hole_green_contours"
    ADD CONSTRAINT "hole_green_contours_course_id_courses_id_fk"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "hole_green_contours_unique"
  ON "hole_green_contours" ("course_id", "hole_number");
