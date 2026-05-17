-- Task #369 — Per-club marketing site builder.
-- One row per organization holding theme, hero, copy, gallery,
-- section visibility/order, SEO overrides, publish state and a
-- cache_version counter used for ETag invalidation.
CREATE TABLE IF NOT EXISTS "club_marketing_sites" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "theme" text DEFAULT 'classic' NOT NULL,
  "hero_image_url" text,
  "hero_title" text,
  "hero_subtitle" text,
  "hero_cta_label" text,
  "hero_cta_href" text,
  "about_markdown" text,
  "services_markdown" text,
  "gallery_images" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "section_order" jsonb DEFAULT '["hero","about","tournaments","lessons","tee_times","fb","gallery","services","contact"]'::jsonb NOT NULL,
  "enabled_sections" jsonb DEFAULT '{"hero":true,"about":true,"tournaments":true,"lessons":true,"tee_times":true,"fb":false,"gallery":true,"services":false,"contact":true}'::jsonb NOT NULL,
  "seo_title" text,
  "seo_description" text,
  "seo_og_image_url" text,
  "is_published" boolean DEFAULT false NOT NULL,
  "published_at" timestamp with time zone,
  "cache_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "club_marketing_sites_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "club_marketing_sites"
    ADD CONSTRAINT "club_marketing_sites_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
