-- Task #501 — Email fans their final prediction game score and rank.
--
-- Idempotency marker for the post-completion results email so that
-- re-completing a tournament (or repeated background sweeps) never
-- causes duplicate "you scored X, ranked #Y" emails.


-- post-merge-guard: fresh-DB guard (table:tournament_predictions)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournament_predictions') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "tournament_predictions"
  ADD COLUMN IF NOT EXISTS "results_email_sent_at" timestamp with time zone;

\else
\echo 'parent table tournament_predictions not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

