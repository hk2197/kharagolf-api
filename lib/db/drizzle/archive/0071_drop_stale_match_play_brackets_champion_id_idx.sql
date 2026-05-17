-- Catch the test database up to the latest schema state (Task #804).
--
-- 1. Drop the stale `match_play_brackets_champion_id_idx` index.
--    Migration 0059_match_play_bracket_champion.sql created this index,
--    but the schema in `lib/db/src/schema/golf.ts` no longer declares
--    it. The live test DB therefore reported drift on every drift check
--    (DROP INDEX "match_play_brackets_champion_id_idx";).
--
-- 2. Ensure `tee_times.spectator_tee_off_alerted_at` exists. The column
--    was introduced by `0061_spectator_tee_off_alerted_at.sql` but had
--    not been applied everywhere; add it idempotently here so any DB
--    that missed the original migration also converges.
--
-- Both statements use IF (NOT) EXISTS so this migration is safe to
-- re-run on databases that already have the desired state.

DROP INDEX IF EXISTS "match_play_brackets_champion_id_idx";

ALTER TABLE "tee_times"
  ADD COLUMN IF NOT EXISTS "spectator_tee_off_alerted_at" timestamp with time zone;
