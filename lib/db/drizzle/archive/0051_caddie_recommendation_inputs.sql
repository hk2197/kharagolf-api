-- Task #488: Persist elevation and lie inputs with each AI Caddie suggestion
--
-- The recommendation engine adjusts effective yardage for elevation change and
-- biases the club pick by lie type, but neither input was being saved on the
-- caddie_recommendations row. Storing them lets us audit a suggestion after
-- the fact and slice accept/outcome stats by lie (e.g. "your bunker overrides
-- land closer than the suggestion") to feed future personalisation.


-- post-merge-guard: fresh-DB guard (table:caddie_recommendations)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'caddie_recommendations') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE caddie_recommendations
  ADD COLUMN IF NOT EXISTS elevation_delta_yards NUMERIC(6,1);

ALTER TABLE caddie_recommendations
  ADD COLUMN IF NOT EXISTS lie_type TEXT;

\else
\echo 'parent table caddie_recommendations not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

