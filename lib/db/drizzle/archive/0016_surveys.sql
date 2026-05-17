-- Member Feedback & Survey Tools (Task #117)

DO $$ BEGIN
  CREATE TYPE "survey_status" AS ENUM('draft', 'active', 'closed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "survey_trigger" AS ENUM('manual', 'post_round', 'post_event', 'post_tournament');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "question_type" AS ENUM('rating', 'multiple_choice', 'free_text', 'nps');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "surveys" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "description" text,
  "status" "survey_status" NOT NULL DEFAULT 'draft',
  "trigger" "survey_trigger" NOT NULL DEFAULT 'manual',
  "is_anonymous" boolean NOT NULL DEFAULT false,
  "target_segment" text,
  "published_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "created_by_user_id" integer REFERENCES "app_users"("id") ON DELETE set null,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "survey_questions" (
  "id" serial PRIMARY KEY NOT NULL,
  "survey_id" integer NOT NULL REFERENCES "surveys"("id") ON DELETE cascade,
  "type" "question_type" NOT NULL,
  "question_text" text NOT NULL,
  "is_required" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "options" jsonb DEFAULT '[]',
  "rating_min" integer DEFAULT 1,
  "rating_max" integer DEFAULT 5,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "survey_responses" (
  "id" serial PRIMARY KEY NOT NULL,
  "survey_id" integer NOT NULL REFERENCES "surveys"("id") ON DELETE cascade,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "respondent_user_id" integer REFERENCES "app_users"("id") ON DELETE set null,
  "respondent_email" text,
  "is_anonymous" boolean NOT NULL DEFAULT false,
  "completed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "survey_response_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "response_id" integer NOT NULL REFERENCES "survey_responses"("id") ON DELETE cascade,
  "question_id" integer NOT NULL REFERENCES "survey_questions"("id") ON DELETE cascade,
  "rating_value" integer,
  "choice_value" text,
  "text_value" text,
  "nps_score" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "surveys_org_idx" ON "surveys" ("organization_id");
CREATE INDEX IF NOT EXISTS "surveys_status_idx" ON "surveys" ("status");
CREATE INDEX IF NOT EXISTS "survey_questions_survey_idx" ON "survey_questions" ("survey_id");
CREATE INDEX IF NOT EXISTS "survey_responses_survey_idx" ON "survey_responses" ("survey_id");
CREATE INDEX IF NOT EXISTS "survey_responses_user_idx" ON "survey_responses" ("respondent_user_id");
CREATE INDEX IF NOT EXISTS "survey_response_items_response_idx" ON "survey_response_items" ("response_id");
CREATE INDEX IF NOT EXISTS "survey_response_items_question_idx" ON "survey_response_items" ("question_id");
