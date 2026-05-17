-- Task #384 — Public course pages with photos, slope/rating & reviews.
-- Adds public-facing fields to courses, attaches media to courses (with optional hole),
-- and creates reviews + abuse report tables.

ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "slug" text;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "hero_image_url" text;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "designer" text;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "year_opened" integer;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "awards" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "contact_phone" text;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "contact_email" text;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "tee_time_cta_url" text;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "latitude" numeric(10, 7);
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "longitude" numeric(10, 7);
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT true NOT NULL;

-- Backfill slugs from name + id (id suffix guarantees uniqueness within an org)
UPDATE "courses"
SET "slug" = lower(regexp_replace(regexp_replace(coalesce("name", 'course'), '[^a-zA-Z0-9]+', '-', 'g'), '(^-+)|(-+$)', '', 'g')) || '-' || "id"
WHERE "slug" IS NULL OR "slug" = '';

ALTER TABLE "courses" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "courses_org_slug_unique" ON "courses" ("organization_id", "slug");

-- MEDIA: extend to attach photos to a course (and optionally a specific hole)
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "course_id" integer;
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "hole_number" integer;
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "is_hero" boolean DEFAULT false NOT NULL;

DO $$ BEGIN
  ALTER TABLE "media"
    ADD CONSTRAINT "media_course_id_courses_id_fk"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "media_course_idx" ON "media" ("course_id");
CREATE INDEX IF NOT EXISTS "media_course_hole_idx" ON "media" ("course_id", "hole_number");

-- COURSE REVIEWS — verified player reviews with public/anonymous attribution
CREATE TABLE IF NOT EXISTS "course_reviews" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "course_id" integer NOT NULL,
  "user_id" integer,
  "reviewer_display_name" text,
  "reviewer_email" text,
  "display_mode" text DEFAULT 'public' NOT NULL,
  "rating" integer NOT NULL,
  "title" text,
  "body" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "abuse_report_count" integer DEFAULT 0 NOT NULL,
  "moderation_note" text,
  "moderated_by_user_id" integer,
  "moderated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "course_reviews"
    ADD CONSTRAINT "course_reviews_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "course_reviews"
    ADD CONSTRAINT "course_reviews_course_fk"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "course_reviews"
    ADD CONSTRAINT "course_reviews_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "course_reviews_course_idx" ON "course_reviews" ("course_id", "status");
CREATE INDEX IF NOT EXISTS "course_reviews_org_idx" ON "course_reviews" ("organization_id", "status");

-- COURSE REVIEW REPORTS — abuse / inappropriate content reports against a review
CREATE TABLE IF NOT EXISTS "course_review_reports" (
  "id" serial PRIMARY KEY NOT NULL,
  "review_id" integer NOT NULL,
  "reporter_user_id" integer,
  "reporter_email" text,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "course_review_reports"
    ADD CONSTRAINT "course_review_reports_review_fk"
    FOREIGN KEY ("review_id") REFERENCES "course_reviews"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "course_review_reports"
    ADD CONSTRAINT "course_review_reports_user_fk"
    FOREIGN KEY ("reporter_user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "course_review_reports_review_idx" ON "course_review_reports" ("review_id");
