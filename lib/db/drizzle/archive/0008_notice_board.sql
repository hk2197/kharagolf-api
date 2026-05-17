-- Club Notice Board & Content Management
-- Adds notice board categories, articles, and read-tracking tables.
-- NOTE: This migration is idempotent (IF NOT EXISTS / EXCEPTION guards throughout).

-- ── notice_board_article_status enum ────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "notice_board_article_status" AS ENUM('draft', 'scheduled', 'published', 'archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── notice_board_categories ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "notice_board_categories" (
  "id"              serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name"            text NOT NULL,
  "color"           text NOT NULL DEFAULT '#C9A84C',
  "icon"            text NOT NULL DEFAULT 'newspaper',
  "sort_order"      integer NOT NULL DEFAULT 0,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notice_board_categories_org_idx"
  ON "notice_board_categories"("organization_id");

-- ── notice_board_articles ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "notice_board_articles" (
  "id"                serial PRIMARY KEY NOT NULL,
  "organization_id"   integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "category_id"       integer REFERENCES "notice_board_categories"("id") ON DELETE SET NULL,
  "title"             text NOT NULL,
  "body"              text NOT NULL,
  "image_url"         text,
  "is_pinned"         boolean NOT NULL DEFAULT false,
  "is_important"      boolean NOT NULL DEFAULT false,
  "is_sponsored"      boolean NOT NULL DEFAULT false,
  "sponsor_url"       text,
  "status"            notice_board_article_status NOT NULL DEFAULT 'draft',
  "publish_at"        timestamptz,
  "published_at"      timestamptz,
  "archived_at"       timestamptz,
  "author_user_id"    integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "author_name"       text,
  "attachments"       jsonb NOT NULL DEFAULT '[]',
  "view_count"        integer NOT NULL DEFAULT 0,
  "click_count"       integer NOT NULL DEFAULT 0,
  "notification_sent" boolean NOT NULL DEFAULT false,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notice_board_articles_org_idx"
  ON "notice_board_articles"("organization_id");
CREATE INDEX IF NOT EXISTS "notice_board_articles_status_idx"
  ON "notice_board_articles"("status");
CREATE INDEX IF NOT EXISTS "notice_board_articles_pinned_idx"
  ON "notice_board_articles"("is_pinned");
CREATE INDEX IF NOT EXISTS "notice_board_articles_publish_at_idx"
  ON "notice_board_articles"("publish_at");

-- ── notice_board_reads ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "notice_board_reads" (
  "id"         serial PRIMARY KEY NOT NULL,
  "article_id" integer NOT NULL REFERENCES "notice_board_articles"("id") ON DELETE CASCADE,
  "user_id"    integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "read_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "notice_board_reads_unique"
  ON "notice_board_reads"("article_id", "user_id");
CREATE INDEX IF NOT EXISTS "notice_board_reads_user_idx"
  ON "notice_board_reads"("user_id");
