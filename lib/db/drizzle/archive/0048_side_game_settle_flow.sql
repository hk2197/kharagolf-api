-- Task #455 — settle-up payment flow with wallet/UPI for side game debts.


-- post-merge-guard: fresh-DB guard (table:side_game_settlements)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'side_game_settlements') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "side_game_settlements"
  ADD COLUMN IF NOT EXISTS "razorpay_order_id" text;

CREATE TABLE IF NOT EXISTS "club_wallets" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "currency" text NOT NULL DEFAULT 'INR',
  "balance" numeric(12, 2) NOT NULL DEFAULT '0',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "club_wallets_org_user_currency_unique"
  ON "club_wallets" ("organization_id", "user_id", "currency");
CREATE INDEX IF NOT EXISTS "club_wallets_user_idx" ON "club_wallets" ("user_id");

CREATE TABLE IF NOT EXISTS "club_wallet_txns" (
  "id" serial PRIMARY KEY,
  "wallet_id" integer NOT NULL REFERENCES "club_wallets"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "amount" numeric(12, 2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'INR',
  "source_type" text NOT NULL,
  "source_id" text,
  "payment_ref" text,
  "note" text,
  "balance_after" numeric(12, 2) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "club_wallet_txns_wallet_idx"
  ON "club_wallet_txns" ("wallet_id", "created_at");
CREATE INDEX IF NOT EXISTS "club_wallet_txns_source_idx"
  ON "club_wallet_txns" ("source_type", "source_id");

\else
\echo 'parent table side_game_settlements not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

