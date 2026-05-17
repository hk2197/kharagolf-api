-- Task #1637 — reusable post-event survey templates per organisation.
--
-- Tournament admins were rebuilding the same set of survey questions
-- for every event. This table lets a club save one or more named
-- templates and pick one when sending a new survey. Stored per-org and
-- shared across all tournament admins in that org.
--
-- Created with IF NOT EXISTS so a partial replay during a deploy retry
-- is safe. The (organization_id, name) unique index prevents duplicate
-- template names within a single club.

CREATE TABLE IF NOT EXISTS "post_event_survey_templates" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "questions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "post_event_survey_templates_org_idx"
  ON "post_event_survey_templates" ("organization_id");

CREATE UNIQUE INDEX IF NOT EXISTS "post_event_survey_templates_org_name_idx"
  ON "post_event_survey_templates" ("organization_id", "name");
