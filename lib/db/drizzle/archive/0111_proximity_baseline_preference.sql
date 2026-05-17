-- Task #1349 — Per-player preferred proximity benchmark baseline.
--
-- The proximity-by-club chart compares the player against three reference
-- baselines (PGA tour, scratch amateur, mid-handicap). Showing a 22-handicap
-- player a "tour" comparison every time is discouraging, so we pick the
-- "primary" baseline based on their handicap index automatically and let
-- them pin a different one as their preference. This column persists that
-- pinned choice across sessions and devices.
--
-- Allowed values: 'auto', 'tour', 'scratch', 'mid'.
--   - 'auto'  → derive the primary from the player's current handicap index
--   - others  → always use that baseline as the primary
-- NULL is treated as 'auto' so existing rows need no backfill.

ALTER TABLE "app_users"
  ADD COLUMN IF NOT EXISTS "preferred_proximity_baseline" text;
