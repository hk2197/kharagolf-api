-- Migration 0078 — drop duplicate short-form wallet FK constraints.
--
-- Migration 0076 attempted to RENAME the short-form FK constraints
-- ("..._fk") that Task #770 created via raw SQL into drizzle's long-form
-- naming. However, a parallel task had already created the long-form
-- constraints alongside the short ones, so 0076's "rename only if target
-- doesn't exist" guard skipped the rename. The DB now has BOTH names for
-- each FK, and drizzle introspect keeps wanting to drop the short-form
-- duplicates.
--
-- Drop the short-form duplicates so the live DB matches the schema.
-- Each short-name constraint is the exact same FK as its long-name
-- twin (same columns, same target), so dropping is non-destructive.


-- post-merge-guard: fresh-DB guard (table:club_wallet_withdrawals)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'club_wallet_withdrawals') AS post_merge_dep_present \gset
\if :post_merge_dep_present

BEGIN;

ALTER TABLE "club_wallet_withdrawals" DROP CONSTRAINT IF EXISTS "club_wallet_withdrawals_wallet_fk";
ALTER TABLE "club_wallet_withdrawals" DROP CONSTRAINT IF EXISTS "club_wallet_withdrawals_org_fk";
ALTER TABLE "club_wallet_withdrawals" DROP CONSTRAINT IF EXISTS "club_wallet_withdrawals_user_fk";
ALTER TABLE "club_wallet_withdrawals" DROP CONSTRAINT IF EXISTS "club_wallet_withdrawals_debit_txn_fk";
ALTER TABLE "club_wallet_withdrawals" DROP CONSTRAINT IF EXISTS "club_wallet_withdrawals_refund_txn_fk";
ALTER TABLE "club_wallet_withdrawals" DROP CONSTRAINT IF EXISTS "club_wallet_withdrawals_payout_account_fk";

ALTER TABLE "wallet_payout_accounts" DROP CONSTRAINT IF EXISTS "wallet_payout_accounts_org_fk";
ALTER TABLE "wallet_payout_accounts" DROP CONSTRAINT IF EXISTS "wallet_payout_accounts_user_fk";

COMMIT;

\else
\echo 'parent table club_wallet_withdrawals not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

