-- Task 238: De-duplication marker for the admin alert that fires when the
-- privacy-notice email retry cap is reached. Stamped the first time admins
-- are notified so the same exhaustion isn't announced again on subsequent
-- cron passes.


-- post-merge-guard: fresh-DB guard (table:member_data_requests)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_data_requests') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_data_requests
  ADD COLUMN IF NOT EXISTS email_exhaustion_notified_at TIMESTAMPTZ;

\else
\echo 'parent table member_data_requests not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

