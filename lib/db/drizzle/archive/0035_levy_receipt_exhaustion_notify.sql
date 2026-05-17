-- Task #269: De-duplication markers for the admin alert that fires when the
-- levy-receipt push or SMS retry cap is reached. Stamped the first time
-- admins are notified for a given attempt + channel so the same exhaustion
-- isn't announced again on subsequent cron passes.


-- post-merge-guard: fresh-DB guard (table:member_levy_receipt_attempts)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_levy_receipt_attempts') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_levy_receipt_attempts
  ADD COLUMN IF NOT EXISTS push_exhaustion_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_exhaustion_notified_at  TIMESTAMPTZ;

\else
\echo 'parent table member_levy_receipt_attempts not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

