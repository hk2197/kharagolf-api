-- Task #1356 — Replace the JSONB-key hack on
-- `coach_marketplace_profiles.certifications` with dedicated, typed
-- `coaches_handicap_min` / `coaches_handicap_max` columns.
--
-- Why:
--   The marketplace handicap filter (`/api/coach-marketplace/coaches?handicap=…`)
--   was reading `certifications->>'coachesHandicapMin'` /
--   `…HandicapMax` from a column the Drizzle schema declares as
--   `string[]`. Postgres returns NULL when you key into a JSON array,
--   so the filter "default-passed" any coach whose certifications were
--   genuinely a list — but a coach whose cert list happened to contain
--   `"coachesHandicapMin"` would have been silently misinterpreted.
--   This migration moves the filter onto two real numeric columns,
--   backfills any object-shaped rows the live DB carries, and
--   normalises those rows' `certifications` back to an empty array so
--   the schema and the data finally agree.
--
-- Steps:
--   1. ADD COLUMN coaches_handicap_min  numeric(4,1) NULL.
--   2. ADD COLUMN coaches_handicap_max  numeric(4,1) NULL.
--   3. Backfill from `certifications` whenever it's a JSONB OBJECT
--      carrying `coachesHandicapMin` / `coachesHandicapMax` keys.
--      Treats missing keys as NULL (i.e. "no bound"), matching the
--      route's prior IS NULL → default-pass behaviour.
--   4. Reset `certifications` to '[]'::jsonb on those object-shaped
--      rows so the column finally matches its declared `string[]`
--      type. Leaves array-shaped rows untouched.
--   5. CREATE INDEX coach_marketplace_handicap_idx (min, max) for the
--      filter's bounded-range scans.
--
-- All statements are idempotent so post-merge.sh's IF-EXISTS-style
-- re-run loop converges cleanly.


-- post-merge-guard: fresh-DB guard (table:coach_marketplace_profiles)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'coach_marketplace_profiles') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "coach_marketplace_profiles"
  ADD COLUMN IF NOT EXISTS "coaches_handicap_min" numeric(4, 1);

ALTER TABLE "coach_marketplace_profiles"
  ADD COLUMN IF NOT EXISTS "coaches_handicap_max" numeric(4, 1);

-- Backfill from any rows whose `certifications` JSONB is an object
-- carrying the legacy keys. `jsonb_typeof` filters out the (typed)
-- array shape so we never try to ->> a list. Casting via NULLIF avoids
-- failing on rows where the key is present but empty/null.
UPDATE "coach_marketplace_profiles"
SET
  "coaches_handicap_min" = COALESCE(
    "coaches_handicap_min",
    NULLIF("certifications"->>'coachesHandicapMin', '')::numeric
  ),
  "coaches_handicap_max" = COALESCE(
    "coaches_handicap_max",
    NULLIF("certifications"->>'coachesHandicapMax', '')::numeric
  )
WHERE jsonb_typeof("certifications") = 'object';

-- Normalise any object-shaped certifications rows back to the declared
-- `string[]` shape. The handicap range now lives in dedicated columns
-- so the JSONB object is no longer needed; leaving it would defeat the
-- whole point of this migration.
UPDATE "coach_marketplace_profiles"
SET "certifications" = '[]'::jsonb
WHERE jsonb_typeof("certifications") = 'object';

CREATE INDEX IF NOT EXISTS "coach_marketplace_handicap_idx"
  ON "coach_marketplace_profiles" ("coaches_handicap_min", "coaches_handicap_max");

\else
\echo 'parent table coach_marketplace_profiles not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

