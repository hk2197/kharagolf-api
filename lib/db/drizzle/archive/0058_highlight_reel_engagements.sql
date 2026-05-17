-- Task #544 — Track which highlight reels members download or share.
-- Each row is a single download/share event fired by the mobile/web client
-- when a player saves a reel to their gallery or hands it off to a share
-- sheet. Counts are derived with COUNT(*) GROUP BY reel_id at read time.


-- post-merge-guard: fresh-DB guard (table:highlight_reels)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'highlight_reels') AS post_merge_dep_present \gset
\if :post_merge_dep_present

DO $$ BEGIN
  CREATE TYPE "highlight_reel_engagement_type" AS ENUM ('download', 'share');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "highlight_reel_engagements" (
  "id" serial PRIMARY KEY,
  "reel_id" integer NOT NULL REFERENCES "highlight_reels"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "event_type" "highlight_reel_engagement_type" NOT NULL,
  "source" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "highlight_reel_engagements_reel_idx"
  ON "highlight_reel_engagements" ("reel_id");

CREATE INDEX IF NOT EXISTS "highlight_reel_engagements_reel_type_idx"
  ON "highlight_reel_engagements" ("reel_id", "event_type");

CREATE INDEX IF NOT EXISTS "highlight_reel_engagements_org_created_idx"
  ON "highlight_reel_engagements" ("organization_id", "created_at");

\else
\echo 'parent table highlight_reels not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

