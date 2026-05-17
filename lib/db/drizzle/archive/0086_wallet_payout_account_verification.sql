-- Task #965 — Verify a member's UPI or bank account before saving it.
--
-- Mirrors the columns added to coach_marketplace_profiles by Task #913 so
-- the verification semantics match for both payout flows.
-- A row whose verified_at IS NULL is NOT allowed to receive a withdrawal.


-- post-merge-guard: fresh-DB guard (table:wallet_payout_accounts)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wallet_payout_accounts') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "wallet_payout_accounts"
  ADD COLUMN IF NOT EXISTS "verified_at"               timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "verified_holder_name"      text,
  ADD COLUMN IF NOT EXISTS "verification_status"       text,
  ADD COLUMN IF NOT EXISTS "verification_failure_reason" text;

-- Backfill: members who already saved an account (and therefore got a
-- razorpay_fund_account_id) before this change were treated as verified,
-- so seed verified_at from updated_at and mark the status verified.
UPDATE "wallet_payout_accounts"
   SET "verified_at" = COALESCE("verified_at", "updated_at"),
       "verification_status" = COALESCE("verification_status", 'verified')
 WHERE "razorpay_fund_account_id" IS NOT NULL;

\else
\echo 'parent table wallet_payout_accounts not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

