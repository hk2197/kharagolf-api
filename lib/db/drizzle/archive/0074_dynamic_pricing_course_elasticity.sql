-- Task #822 — Per-course price elasticity overrides for the forecast.
-- The org-level defaults in `tee_dynamic_pricing_config` already let admins
-- tune segment elasticities for the whole club. This table layers a
-- per-course override on top so resort, municipal and members-only courses
-- inside the same org can each be modelled with their own price sensitivity.
-- A NULL on either column means "fall back to the org-level default for
-- this segment".

CREATE TABLE IF NOT EXISTS "tee_dynamic_pricing_course_elasticity" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "course_id" integer NOT NULL,
  "member_elasticity" numeric(4, 2),
  "guest_elasticity" numeric(4, 2),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tee_dynamic_pricing_course_elasticity"
    ADD CONSTRAINT "tee_dyn_pricing_course_elasticity_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tee_dynamic_pricing_course_elasticity"
    ADD CONSTRAINT "tee_dyn_pricing_course_elasticity_course_fk"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tee_dyn_pricing_course_elasticity_org_course_unique"
  ON "tee_dynamic_pricing_course_elasticity" ("organization_id","course_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tee_dyn_pricing_course_elasticity_org_idx"
  ON "tee_dynamic_pricing_course_elasticity" ("organization_id");
