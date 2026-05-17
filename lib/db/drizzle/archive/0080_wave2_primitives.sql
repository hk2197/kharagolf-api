-- Migration 0080 — Wave 2 load-bearing primitives (Task #937)
--
-- Adds five tables that gate the Wave 2 deliverables:
--   notification_type_registry — every new notify must register here (W2-F core)
--   course_data_corrections    — moderation queue for "report bad hole data" (W2-A)
--   post_event_surveys + post_event_survey_responses — close-flow survey (W2-D)
--   tee_dynamic_pricing_rules  — rule-based pricing config rows (W2-G)
--   tee_booking_waitlist       — auto-promote on cancellation (W2-G)


-- post-merge-guard: fresh-DB guard (table:course_tee_slots)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'course_tee_slots') AS post_merge_dep_present \gset
\if :post_merge_dep_present

BEGIN;

-- ── notification_type_registry ────────────────────────────────────────────
-- The single source of truth for every transactional / digestable
-- notification key. Going forward, no helper may dispatch a notify
-- whose `key` isn't in this table — see lib/notificationRegistry.ts.
CREATE TABLE IF NOT EXISTS "notification_type_registry" (
  "id"                serial PRIMARY KEY,
  "key"               text NOT NULL UNIQUE,
  "category"          text NOT NULL,
  "description"       text NOT NULL,
  "default_channels"  jsonb NOT NULL DEFAULT '["email","push"]'::jsonb,
  "transactional"     boolean NOT NULL DEFAULT true,
  "digestable"        boolean NOT NULL DEFAULT false,
  "audit_required"    boolean NOT NULL DEFAULT false,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "notification_type_registry_category_idx"
  ON "notification_type_registry" ("category");

-- ── course_data_corrections ──────────────────────────────────────────────
-- Player-submitted corrections to course data (yardage, par, hazard
-- locations) for club admin moderation.
DO $$ BEGIN
  CREATE TYPE "course_correction_status" AS ENUM ('open', 'accepted', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "course_data_corrections" (
  "id"                  serial PRIMARY KEY,
  "course_id"           integer NOT NULL REFERENCES "courses"("id") ON DELETE CASCADE,
  "organization_id"     integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "hole_number"         integer,
  "field_name"          text NOT NULL,
  "current_value"       text,
  "proposed_value"      text NOT NULL,
  "reason"              text,
  "reported_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "status"              "course_correction_status" NOT NULL DEFAULT 'open',
  "reviewed_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "reviewed_at"         timestamp with time zone,
  "review_notes"        text,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "course_data_corrections_org_status_idx"
  ON "course_data_corrections" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "course_data_corrections_course_idx"
  ON "course_data_corrections" ("course_id");

-- ── post_event_surveys + responses ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "post_event_surveys" (
  "id"               serial PRIMARY KEY,
  "tournament_id"    integer NOT NULL REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "organization_id"  integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "questions"        jsonb NOT NULL DEFAULT '[]'::jsonb,
  "sent_at"          timestamp with time zone,
  "reminder_sent_at" timestamp with time zone,
  "closes_at"        timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "post_event_surveys_tournament_unique"
  ON "post_event_surveys" ("tournament_id");

CREATE TABLE IF NOT EXISTS "post_event_survey_responses" (
  "id"          serial PRIMARY KEY,
  "survey_id"   integer NOT NULL REFERENCES "post_event_surveys"("id") ON DELETE CASCADE,
  "user_id"     integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "answers"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "submitted_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "post_event_survey_responses_survey_idx"
  ON "post_event_survey_responses" ("survey_id");

-- ── tee_dynamic_pricing_rules ────────────────────────────────────────────
-- Rule-based price modifications that layer on top of teePricingRules.
-- conditions JSON e.g.: { "dayOfWeek": [0,6], "timeRange": ["06:00","09:00"], "occupancy": ">0.7" }
CREATE TABLE IF NOT EXISTS "tee_dynamic_pricing_rules" (
  "id"               serial PRIMARY KEY,
  "organization_id"  integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name"             text NOT NULL,
  "conditions"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "price_delta_pct"  numeric(5,2) NOT NULL DEFAULT 0,
  "active"           boolean NOT NULL DEFAULT true,
  "priority"         integer NOT NULL DEFAULT 0,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tee_dynamic_pricing_rules_org_active_idx"
  ON "tee_dynamic_pricing_rules" ("organization_id", "active");

-- ── tee_booking_waitlist ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "tee_waitlist_status" AS ENUM ('waiting', 'promoted', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "tee_booking_waitlist" (
  "id"              serial PRIMARY KEY,
  "slot_id"         integer NOT NULL REFERENCES "course_tee_slots"("id") ON DELETE CASCADE,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"         integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "party_size"      integer NOT NULL DEFAULT 1,
  "status"          "tee_waitlist_status" NOT NULL DEFAULT 'waiting',
  "promoted_booking_id" integer REFERENCES "tee_bookings"("id") ON DELETE SET NULL,
  "promoted_at"     timestamp with time zone,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tee_booking_waitlist_slot_status_idx"
  ON "tee_booking_waitlist" ("slot_id", "status", "created_at");

COMMIT;

\else
\echo 'parent table course_tee_slots not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

