-- Junior Golf Programs migration

DO $$ BEGIN CREATE TYPE "junior_age_category" AS ENUM('under_8','under_10','under_12','under_14','under_16','under_18'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "junior_pathway_level" AS ENUM('beginner','intermediate','advanced','elite'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "junior_award_type" AS ENUM('monthly_winner','most_improved','best_attendance','spirit_award','custom'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "junior_profiles" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" integer REFERENCES "app_users"("id") ON DELETE set null,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "date_of_birth" timestamp with time zone NOT NULL,
  "age_category" "junior_age_category" NOT NULL,
  "pathway_level" "junior_pathway_level" NOT NULL DEFAULT 'beginner',
  "handicap_index" numeric(4,1),
  "preferred_tee_box" "tee_box" DEFAULT 'red',
  "notes" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "junior_profiles_org_idx" ON "junior_profiles" ("organization_id");
CREATE INDEX IF NOT EXISTS "junior_profiles_user_idx" ON "junior_profiles" ("user_id");

CREATE TABLE IF NOT EXISTS "guardian_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "junior_profile_id" integer NOT NULL REFERENCES "junior_profiles"("id") ON DELETE cascade,
  "guardian_user_id" integer REFERENCES "app_users"("id") ON DELETE set null,
  "guardian_name" text NOT NULL,
  "guardian_email" text,
  "guardian_phone" text,
  "relationship" text NOT NULL DEFAULT 'parent',
  "is_primary" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "guardian_links_junior_idx" ON "guardian_links" ("junior_profile_id");
CREATE INDEX IF NOT EXISTS "guardian_links_user_idx" ON "guardian_links" ("guardian_user_id");

CREATE TABLE IF NOT EXISTS "development_pathways" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "description" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "dev_pathways_org_idx" ON "development_pathways" ("organization_id");

CREATE TABLE IF NOT EXISTS "pathway_levels" (
  "id" serial PRIMARY KEY NOT NULL,
  "pathway_id" integer NOT NULL REFERENCES "development_pathways"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "level" "junior_pathway_level" NOT NULL DEFAULT 'beginner',
  "description" text,
  "criteria" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "pathway_levels_pathway_idx" ON "pathway_levels" ("pathway_id");

CREATE TABLE IF NOT EXISTS "junior_pathway_progress" (
  "id" serial PRIMARY KEY NOT NULL,
  "junior_profile_id" integer NOT NULL REFERENCES "junior_profiles"("id") ON DELETE cascade,
  "pathway_id" integer NOT NULL REFERENCES "development_pathways"("id") ON DELETE cascade,
  "current_level_id" integer REFERENCES "pathway_levels"("id") ON DELETE set null,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_progressed_at" timestamp with time zone,
  "notes" text,
  CONSTRAINT "junior_pathway_unique" UNIQUE ("junior_profile_id","pathway_id")
);
CREATE INDEX IF NOT EXISTS "junior_pathway_progress_junior_idx" ON "junior_pathway_progress" ("junior_profile_id");

CREATE TABLE IF NOT EXISTS "junior_programs" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "description" text,
  "start_date" timestamp with time zone,
  "end_date" timestamp with time zone,
  "max_participants" integer,
  "age_categories" jsonb DEFAULT '[]',
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "junior_programs_org_idx" ON "junior_programs" ("organization_id");

CREATE TABLE IF NOT EXISTS "program_participants" (
  "id" serial PRIMARY KEY NOT NULL,
  "program_id" integer NOT NULL REFERENCES "junior_programs"("id") ON DELETE cascade,
  "junior_profile_id" integer NOT NULL REFERENCES "junior_profiles"("id") ON DELETE cascade,
  "enrolled_at" timestamp with time zone NOT NULL DEFAULT now(),
  "notes" text,
  CONSTRAINT "program_participant_unique" UNIQUE ("program_id","junior_profile_id")
);
CREATE INDEX IF NOT EXISTS "program_participants_program_idx" ON "program_participants" ("program_id");
CREATE INDEX IF NOT EXISTS "program_participants_junior_idx" ON "program_participants" ("junior_profile_id");

CREATE TABLE IF NOT EXISTS "program_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "program_id" integer NOT NULL REFERENCES "junior_programs"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "description" text,
  "scheduled_at" timestamp with time zone NOT NULL,
  "duration_minutes" integer NOT NULL DEFAULT 60,
  "location" text,
  "coach_name" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "program_sessions_program_idx" ON "program_sessions" ("program_id");
CREATE INDEX IF NOT EXISTS "program_sessions_date_idx" ON "program_sessions" ("scheduled_at");

CREATE TABLE IF NOT EXISTS "program_attendance" (
  "id" serial PRIMARY KEY NOT NULL,
  "session_id" integer NOT NULL REFERENCES "program_sessions"("id") ON DELETE cascade,
  "junior_profile_id" integer NOT NULL REFERENCES "junior_profiles"("id") ON DELETE cascade,
  "attended" boolean NOT NULL DEFAULT false,
  "notes" text,
  "marked_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "program_attendance_unique" UNIQUE ("session_id","junior_profile_id")
);
CREATE INDEX IF NOT EXISTS "program_attendance_session_idx" ON "program_attendance" ("session_id");
CREATE INDEX IF NOT EXISTS "program_attendance_junior_idx" ON "program_attendance" ("junior_profile_id");

CREATE TABLE IF NOT EXISTS "junior_awards" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "program_id" integer REFERENCES "junior_programs"("id") ON DELETE set null,
  "junior_profile_id" integer NOT NULL REFERENCES "junior_profiles"("id") ON DELETE cascade,
  "award_type" "junior_award_type" NOT NULL,
  "age_category" "junior_age_category",
  "award_label" text NOT NULL,
  "description" text,
  "awarded_at" timestamp with time zone NOT NULL DEFAULT now(),
  "awarded_by_user_id" integer REFERENCES "app_users"("id") ON DELETE set null
);
CREATE INDEX IF NOT EXISTS "junior_awards_org_idx" ON "junior_awards" ("organization_id");
CREATE INDEX IF NOT EXISTS "junior_awards_junior_idx" ON "junior_awards" ("junior_profile_id");
CREATE INDEX IF NOT EXISTS "junior_awards_program_idx" ON "junior_awards" ("program_id");
