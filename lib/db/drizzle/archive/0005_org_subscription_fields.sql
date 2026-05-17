-- Add org-level subscription tracking fields
-- Mirrors Razorpay subscription lifecycle for platform billing

DO $$ BEGIN
  CREATE TYPE "org_subscription_status" AS ENUM('free', 'active', 'past_due', 'cancelled', 'pending_payment');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "org_subscription_status" "org_subscription_status" NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS "pending_subscription_tier" "subscription_tier",
  ADD COLUMN IF NOT EXISTS "razorpay_subscription_id" text;
