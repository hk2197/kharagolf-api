-- Task #628 — Let admins reply to course reviews from the moderation page.
-- Adds public reply fields to course_reviews so admins can post a club response
-- under a review on the public course page.

ALTER TABLE "course_reviews" ADD COLUMN IF NOT EXISTS "admin_reply" text;
ALTER TABLE "course_reviews" ADD COLUMN IF NOT EXISTS "admin_reply_at" timestamp with time zone;
ALTER TABLE "course_reviews" ADD COLUMN IF NOT EXISTS "admin_reply_by_user_id" integer;
