-- Task #770 — Let members withdraw their wallet balance back to UPI/bank.
--
-- Two new tables:
--   wallet_payout_accounts        — one saved UPI / bank account per
--                                   (organization, user). Holds the
--                                   RazorpayX contact + fund-account ids.
--   club_wallet_withdrawals       — one row per withdrawal request.
--                                   Tracks RazorpayX payout lifecycle
--                                   (queued → processing → processed |
--                                   failed | reversed) and links to the
--                                   debit / refund wallet ledger entries.


-- post-merge-guard: fresh-DB guard (table:club_wallets)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'club_wallets') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "wallet_payout_accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "method" text NOT NULL,
  "account_holder_name" text NOT NULL,
  "upi_vpa" text,
  "bank_account_number" text,
  "bank_ifsc" text,
  "razorpay_contact_id" text,
  "razorpay_fund_account_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "wallet_payout_accounts"
    ADD CONSTRAINT "wallet_payout_accounts_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_payout_accounts"
    ADD CONSTRAINT "wallet_payout_accounts_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_payout_accounts_org_user_unique"
  ON "wallet_payout_accounts" ("organization_id", "user_id");


CREATE TABLE IF NOT EXISTS "club_wallet_withdrawals" (
  "id" serial PRIMARY KEY NOT NULL,
  "wallet_id" integer NOT NULL,
  "organization_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "amount" numeric(12, 2) NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "method" text NOT NULL,
  "payout_account_id" integer,
  "razorpay_fund_account_id" text,
  "razorpay_payout_id" text,
  "payout_mode" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "failure_reason" text,
  "utr" text,
  "debit_txn_id" integer,
  "refund_txn_id" integer,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attempted_at" timestamp with time zone,
  "processed_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "club_wallet_withdrawals"
    ADD CONSTRAINT "club_wallet_withdrawals_wallet_fk"
    FOREIGN KEY ("wallet_id") REFERENCES "public"."club_wallets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "club_wallet_withdrawals"
    ADD CONSTRAINT "club_wallet_withdrawals_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "club_wallet_withdrawals"
    ADD CONSTRAINT "club_wallet_withdrawals_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "club_wallet_withdrawals"
    ADD CONSTRAINT "club_wallet_withdrawals_payout_account_fk"
    FOREIGN KEY ("payout_account_id") REFERENCES "public"."wallet_payout_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "club_wallet_withdrawals"
    ADD CONSTRAINT "club_wallet_withdrawals_debit_txn_fk"
    FOREIGN KEY ("debit_txn_id") REFERENCES "public"."club_wallet_txns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "club_wallet_withdrawals"
    ADD CONSTRAINT "club_wallet_withdrawals_refund_txn_fk"
    FOREIGN KEY ("refund_txn_id") REFERENCES "public"."club_wallet_txns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "club_wallet_withdrawals_user_idx"
  ON "club_wallet_withdrawals" ("user_id", "organization_id", "requested_at");
CREATE INDEX IF NOT EXISTS "club_wallet_withdrawals_status_idx"
  ON "club_wallet_withdrawals" ("status");
CREATE INDEX IF NOT EXISTS "club_wallet_withdrawals_razorpay_payout_idx"
  ON "club_wallet_withdrawals" ("razorpay_payout_id");

\else
\echo 'parent table club_wallets not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

