-- Task 261: De-duplication markers for the admin alerts that fire when the
-- privacy-notice push or SMS retry caps are reached. Mirror the email
-- exhaustion stamp added in Task 238 so push and SMS reach parity.


-- post-merge-guard: fresh-DB guard (table:member_data_requests)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_data_requests') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_data_requests
  ADD COLUMN IF NOT EXISTS push_exhaustion_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_exhaustion_notified_at TIMESTAMPTZ;

\else
\echo 'parent table member_data_requests not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

