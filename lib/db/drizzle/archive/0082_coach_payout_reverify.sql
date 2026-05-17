-- Task #913 — Periodic re-verification of coach payout accounts.
--
-- A VPA can be deactivated or a bank account can be closed long after the
-- coach first registered it. We re-run the same Razorpay validation on a
-- schedule and record the outcome on the marketplace profile so:
--   * the auto-payout job can skip accounts whose latest re-validation
--     failed ("needs_attention");
--   * the coach workspace can show a banner asking the coach to re-verify;
--   * the next save through /me/payout-account resets the timestamp +
--     status back to "verified".


-- post-merge-guard: fresh-DB guard (table:coach_marketplace_profiles)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'coach_marketplace_profiles') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "coach_marketplace_profiles"
  ADD COLUMN IF NOT EXISTS "payout_verified_at"               timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "payout_verification_status"       text,
  ADD COLUMN IF NOT EXISTS "payout_verification_failure_reason" text;

-- Backfill: coaches who already have a saved fund account were verified
-- at the moment they saved it (Task #763), so seed the timestamp from
-- `updated_at` and mark the status verified. The cron then treats them
-- like any other coach and re-validates once N days have elapsed.
UPDATE "coach_marketplace_profiles"
   SET "payout_verified_at" = COALESCE("payout_verified_at", "updated_at"),
       "payout_verification_status" = COALESCE("payout_verification_status", 'verified')
 WHERE "payout_account_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "coach_marketplace_payout_verified_idx"
  ON "coach_marketplace_profiles" ("payout_verified_at");

\else
\echo 'parent table coach_marketplace_profiles not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

