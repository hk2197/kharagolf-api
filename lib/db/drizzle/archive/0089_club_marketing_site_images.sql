-- Task #1034 — Roll out the marketing-site image library to production.
-- Task #579 introduced the per-org marketing-site image library
-- (`club_marketing_site_images`) but it was only ever defined in the
-- Drizzle schema (`lib/db/src/schema/golf.ts`). No numbered SQL
-- migration was ever generated for it, so production — which only
-- gets schema changes via the numbered files in `lib/db/drizzle/` —
-- is missing the table entirely. This migration creates it so:
--   1. The "Choose from library" picker has somewhere to read/write.
--   2. Task #895's backfill (`scripts/src/backfill-marketing-site-images.ts`)
--      can be re-run against production successfully.
--
-- Idempotent: uses IF NOT EXISTS / DO blocks so re-running the
-- post-merge migrator on an already-migrated DB is a no-op.
CREATE TABLE IF NOT EXISTS "club_marketing_site_images" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "object_path" text NOT NULL,
  "url" text NOT NULL,
  "content_type" text,
  "size_bytes" integer,
  "uploaded_by_user_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "club_marketing_site_images"
    ADD CONSTRAINT "club_marketing_site_images_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "club_marketing_site_images"
    ADD CONSTRAINT "club_marketing_site_images_uploaded_by_user_id_app_users_id_fk"
    FOREIGN KEY ("uploaded_by_user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "club_marketing_site_images_org_object_uq"
  ON "club_marketing_site_images" ("organization_id", "object_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "club_marketing_site_images_org_created_idx"
  ON "club_marketing_site_images" ("organization_id", "created_at");
