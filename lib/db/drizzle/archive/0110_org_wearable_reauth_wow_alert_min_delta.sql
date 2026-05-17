-- Task #1325 — Per-org override for the weekly week-over-week needs_reauth
-- drift threshold consumed by `evaluateWeeklyReauthDrift` in
-- `artifacts/api-server/src/lib/wearables.ts`.
--
-- Larger clubs may want a higher delta floor (e.g. 5 flips/sweep) before
-- being paged; smaller clubs may want to be alerted on any drift. NULL
-- means "inherit the system-wide default" — the `WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA`
-- env var (falling back to the hardcoded `WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA`).
--
-- The column is intentionally nullable WITHOUT a hardcoded default. Seeding
-- a default of 1.00 would freeze every existing org at 1.00 and silently
-- bypass any future change to the env-var default for orgs that never
-- touched the field. Existing orgs therefore continue to use the env
-- fallback exactly as they did before this column existed.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "wearable_reauth_wow_alert_min_delta" numeric(6, 2);

-- Re-run safety: if a prior version of this migration created the column
-- with `NOT NULL DEFAULT 1.00`, relax it back to the inherit-by-default
-- shape. Idempotent — `DROP DEFAULT` / `DROP NOT NULL` are no-ops if the
-- column is already in the target state.
ALTER TABLE "organizations"
  ALTER COLUMN "wearable_reauth_wow_alert_min_delta" DROP DEFAULT;
ALTER TABLE "organizations"
  ALTER COLUMN "wearable_reauth_wow_alert_min_delta" DROP NOT NULL;
