-- Task #1263: Snapshot per-day projected revenue so forecast-accuracy
-- drill-downs can compare actual revenue against the day-level expectation
-- the forecaster actually produced (weekends, tier overrides, etc.) instead
-- of attributing the projected total evenly across the horizon.
--
-- Stored as a jsonb array of `{ day: 'YYYY-MM-DD', revenue: number }` entries
-- written at snapshot time. Days the forecaster expected no slots on are
-- omitted from the array (the drill-down treats missing days as a 0
-- projection). Existing rows leave the column NULL; the drill-down endpoint
-- falls back to the legacy flat-distribution behaviour in that case so
-- pre-migration forecasts continue to render.
--
-- Idempotent so it is safe to re-run on databases that may have been touched
-- by drizzle-kit push during development.

ALTER TABLE tee_pricing_forecasts
  ADD COLUMN IF NOT EXISTS projected_revenue_by_day jsonb;
