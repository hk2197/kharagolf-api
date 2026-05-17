-- Social Wall & Club Feed (Task #94)

DO $$ BEGIN
  CREATE TYPE "public"."feed_post_type" AS ENUM ('member_post', 'achievement', 'club_announcement');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "public"."feed_privacy" AS ENUM ('all_members', 'followers_only');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "public"."feed_report_reason" AS ENUM ('inappropriate', 'spam', 'offensive', 'other');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "feed_posts" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "author_user_id" integer,
  "type" "feed_post_type" NOT NULL DEFAULT 'member_post',
  "body" text NOT NULL,
  "privacy" "feed_privacy" NOT NULL DEFAULT 'all_members',
  "is_pinned" boolean NOT NULL DEFAULT false,
  "is_hidden" boolean NOT NULL DEFAULT false,
  "tagged_course_id" integer,
  "tagged_hole_number" integer,
  "tagged_round_id" integer,
  "achievement_type" text,
  "reactions_count" integer NOT NULL DEFAULT 0,
  "comments_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "feed_posts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "feed_posts_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "app_users"("id") ON DELETE SET NULL,
  CONSTRAINT "feed_posts_tagged_course_id_fkey" FOREIGN KEY ("tagged_course_id") REFERENCES "courses"("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "feed_post_media" (
  "id" serial PRIMARY KEY NOT NULL,
  "post_id" integer NOT NULL,
  "url" text NOT NULL,
  "mime_type" text NOT NULL DEFAULT 'image/jpeg',
  "width" integer,
  "height" integer,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "feed_post_media_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "feed_posts"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "feed_reactions" (
  "id" serial PRIMARY KEY NOT NULL,
  "post_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "emoji" text NOT NULL DEFAULT '👍',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "feed_reactions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "feed_posts"("id") ON DELETE CASCADE,
  CONSTRAINT "feed_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "feed_comments" (
  "id" serial PRIMARY KEY NOT NULL,
  "post_id" integer NOT NULL,
  "author_user_id" integer,
  "body" text NOT NULL,
  "is_hidden" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "feed_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "feed_posts"("id") ON DELETE CASCADE,
  CONSTRAINT "feed_comments_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "app_users"("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "feed_reports" (
  "id" serial PRIMARY KEY NOT NULL,
  "post_id" integer,
  "comment_id" integer,
  "reporter_user_id" integer NOT NULL,
  "reason" "feed_report_reason" NOT NULL DEFAULT 'inappropriate',
  "notes" text,
  "status" text NOT NULL DEFAULT 'pending',
  "resolved_by_user_id" integer,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "feed_reports_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "feed_posts"("id") ON DELETE CASCADE,
  CONSTRAINT "feed_reports_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "feed_comments"("id") ON DELETE CASCADE,
  CONSTRAINT "feed_reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "app_users"("id") ON DELETE CASCADE,
  CONSTRAINT "feed_reports_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "app_users"("id") ON DELETE SET NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS "feed_posts_org_idx" ON "feed_posts" ("organization_id");
CREATE INDEX IF NOT EXISTS "feed_posts_author_idx" ON "feed_posts" ("author_user_id");
CREATE INDEX IF NOT EXISTS "feed_posts_created_idx" ON "feed_posts" ("created_at");
CREATE INDEX IF NOT EXISTS "feed_media_post_idx" ON "feed_post_media" ("post_id");
CREATE UNIQUE INDEX IF NOT EXISTS "feed_reaction_unique" ON "feed_reactions" ("post_id", "user_id");
CREATE INDEX IF NOT EXISTS "feed_reactions_post_idx" ON "feed_reactions" ("post_id");
CREATE INDEX IF NOT EXISTS "feed_comments_post_idx" ON "feed_comments" ("post_id");
CREATE INDEX IF NOT EXISTS "feed_comments_author_idx" ON "feed_comments" ("author_user_id");
CREATE INDEX IF NOT EXISTS "feed_reports_post_idx" ON "feed_reports" ("post_id");
CREATE INDEX IF NOT EXISTS "feed_reports_status_idx" ON "feed_reports" ("status");
