-- Task #1279 — proactively page org admins exactly once per
-- (withdrawal × outcome) attempts row when the bounded retry pipeline
-- on any channel gives up (or a hard-bounce SMTP response short-circuits
-- straight to exhausted on the first attempt).
--
-- The retry cron stamps this column with the moment the admin alert is
-- dispatched and uses an atomic conditional UPDATE on
-- `WHERE admin_exhaustion_notified_at IS NULL` so two concurrent passes
-- (or the first-attempt hard-bounce path racing with the cron) cannot
-- fire the alert twice for the same withdrawal.

-- post-merge-guard: fresh-DB guard (table:wallet_withdrawal_notify_attempts)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wallet_withdrawal_notify_attempts') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "wallet_withdrawal_notify_attempts"
  ADD COLUMN IF NOT EXISTS "admin_exhaustion_notified_at" timestamptz;

\else
\echo 'parent table wallet_withdrawal_notify_attempts not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

