-- Task 220: per-channel resend audits store structured per-channel
-- { status, at, error } objects in member_audit_log.metadata so the resend
-- history popover can render hover tooltips with timestamps and provider
-- error messages without re-parsing the free-form `reason` string.


-- post-merge-guard: fresh-DB guard (table:member_audit_log)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_audit_log') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_audit_log
  ADD COLUMN IF NOT EXISTS metadata JSONB;

\else
\echo 'parent table member_audit_log not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

