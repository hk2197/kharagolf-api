-- Task 222: persist receipt-email delivery status on each levy charge so
-- admins see whether the most recent payment / refund / waiver receipt
-- actually went out, was skipped, or failed — and can resend it manually.


-- post-merge-guard: fresh-DB guard (table:member_levy_charges)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_levy_charges') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_levy_charges
  ADD COLUMN IF NOT EXISTS last_receipt_status TEXT,
  ADD COLUMN IF NOT EXISTS last_receipt_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_receipt_kind TEXT,
  ADD COLUMN IF NOT EXISTS last_receipt_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS last_receipt_note TEXT,
  ADD COLUMN IF NOT EXISTS last_receipt_at TIMESTAMP WITH TIME ZONE;

\else
\echo 'parent table member_levy_charges not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

