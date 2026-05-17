-- Task 176: Privacy-request notification delivery tracking
-- Track per-channel delivery for privacy-request acknowledgement and status emails,
-- so admins can see in the data-request detail view whether the email was sent and
-- whether an in-app fallback message was created (in_app messages always send so a
-- bounced email does not become a regulatory gap).


-- post-merge-guard: fresh-DB guard (table:member_data_requests)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_data_requests') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_data_requests
  ADD COLUMN IF NOT EXISTS last_notification_kind TEXT,
  ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_email_status TEXT,
  ADD COLUMN IF NOT EXISTS last_email_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_email_error TEXT,
  ADD COLUMN IF NOT EXISTS last_in_app_message_id INTEGER REFERENCES member_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_in_app_at TIMESTAMPTZ;

\else
\echo 'parent table member_data_requests not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

