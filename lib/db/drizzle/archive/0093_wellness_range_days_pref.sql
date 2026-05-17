-- Task #1091 — persist the wellness dashboard's 30/60/90-day range selector
-- on the user's profile so the choice syncs across devices (mirrors Task #946
-- which persisted the trailing-round window for the scoring-average overlay).

-- post-merge-guard: fresh-DB guard (table:user_health_prefs)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_health_prefs') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "user_health_prefs"
  ADD COLUMN IF NOT EXISTS "wellness_range_days" integer;

\else
\echo 'parent table user_health_prefs not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

