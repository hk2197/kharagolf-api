-- Task #367: Dynamic pricing & yield management for tee times

DO $$ BEGIN
  CREATE TYPE "public"."tee_pricing_tier_member_type" AS ENUM('any', 'member', 'guest');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."tee_pricing_modifier_kind" AS ENUM('utilization', 'lead_time', 'weather');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."tee_pricing_adjustment_type" AS ENUM('percent', 'flat');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tee_dynamic_pricing_tiers" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "course_id" integer,
  "name" text NOT NULL,
  "description" text,
  "days_of_week" jsonb DEFAULT '[0,1,2,3,4,5,6]'::jsonb NOT NULL,
  "start_time" text,
  "end_time" text,
  "season_start" text,
  "season_end" text,
  "member_type" "tee_pricing_tier_member_type" DEFAULT 'any' NOT NULL,
  "member_rate" numeric(10, 2) DEFAULT '0' NOT NULL,
  "guest_rate" numeric(10, 2) DEFAULT '0' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tee_dynamic_pricing_modifiers" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "course_id" integer,
  "name" text NOT NULL,
  "kind" "tee_pricing_modifier_kind" NOT NULL,
  "threshold_min" numeric(10, 2),
  "threshold_max" numeric(10, 2),
  "weather_condition" text,
  "adjustment_type" "tee_pricing_adjustment_type" DEFAULT 'percent' NOT NULL,
  "adjustment_value" numeric(10, 2) DEFAULT '0' NOT NULL,
  "apply_to" "tee_pricing_tier_member_type" DEFAULT 'any' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tee_dynamic_pricing_config" (
  "organization_id" integer PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "price_floor_pct" numeric(5, 2) DEFAULT '0.50' NOT NULL,
  "price_ceiling_pct" numeric(5, 2) DEFAULT '2.00' NOT NULL,
  "deal_badge_threshold_pct" numeric(5, 2) DEFAULT '0.85' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tee_dynamic_pricing_audit" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "actor_user_id" integer,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" integer,
  "payload" jsonb,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "tee_dynamic_pricing_tiers" ADD CONSTRAINT "tee_dyn_pricing_tiers_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tee_dynamic_pricing_tiers" ADD CONSTRAINT "tee_dyn_pricing_tiers_course_fk"
    FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tee_dynamic_pricing_modifiers" ADD CONSTRAINT "tee_dyn_pricing_mods_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tee_dynamic_pricing_modifiers" ADD CONSTRAINT "tee_dyn_pricing_mods_course_fk"
    FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tee_dynamic_pricing_config" ADD CONSTRAINT "tee_dyn_pricing_config_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tee_dynamic_pricing_audit" ADD CONSTRAINT "tee_dyn_pricing_audit_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tee_dynamic_pricing_audit" ADD CONSTRAINT "tee_dyn_pricing_audit_actor_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tee_dyn_pricing_tiers_org_idx" ON "tee_dynamic_pricing_tiers" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tee_dyn_pricing_tiers_active_idx" ON "tee_dynamic_pricing_tiers" ("organization_id","is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tee_dyn_pricing_mods_org_idx" ON "tee_dynamic_pricing_modifiers" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tee_dyn_pricing_audit_org_idx" ON "tee_dynamic_pricing_audit" ("organization_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tee_dyn_pricing_audit_entity_idx" ON "tee_dynamic_pricing_audit" ("entity_type","entity_id");
