-- Task #112: Guest & Visitor Pass Management


-- post-merge-guard: fresh-DB guard (table:tee_bookings)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tee_bookings') AS post_merge_dep_present \gset
\if :post_merge_dep_present

DO $$ BEGIN
  CREATE TYPE "guest_pass_status" AS ENUM ('pending', 'confirmed', 'checked_in', 'no_show', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "guest_fee_settlement" AS ENUM ('member_account', 'guest_online', 'pay_at_desk');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "visitor_pass_status" AS ENUM ('pending_payment', 'paid', 'checked_in', 'no_show', 'cancelled', 'refunded');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "guest_passes" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "tee_booking_id" integer REFERENCES "tee_bookings"("id") ON DELETE SET NULL,
  "tee_booking_player_id" integer REFERENCES "tee_booking_players"("id") ON DELETE SET NULL,
  "invited_by_user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE RESTRICT,
  "guest_name" text NOT NULL,
  "guest_email" text,
  "guest_phone" text,
  "play_date" timestamp with time zone NOT NULL,
  "green_fee" numeric(10,2) NOT NULL DEFAULT '0',
  "fee_settlement" "guest_fee_settlement" NOT NULL DEFAULT 'pay_at_desk',
  "status" "guest_pass_status" NOT NULL DEFAULT 'pending',
  "qr_token" text NOT NULL UNIQUE,
  "razorpay_order_id" text,
  "razorpay_payment_id" text,
  "paid_at" timestamp with time zone,
  "checked_in_at" timestamp with time zone,
  "checked_in_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "guest_passes_org_idx" ON "guest_passes"("organization_id");
CREATE INDEX IF NOT EXISTS "guest_passes_booking_idx" ON "guest_passes"("tee_booking_id");
CREATE INDEX IF NOT EXISTS "guest_passes_invited_by_idx" ON "guest_passes"("invited_by_user_id");
CREATE INDEX IF NOT EXISTS "guest_passes_play_date_idx" ON "guest_passes"("play_date");

CREATE TABLE IF NOT EXISTS "visitor_passes" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "visitor_name" text NOT NULL,
  "visitor_email" text NOT NULL,
  "visitor_phone" text,
  "play_date" timestamp with time zone NOT NULL,
  "green_fee" numeric(10,2) NOT NULL,
  "status" "visitor_pass_status" NOT NULL DEFAULT 'pending_payment',
  "qr_token" text NOT NULL UNIQUE,
  "razorpay_order_id" text,
  "razorpay_payment_id" text,
  "paid_at" timestamp with time zone,
  "checked_in_at" timestamp with time zone,
  "checked_in_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "visitor_passes_org_idx" ON "visitor_passes"("organization_id");
CREATE INDEX IF NOT EXISTS "visitor_passes_play_date_idx" ON "visitor_passes"("play_date");

CREATE TABLE IF NOT EXISTS "visitor_pricing_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "description" text,
  "weekday_rate" numeric(10,2) NOT NULL DEFAULT '0',
  "weekend_rate" numeric(10,2) NOT NULL DEFAULT '0',
  "twilight_rate" numeric(10,2),
  "reciprocal_rate" numeric(10,2),
  "day_overrides" jsonb DEFAULT '{}',
  "is_active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "visitor_pricing_org_idx" ON "visitor_pricing_rules"("organization_id");

CREATE TABLE IF NOT EXISTS "guest_policy" (
  "organization_id" integer PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "max_guests_per_member_per_month" integer NOT NULL DEFAULT 10,
  "max_guests_per_member_per_year" integer NOT NULL DEFAULT 60,
  "allow_member_account_settlement" boolean NOT NULL DEFAULT true,
  "allow_guest_online_payment" boolean NOT NULL DEFAULT true,
  "allow_pay_at_desk" boolean NOT NULL DEFAULT true,
  "require_guest_email" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

\else
\echo 'parent table tee_bookings not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

