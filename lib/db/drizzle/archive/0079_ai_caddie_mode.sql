-- Migration 0079 — ai_caddie_mode column + audit table (Wave 1, W1-A core)
--
-- aiCaddieMode is one of:
--   'open'           — all advice surfaces enabled (default)
--   'distance_only'  — only F/C/B yardages allowed; club rec / strategy hidden
--   'lockdown'       — all advice surfaces hidden, including yardages
--
-- Precedence (highest wins):
--   general_play_rounds.ai_caddie_mode
--   tournaments.ai_caddie_mode
--   leagues.ai_caddie_mode
--   default 'open'
--
-- Every blocked attempt writes one audit row to ai_caddie_mode_blocks
-- so events organisers can later prove that no advice leaked during a
-- lockdown round.


-- post-merge-guard: fresh-DB guard (table:general_play_rounds)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'general_play_rounds') AS post_merge_dep_present \gset
\if :post_merge_dep_present

BEGIN;

DO $$ BEGIN
  CREATE TYPE "ai_caddie_mode" AS ENUM ('open', 'distance_only', 'lockdown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tournaments"          ADD COLUMN IF NOT EXISTS "ai_caddie_mode" "ai_caddie_mode" NOT NULL DEFAULT 'open';
ALTER TABLE "leagues"              ADD COLUMN IF NOT EXISTS "ai_caddie_mode" "ai_caddie_mode" NOT NULL DEFAULT 'open';
ALTER TABLE "general_play_rounds"  ADD COLUMN IF NOT EXISTS "ai_caddie_mode" "ai_caddie_mode";

CREATE TABLE IF NOT EXISTS "ai_caddie_mode_blocks" (
  "id"              serial PRIMARY KEY,
  "organization_id" integer REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"         integer REFERENCES "app_users"("id")     ON DELETE SET NULL,
  "tournament_id"   integer REFERENCES "tournaments"("id")   ON DELETE SET NULL,
  "league_id"       integer REFERENCES "leagues"("id")       ON DELETE SET NULL,
  "round_id"        integer,
  "mode"            "ai_caddie_mode" NOT NULL,
  -- 'phone' | 'web' | 'watch'
  "surface"         text NOT NULL,
  -- e.g. 'caddie_ask', 'club_recommendation', 'distance_yardage'
  "action"          text NOT NULL,
  "metadata"        jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at"     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ai_caddie_mode_blocks_org_idx"  ON "ai_caddie_mode_blocks" ("organization_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "ai_caddie_mode_blocks_user_idx" ON "ai_caddie_mode_blocks" ("user_id", "occurred_at");

COMMIT;

\else
\echo 'parent table general_play_rounds not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

