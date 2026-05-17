-- Task #1507 — daily admin digest of exhausted wallet/coach-payout
-- notify retries.
--
-- Adds an `admin_digest_sent_at` watermark column to both retry-attempts
-- tables. The new `sendNotifyExhaustionAdminDigest` cron sweeps rows
-- where any `*_retry_exhausted_at` was stamped in the last 24h and
-- `admin_digest_sent_at IS NULL`, groups by org, emails the admins, and
-- stamps the column on every included row so the next daily tick never
-- emails the same row twice.


-- post-merge-guard: fresh-DB guard (table:coach_payout_account_change_notify_attempts)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'coach_payout_account_change_notify_attempts') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "wallet_topup_refund_notify_attempts"
  ADD COLUMN IF NOT EXISTS "admin_digest_sent_at" timestamp with time zone;

ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "admin_digest_sent_at" timestamp with time zone;

\else
\echo 'parent table coach_payout_account_change_notify_attempts not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

