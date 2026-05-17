-- Task #70: Player Self-Scoring — Tournament & League Marker Flow
-- Creates round_submission_ext, scorecard_corrections, scorecard_flags tables
-- Adds scoring_close_time to tournaments

-- Round submission extended data (countersign, dispute, committee override, deadline)

-- post-merge-guard: fresh-DB guard (table:tournament_templates)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournament_templates') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "round_submission_ext" (
  "id" serial PRIMARY KEY NOT NULL,
  "submission_id" integer NOT NULL UNIQUE REFERENCES "round_submissions"("id") ON DELETE cascade,
  "marker_user_id" integer REFERENCES "app_users"("id") ON DELETE set null,
  "countersigned_at" timestamp with time zone,
  "dispute_note" text,
  "committee_override_note" text,
  "committee_override_by_user_id" integer REFERENCES "app_users"("id") ON DELETE set null,
  "committee_override_at" timestamp with time zone,
  "deadline_at" timestamp with time zone,
  "scoring_close_time" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Per-hole correction requests between player submission and marker countersign
CREATE TABLE IF NOT EXISTS "scorecard_corrections" (
  "id" serial PRIMARY KEY NOT NULL,
  "submission_id" integer NOT NULL REFERENCES "round_submissions"("id") ON DELETE cascade,
  "hole_number" integer NOT NULL,
  "original_score" integer NOT NULL,
  "requested_score" integer NOT NULL,
  "reason" text,
  "marker_decision" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "scorecard_corrections_submission_idx" ON "scorecard_corrections" ("submission_id");

-- Per-hole flags from marker during the round (live alert to player)
CREATE TABLE IF NOT EXISTS "scorecard_flags" (
  "id" serial PRIMARY KEY NOT NULL,
  "submission_id" integer NOT NULL REFERENCES "round_submissions"("id") ON DELETE cascade,
  "hole_number" integer NOT NULL,
  "marker_note" text,
  "player_response" text,
  "resolved_at" timestamp with time zone,
  "flagged_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "scorecard_flags_submission_idx" ON "scorecard_flags" ("submission_id");

-- Add scoring_close_time to tournaments (time of day string, e.g. "18:00")
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "scoring_close_time" text;

-- Add allow_self_scoring toggle to tournaments and tournament_templates (leagues)
-- Distinct from self_posting: allow_self_scoring is the admin gate for the player self-scoring UI flow
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "allow_self_scoring" boolean NOT NULL DEFAULT false;
ALTER TABLE "tournament_templates" ADD COLUMN IF NOT EXISTS "allow_self_scoring" boolean NOT NULL DEFAULT false;

\else
\echo 'parent table tournament_templates not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

