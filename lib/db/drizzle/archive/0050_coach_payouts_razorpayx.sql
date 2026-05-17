-- Task #465: Automate coach payouts via RazorpayX
--
-- Extends the marketplace profile with the payout-account fields a coach
-- registers from the Coach Workspace, plus the Razorpay contact id created
-- on first save (the existing `payout_account_id` column now holds the
-- Razorpay fund_account id).  Adds bookkeeping columns to `coach_payouts`
-- so the new pipeline can record disbursement attempts and surface failure
-- reasons in the admin tab.


-- post-merge-guard: fresh-DB guard (table:coach_marketplace_profiles)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'coach_marketplace_profiles') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "coach_marketplace_profiles"
  ADD COLUMN IF NOT EXISTS "payout_method" text,
  ADD COLUMN IF NOT EXISTS "payout_vpa" text,
  ADD COLUMN IF NOT EXISTS "payout_bank_account_number" text,
  ADD COLUMN IF NOT EXISTS "payout_bank_ifsc" text,
  ADD COLUMN IF NOT EXISTS "payout_account_holder_name" text,
  ADD COLUMN IF NOT EXISTS "razorpay_contact_id" text;

ALTER TABLE "coach_payouts"
  ADD COLUMN IF NOT EXISTS "attempted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "failure_reason" text,
  ADD COLUMN IF NOT EXISTS "payout_mode" text;

\else
\echo 'parent table coach_marketplace_profiles not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

