-- Task #129: Tee Sheet Rules Engine
-- Adds new enums, columns on course_tee_slots, and four new rules tables.

-- ── ENUMS ─────────────────────────────────────────────────────────────────────


-- post-merge-guard: fresh-DB guard (table:course_tee_slots)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'course_tee_slots') AS post_merge_dep_present \gset
\if :post_merge_dep_present

DO $$ BEGIN
  CREATE TYPE "tee_start_type" AS ENUM ('normal', 'split_tee', 'shotgun');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "tee_block_reason" AS ENUM (
    'maintenance', 'tournament', 'private_event', 'members_only', 'weather', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "tee_recurrence" AS ENUM ('one_off', 'weekly', 'monthly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "tee_membership_tier" AS ENUM (
    'full_member', 'social_member', 'guest', 'public'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── EXTEND course_tee_slots ────────────────────────────────────────────────────

ALTER TABLE "course_tee_slots"
  ADD COLUMN IF NOT EXISTS "starting_hole" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "start_type"    "tee_start_type" NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS "template_id"   integer;

-- Recreate unique index to include starting_hole (supports split-tee & shotgun)
DROP INDEX IF EXISTS "tee_slot_unique_identity_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "tee_slot_unique_identity_idx"
  ON "course_tee_slots" ("organization_id", "course_id", "slot_date", "slot_time", "starting_hole");

-- ── SCHEDULE TEMPLATES ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tee_schedule_templates" (
  "id"               serial PRIMARY KEY,
  "organization_id"  integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "course_id"        integer NOT NULL REFERENCES "courses"("id") ON DELETE CASCADE,
  "name"             varchar(120) NOT NULL,
  "days_of_week"     jsonb NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  "valid_from"       timestamp,
  "valid_until"      timestamp,
  "first_tee_time"   varchar(5) NOT NULL DEFAULT '06:00',
  "last_tee_time"    varchar(5) NOT NULL DEFAULT '18:00',
  "interval_minutes" integer NOT NULL DEFAULT 10,
  "capacity"         integer NOT NULL DEFAULT 4,
  "start_type"       "tee_start_type" NOT NULL DEFAULT 'normal',
  "is_active"        boolean NOT NULL DEFAULT true,
  "created_at"       timestamp NOT NULL DEFAULT now(),
  "updated_at"       timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tee_schedule_templates_org_course_idx"
  ON "tee_schedule_templates" ("organization_id", "course_id");

-- ── BLOCK RULES ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tee_block_rules" (
  "id"                      serial PRIMARY KEY,
  "organization_id"         integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "course_id"               integer REFERENCES "courses"("id") ON DELETE CASCADE,
  "name"                    varchar(120) NOT NULL,
  "block_date"              timestamp,
  "start_time"              varchar(5),
  "end_time"                varchar(5),
  "reason"                  "tee_block_reason" NOT NULL DEFAULT 'other',
  "recurrence"              "tee_recurrence" NOT NULL DEFAULT 'one_off',
  "recurrence_day_of_week"  integer,
  "recurrence_day_of_month" integer,
  "is_active"               boolean NOT NULL DEFAULT true,
  "created_at"              timestamp NOT NULL DEFAULT now(),
  "updated_at"              timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tee_block_rules_org_idx"
  ON "tee_block_rules" ("organization_id");

-- ── PLAYER COUNT RULES ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tee_player_count_rules" (
  "id"               serial PRIMARY KEY,
  "organization_id"  integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "course_id"        integer REFERENCES "courses"("id") ON DELETE CASCADE,
  "name"             varchar(120) NOT NULL,
  "min_players"      integer NOT NULL DEFAULT 1,
  "max_players"      integer NOT NULL DEFAULT 4,
  "days_of_week"     jsonb,
  "start_time"       varchar(5),
  "end_time"         varchar(5),
  "membership_tier"  "tee_membership_tier",
  "is_active"        boolean NOT NULL DEFAULT true,
  "created_at"       timestamp NOT NULL DEFAULT now(),
  "updated_at"       timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tee_player_count_rules_org_idx"
  ON "tee_player_count_rules" ("organization_id");

-- ── BOOKING WINDOWS ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tee_booking_windows" (
  "id"               serial PRIMARY KEY,
  "organization_id"  integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "membership_tier"  "tee_membership_tier" NOT NULL,
  "days_ahead"       integer NOT NULL DEFAULT 30,
  "created_at"       timestamp NOT NULL DEFAULT now(),
  "updated_at"       timestamp NOT NULL DEFAULT now(),
  UNIQUE ("organization_id", "membership_tier")
);

\else
\echo 'parent table course_tee_slots not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

