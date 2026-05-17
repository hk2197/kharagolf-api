-- Task #383 — Public player profiles & shareable scorecards
-- Adds opt-in public profile fields to app_users and a per-scorecard hide flag to players.

ALTER TABLE "app_users"
  ADD COLUMN IF NOT EXISTS "public_handle" text,
  ADD COLUMN IF NOT EXISTS "public_profile_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "public_show_handicap" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "public_show_recent_rounds" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "public_show_achievements" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "public_show_favorite_courses" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "public_bio" text,
  ADD COLUMN IF NOT EXISTS "public_location" text;

CREATE UNIQUE INDEX IF NOT EXISTS "app_users_public_handle_unique"
  ON "app_users" ("public_handle");

ALTER TABLE "players"
  ADD COLUMN IF NOT EXISTS "public_hidden" boolean NOT NULL DEFAULT false;
