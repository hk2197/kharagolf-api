-- Deterministic slot routing for bracket advancement (winner & loser).
ALTER TABLE "bracket_matches" ADD COLUMN IF NOT EXISTS "next_winner_slot" integer;
ALTER TABLE "bracket_matches" ADD COLUMN IF NOT EXISTS "next_loser_slot" integer;
