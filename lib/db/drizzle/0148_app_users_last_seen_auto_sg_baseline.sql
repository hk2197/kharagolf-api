-- Task #2048 — Auto-update SG baseline notice when handicap changes
-- significantly. Adds `last_seen_auto_sg_baseline` to `app_users` so the
-- stats endpoint can detect when the auto-derived strokes-gained baseline
-- has crossed a cohort threshold since the player's last visit
-- (e.g. handicap drops from 14.5 → 13.8 and the cohort moves from "18"
-- → "10") and surface a one-time `baselineChange` notice with a
-- "Pin previous baseline" shortcut.
--
-- Stored values mirror `pickPrimarySgBaseline` outputs: 'scratch' | '10'
-- | '18'. NULL means: no auto baseline has ever been seeded for this
-- player (either no handicap on file yet, or this is the first stats
-- fetch since the column was introduced — the stats endpoint lazily
-- seeds it on first sight to avoid showing a confusing "your baseline
-- moved" notice on day 1).
--
-- Wrapped in `IF NOT EXISTS` so reruns and fresh-DB bootstraps both
-- succeed (matches the idempotent style of every other migration here).

ALTER TABLE "app_users"
  ADD COLUMN IF NOT EXISTS "last_seen_auto_sg_baseline" text;
