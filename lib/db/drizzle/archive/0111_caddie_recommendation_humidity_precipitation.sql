-- Task #1347 — Capture per-round humidity & precipitation so the weather
-- correlation endpoint can bucket rounds by muggy and rainy conditions in
-- addition to wind and temperature.
--
-- Adds `humidity` (% relative, 0-100) and `precipitation` (mm in the last
-- hour) columns to caddie_recommendations. The /portal/caddie/recommend
-- route stamps these with the current observed values returned by
-- getWeather() (15-min in-memory cached) whenever the course's coordinates
-- can be resolved from the tournament or general-play round context.
-- computeWeatherCorrelation then averages these per-round values so the
-- Stats > Shot Analytics screen can show how scoring shifts in muggy /
-- rainy conditions for the same trailing window.

-- post-merge-guard: fresh-DB guard (table:caddie_recommendations)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'caddie_recommendations') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "caddie_recommendations"
  ADD COLUMN IF NOT EXISTS "humidity" numeric(5, 2);

ALTER TABLE "caddie_recommendations"
  ADD COLUMN IF NOT EXISTS "precipitation" numeric(6, 2);

\else
\echo 'parent table caddie_recommendations not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

