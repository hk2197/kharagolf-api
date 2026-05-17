-- Task 161: Shot Detail Enhancements
-- Extend shots table to support general play rounds, club picker, and detail fields

-- Drop the old NOT NULL constraints

-- post-merge-guard: fresh-DB guard (table:general_play_rounds)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'general_play_rounds') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE shots ALTER COLUMN tournament_id DROP NOT NULL;
ALTER TABLE shots ALTER COLUMN player_id DROP NOT NULL;

-- Drop old unique index (was based on NOT NULL columns; replaced by partial indexes below)
DROP INDEX IF EXISTS shots_player_tournament_round_hole_shot_unique;

-- Add new columns
ALTER TABLE shots
  ADD COLUMN IF NOT EXISTS general_play_round_id INTEGER REFERENCES general_play_rounds(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES app_users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS miss_direction TEXT,
  ADD COLUMN IF NOT EXISTS lie_type TEXT,
  ADD COLUMN IF NOT EXISTS shot_shape TEXT,
  ADD COLUMN IF NOT EXISTS penalty_reason TEXT;

-- Partial unique index for tournament shots
CREATE UNIQUE INDEX IF NOT EXISTS shots_player_tournament_round_hole_shot_unique
  ON shots (player_id, tournament_id, round, hole_number, shot_number)
  WHERE player_id IS NOT NULL AND tournament_id IS NOT NULL;

-- Partial unique index for general play shots
CREATE UNIQUE INDEX IF NOT EXISTS shots_user_gp_round_hole_shot_unique
  ON shots (user_id, general_play_round_id, round, hole_number, shot_number)
  WHERE user_id IS NOT NULL AND general_play_round_id IS NOT NULL;

-- General indexes for query performance
CREATE INDEX IF NOT EXISTS shots_player_tournament_idx ON shots (player_id, tournament_id);
CREATE INDEX IF NOT EXISTS shots_user_gp_idx ON shots (user_id, general_play_round_id);

\else
\echo 'parent table general_play_rounds not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

