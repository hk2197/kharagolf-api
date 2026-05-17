-- Task #143: Scoring Format Completions (Stableford, Max Score, Par, Cut Lines)
-- Adds new tournament formats and scoring configuration columns

-- New tournament format enum values
ALTER TYPE "tournament_format" ADD VALUE IF NOT EXISTS 'maximum_score';
ALTER TYPE "tournament_format" ADD VALUE IF NOT EXISTS 'par_bogey';
ALTER TYPE "tournament_format" ADD VALUE IF NOT EXISTS 'team_stableford';

-- New columns for scoring configuration
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "stableford_points_config" jsonb;
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "max_score_cap" integer;
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "cut_after_round" integer;
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "cut_position" text;
