-- Task #1346 — Persistent per-round historical-weather cache.
--
-- The Stats > Shot Analytics temperature chart populates from
-- `caddie_recommendations.temperature` for fresh rounds (Task #1167) and
-- from a live `getHistoricalWeather()` call for rounds older than
-- Open-Meteo's 5-day archive delay. That live call is repeated on every
-- request and yields nothing for older rounds the in-memory cache has
-- already evicted, so the chart can still look empty.
--
-- This table is the persistent backing store. The
-- `backfill:round-weather-cache` script writes one row per
-- (tournament_id|general_play_round_id, round) with the daily mean temp
-- and daily max wind for the course's lat/lng on the round's local date.
-- `computeWeatherCorrelation` reads from it before falling back to the
-- live archive call.
--
-- Idempotent: wrapped in IF NOT EXISTS guards so reruns are safe.


-- post-merge-guard: fresh-DB guard (table:general_play_rounds)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'general_play_rounds') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "round_weather_cache" (
  "id" serial PRIMARY KEY,
  "tournament_id" integer REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "general_play_round_id" integer REFERENCES "general_play_rounds"("id") ON DELETE CASCADE,
  "round" integer NOT NULL DEFAULT 1,
  "course_id" integer REFERENCES "courses"("id") ON DELETE SET NULL,
  "observed_date" text NOT NULL,
  "temperature_mean" numeric(5, 2),
  "wind_speed_max" numeric(6, 2),
  "fetched_at" timestamp with time zone NOT NULL DEFAULT NOW()
);

-- One row per tournament round (when scoped to a tournament).
CREATE UNIQUE INDEX IF NOT EXISTS "round_weather_cache_tournament_unique"
  ON "round_weather_cache" ("tournament_id", "round")
  WHERE "tournament_id" IS NOT NULL;

-- One row per general-play round (when scoped to general play).
CREATE UNIQUE INDEX IF NOT EXISTS "round_weather_cache_gp_unique"
  ON "round_weather_cache" ("general_play_round_id", "round")
  WHERE "general_play_round_id" IS NOT NULL;

-- Quick lookups by date (used by the backfill's "trailing window" filter).
CREATE INDEX IF NOT EXISTS "round_weather_cache_observed_date_idx"
  ON "round_weather_cache" ("observed_date");

\else
\echo 'parent table general_play_rounds not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

