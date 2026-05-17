-- Task 187: Fan-out privacy-request notices to push and SMS for opted-in members.
-- Track per-channel delivery so a single bounced email never becomes a
-- regulatory gap and admins can audit each channel from the Member 360 view.


-- post-merge-guard: fresh-DB guard (table:member_data_requests)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_data_requests') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_data_requests
  ADD COLUMN IF NOT EXISTS last_push_status TEXT,
  ADD COLUMN IF NOT EXISTS last_push_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_push_error TEXT,
  ADD COLUMN IF NOT EXISTS last_sms_status TEXT,
  ADD COLUMN IF NOT EXISTS last_sms_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sms_error TEXT;

\else
\echo 'parent table member_data_requests not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

