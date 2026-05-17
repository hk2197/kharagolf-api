-- Task #2259 — Email admins automatically when a logo or favicon stops
-- refreshing. The Task #1467 refresh job preserves the cached copy when
-- the upstream source is unreachable so the public mini-site keeps
-- rendering, but admins only saw the staleness if they happened to open
-- the marketing-site editor (Task #1807). Add per-source consecutive-
-- failure counters so the refresh job can mirror the Task #1249
-- background re-verifier's notification posture: increment on every
-- failed refresh attempt, reset on a successful refresh OR when the
-- admin pastes a new URL through the editor, and email + push the org
-- admins exactly once when the count crosses the notify threshold.
-- Subsequent failures keep the counter climbing but DON'T re-notify so
-- admins aren't spammed every cron tick. Existing rows default to 0 so
-- a clean DB and an upgrade-in-place both start from a fresh streak.
ALTER TABLE "club_marketing_sites"
  ADD COLUMN IF NOT EXISTS "logo_source_consecutive_refresh_failures" integer NOT NULL DEFAULT 0;
ALTER TABLE "club_marketing_sites"
  ADD COLUMN IF NOT EXISTS "favicon_source_consecutive_refresh_failures" integer NOT NULL DEFAULT 0;
