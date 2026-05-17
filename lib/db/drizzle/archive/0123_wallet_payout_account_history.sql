-- Task #1518 — Audit trail of admin-triggered re-verifications of a
-- member's wallet payout account.
--
-- Mirrors `coach_payout_account_history` (Task #764 / #1222) so we can
-- answer the same compliance question for wallet payouts as we already
-- can for coach payouts: "who triggered the re-check that flipped this
-- member to needs_attention?".
--
-- Today's only writer is the admin re-verify endpoint at
-- `POST /admin/wallet/payout-accounts/:id/reverify` (Task #1289), so
-- every row is an `admin_reverify`. The schema mirrors the coach
-- equivalent — free-text `change_kind` + masked snapshot columns —
-- so we can fold member self-save events ('created' / 'updated') in
-- later without another migration.


-- post-merge-guard: fresh-DB guard (table:wallet_payout_accounts)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wallet_payout_accounts') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "wallet_payout_account_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "wallet_payout_account_id" integer NOT NULL,
  "organization_id" integer NOT NULL,
  "user_id" integer,
  "changed_by_user_id" integer,
  "changed_by_role" text DEFAULT 'admin' NOT NULL,
  "change_kind" text DEFAULT 'admin_reverify' NOT NULL,
  "method" text NOT NULL,
  "account_holder_name" text,
  "upi_vpa_masked" text,
  "bank_account_last4" text,
  "bank_ifsc" text,
  "razorpay_contact_id" text,
  "razorpay_fund_account_id" text,
  "verification_outcome" text,
  "verification_reason" text,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "wallet_payout_account_history"
    ADD CONSTRAINT "wallet_payout_acct_hist_acct_fk"
    FOREIGN KEY ("wallet_payout_account_id")
    REFERENCES "wallet_payout_accounts"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_payout_account_history"
    ADD CONSTRAINT "wallet_payout_acct_hist_org_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_payout_account_history"
    ADD CONSTRAINT "wallet_payout_acct_hist_user_fk"
    FOREIGN KEY ("user_id")
    REFERENCES "app_users"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Short FK name: the auto-generated
-- `wallet_payout_account_history_changed_by_user_id_app_users_id_fk`
-- (64 chars) would be silently truncated by Postgres. See task #805
-- and `lib/db/scripts/check-fk-names.ts`.
DO $$ BEGIN
  ALTER TABLE "wallet_payout_account_history"
    ADD CONSTRAINT "wallet_payout_acct_hist_changed_by_fk"
    FOREIGN KEY ("changed_by_user_id")
    REFERENCES "app_users"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "wallet_payout_acct_hist_acct_idx"
  ON "wallet_payout_account_history" USING btree ("wallet_payout_account_id", "created_at");
CREATE INDEX IF NOT EXISTS "wallet_payout_acct_hist_org_idx"
  ON "wallet_payout_account_history" USING btree ("organization_id");
CREATE INDEX IF NOT EXISTS "wallet_payout_acct_hist_user_idx"
  ON "wallet_payout_account_history" USING btree ("user_id");

\else
\echo 'parent table wallet_payout_accounts not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

