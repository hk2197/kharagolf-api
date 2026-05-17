-- Task #105: Staff Commission Tracking


-- post-merge-guard: fresh-DB guard (table:pos_transactions)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pos_transactions') AS post_merge_dep_present \gset
\if :post_merge_dep_present

DO $$ BEGIN
  CREATE TYPE "commission_type" AS ENUM ('percentage', 'flat_per_sale');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "commission_source" AS ENUM ('pos', 'lesson');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "commission_payout_status" AS ENUM ('pending', 'approved', 'paid', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "commission_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "staff_user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "category" text,
  "commission_type" "commission_type" NOT NULL DEFAULT 'percentage',
  "rate" numeric(10, 4) NOT NULL,
  "source" "commission_source" NOT NULL,
  "tier_threshold_amount" numeric(10, 2),
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "commission_rules_org_idx" ON "commission_rules" ("organization_id");
CREATE INDEX IF NOT EXISTS "commission_rules_staff_idx" ON "commission_rules" ("staff_user_id");

CREATE TABLE IF NOT EXISTS "sales_attributions" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "staff_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "source" "commission_source" NOT NULL,
  "pos_transaction_id" integer REFERENCES "pos_transactions"("id") ON DELETE SET NULL,
  "lesson_booking_id" integer REFERENCES "lesson_bookings"("id") ON DELETE SET NULL,
  "sale_amount" numeric(10, 2) NOT NULL,
  "category" text,
  "commission_rule_id" integer REFERENCES "commission_rules"("id") ON DELETE SET NULL,
  "commission_amount" numeric(10, 2) NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'INR',
  "payout_id" integer,
  "attributed_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "sales_attributions_org_idx" ON "sales_attributions" ("organization_id");
CREATE INDEX IF NOT EXISTS "sales_attributions_staff_idx" ON "sales_attributions" ("staff_user_id");
CREATE INDEX IF NOT EXISTS "sales_attributions_date_idx" ON "sales_attributions" ("attributed_at");
CREATE INDEX IF NOT EXISTS "sales_attributions_payout_idx" ON "sales_attributions" ("payout_id");

CREATE TABLE IF NOT EXISTS "commission_adjustments" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "staff_user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "amount" numeric(10, 2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'INR',
  "reason" text NOT NULL,
  "payout_id" integer,
  "adjusted_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "commission_adjustments_org_idx" ON "commission_adjustments" ("organization_id");
CREATE INDEX IF NOT EXISTS "commission_adjustments_staff_idx" ON "commission_adjustments" ("staff_user_id");

CREATE TABLE IF NOT EXISTS "commission_payouts" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "staff_user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "total_sales" numeric(10, 2) NOT NULL DEFAULT 0,
  "total_commission" numeric(10, 2) NOT NULL DEFAULT 0,
  "total_adjustments" numeric(10, 2) NOT NULL DEFAULT 0,
  "net_payout" numeric(10, 2) NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'INR',
  "status" "commission_payout_status" NOT NULL DEFAULT 'pending',
  "notes" text,
  "approved_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "approved_at" timestamptz,
  "paid_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "commission_payouts_org_idx" ON "commission_payouts" ("organization_id");
CREATE INDEX IF NOT EXISTS "commission_payouts_staff_idx" ON "commission_payouts" ("staff_user_id");
CREATE INDEX IF NOT EXISTS "commission_payouts_period_idx" ON "commission_payouts" ("period_start", "period_end");

DO $$ BEGIN
  ALTER TABLE "sales_attributions"
  ADD CONSTRAINT "sales_attributions_payout_fk"
  FOREIGN KEY ("payout_id") REFERENCES "commission_payouts"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "commission_adjustments"
  ADD CONSTRAINT "commission_adjustments_payout_fk"
  FOREIGN KEY ("payout_id") REFERENCES "commission_payouts"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

\else
\echo 'parent table pos_transactions not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

