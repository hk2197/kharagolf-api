-- Bracket builder: formats (single_elim, double_elim, round_robin), tie-break, share tokens
ALTER TABLE "match_play_brackets" ADD COLUMN IF NOT EXISTS "format" text NOT NULL DEFAULT 'single_elim';
ALTER TABLE "match_play_brackets" ADD COLUMN IF NOT EXISTS "tie_break_rule" text NOT NULL DEFAULT 'sudden_death';
ALTER TABLE "match_play_brackets" ADD COLUMN IF NOT EXISTS "share_token" text;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "match_play_brackets_share_token_unique" ON "match_play_brackets" ("share_token");
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

ALTER TABLE "bracket_matches" ADD COLUMN IF NOT EXISTS "next_loser_match_id" integer;

ALTER TABLE "ryder_cup_config" ADD COLUMN IF NOT EXISTS "share_token" text;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "ryder_cup_config_share_token_unique" ON "ryder_cup_config" ("share_token");
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
