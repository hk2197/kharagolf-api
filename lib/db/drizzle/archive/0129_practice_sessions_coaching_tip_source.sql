-- Task #1641 — let players tap a coaching tip to log a practice session for that club.
--
-- The "Work on This Club" callout (Task #1348) tells a player exactly what to
-- work on and at what distance. Tapping its new "Log practice" CTA pre-fills
-- the practice logger with the canonical clubKey + suggested practice distance
-- and tags the session as `source = 'coaching_tip'` so we can later A/B-test
-- whether tip-driven practice closes the proximity gap faster than ad-hoc
-- range time.
--
-- All three columns are nullable: pre-existing rows are implicitly "manual"
-- and have no captured club_key / practice_distance_yards.

ALTER TABLE "practice_sessions" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "practice_sessions" ADD COLUMN IF NOT EXISTS "practice_distance_yards" integer;
ALTER TABLE "practice_sessions" ADD COLUMN IF NOT EXISTS "club_key" text;

CREATE INDEX IF NOT EXISTS "practice_sessions_source_idx"
  ON "practice_sessions" ("source");
