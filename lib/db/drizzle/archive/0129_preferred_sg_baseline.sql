-- Task #1643 — Match strokes-gained baseline to each player's handicap
-- automatically. Adds a per-player pinned override for the SG baseline
-- chart, mirroring `preferred_proximity_baseline` (Task #1349).
--
-- Allowed values are 'scratch' | '10' | '18' | 'auto'. NULL or 'auto'
-- means "derive the baseline from the player's current handicap index"
-- (≤4 → scratch, ≤12 → 10-hcp, otherwise 18-hcp; thresholds mirror
-- `pickPrimaryProximityBaseline`). Stored as text rather
-- than an enum so we can extend the cohort list later without a column
-- migration (the API endpoint validates against the allow-list).

ALTER TABLE "app_users"
  ADD COLUMN IF NOT EXISTS "preferred_sg_baseline" text;
