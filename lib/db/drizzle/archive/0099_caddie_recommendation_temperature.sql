-- Task #1167 — Capture per-round temperature so weather correlation can include it.
--
-- Adds a `temperature` column (°C, two decimal places) to caddie_recommendations.
-- The /portal/caddie/recommend route stamps this with the current observed
-- temperature returned by getWeather() (15-min in-memory cached) whenever the
-- course's coordinates can be resolved from the tournament or general-play
-- round context. computeWeatherCorrelation then averages these per-round values
-- as the primary temperature source for /portal/player/weather-correlation,
-- so the Stats > Shot Analytics temperature chart populates immediately for
-- recently-played rounds even when the Open-Meteo archive (5-day delayed)
-- has no observation yet.

-- post-merge-guard: fresh-DB guard (table:caddie_recommendations)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'caddie_recommendations') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "caddie_recommendations"
  ADD COLUMN IF NOT EXISTS "temperature" numeric(5, 2);

\else
\echo 'parent table caddie_recommendations not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

