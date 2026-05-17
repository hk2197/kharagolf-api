-- Task 191: Track per-channel retry attempts for privacy-request push and SMS
-- notices, so a scheduled job can re-attempt failed deliveries a bounded
-- number of times. Mirrors the email retry pattern: attempts are recorded on
-- the request row and surfaced in the Member 360 view.


-- post-merge-guard: fresh-DB guard (table:member_data_requests)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_data_requests') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_data_requests
  ADD COLUMN IF NOT EXISTS push_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sms_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_push_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sms_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS push_retry_exhausted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_retry_exhausted_at TIMESTAMPTZ;

\else
\echo 'parent table member_data_requests not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

