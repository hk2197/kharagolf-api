-- Task #1222 — Record admin-triggered payout re-verifications in the
-- audit trail.
--
-- The new `POST /admin/coaches/:proId/payout-account/reverify` endpoint
-- runs the same Razorpay validation the nightly cron does, but unlike a
-- coach-initiated payout-account change it did not write a row to
-- `coach_payout_account_history`. That made it hard to answer
-- compliance questions like "who triggered the re-check that flipped
-- this coach to needs_attention and when?".
--
-- We now persist an audit row (with admin user id, ip, user-agent, and
-- the resulting outcome/reason) for every admin re-verify call. The
-- `change_kind` column already exists as a free-text field; the new
-- `'admin_reverify'` value just slots in alongside the existing
-- `'created'` / `'updated'` values, so no enum change is needed. We
-- only need two new columns to carry the verification outcome + reason
-- snapshot — null for legacy rows.


-- post-merge-guard: fresh-DB guard (table:coach_payout_account_history)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'coach_payout_account_history') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "coach_payout_account_history"
  ADD COLUMN IF NOT EXISTS "verification_outcome" text;
ALTER TABLE "coach_payout_account_history"
  ADD COLUMN IF NOT EXISTS "verification_reason" text;

\else
\echo 'parent table coach_payout_account_history not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

