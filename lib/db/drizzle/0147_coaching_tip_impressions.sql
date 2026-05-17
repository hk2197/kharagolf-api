-- Task #2045 — Track when players see a "Work on This Club" coaching tip,
-- not just when they act on one.
--
-- Background. Task #1641 already tags acted-on tips by setting
-- `practice_sessions.source = 'coaching_tip'` (with `club_key` and
-- `practice_distance_yards`) when a session is logged from the deep-link
-- on the tip card. That gives us *tip-driven session volume*, but the
-- real signal we want is the conversion rate
--
--     conversion = practice_sessions(source='coaching_tip')
--                / coaching_tip_impressions
--
-- per club + date range, so we can tell whether the callout is actually
-- nudging players to practice the club we flagged. Without an impression
-- count we can only measure the numerator.
--
-- This table records one row per render of a tip card, deduped per
-- session client-side so a single user scrolling the stats page back and
-- forth doesn't inflate the denominator. Rows are intentionally
-- lightweight — we keep the canonical `club_key` (matches
-- `practice_sessions.club_key`, so the conversion-rate join works
-- without re-resolving labels) and the suggested practice distance the
-- tip rendered with at impression time.
--
-- IF NOT EXISTS guards on the table + indexes so a partial replay
-- during a deploy retry is safe.

CREATE TABLE IF NOT EXISTS "coaching_tip_impressions" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "club_key" text NOT NULL,
  "practice_distance_yards" integer,
  "shown_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $do$ BEGIN
  ALTER TABLE "coaching_tip_impressions"
    ADD CONSTRAINT "coaching_tip_impressions_user_id_app_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $do$;

-- Conversion-rate roll-ups walk by (club_key, shown_at). Dashboards
-- typically also slice by user; index both access patterns.
CREATE INDEX IF NOT EXISTS "coaching_tip_impressions_club_idx"
  ON "coaching_tip_impressions" ("club_key", "shown_at");
CREATE INDEX IF NOT EXISTS "coaching_tip_impressions_user_idx"
  ON "coaching_tip_impressions" ("user_id", "shown_at");
