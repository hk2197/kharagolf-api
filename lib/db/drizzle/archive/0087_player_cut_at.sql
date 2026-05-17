-- Task #1004 — Tournament cut tracking persistence.
--
-- Wave 2's cutHandler.ts marks players cut and returns the survivor list,
-- but had no per-player column to record that decision. The leaderboard had
-- no way to filter "still in" players from those that missed the cut.
--
-- This migration adds players.cut_at — a nullable timestamp set by
-- applyCut() to the moment a cut is persisted, and cleared (NULL) for
-- survivors. computeLeaderboard reads this column and forces madeCut=false
-- for any player with cut_at set.

ALTER TABLE "players"
  ADD COLUMN IF NOT EXISTS "cut_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "players_tournament_cut_at_idx"
  ON "players" ("tournament_id", "cut_at");
