-- Task #1423 — Track in-flight wallet top-up requests so the home
-- Upcoming widget can surface them before the bank settles.
--
-- The existing reconciliation flow (Task #769) records refund audit
-- rows in `club_wallet_txns`, but there was no local record of a
-- top-up between order creation and bank settlement. Members couldn't
-- see "I started a top-up — is it processing?" without leaving the
-- home screen. This table closes that gap with a per (organization,
-- user, razorpay order) row written at /wallet/topup-order time.
--
-- Status transitions:
--   "pending_verification" → "credited"        (verify or webhook landed)
--   "pending_verification" → "refund_pending"  (cron found it orphaned,
--                                               about to refund)
--   "refund_pending"        → "refunded"       (refund recorded in audit)
--
-- Rows in `pending_verification` or `refund_pending` are surfaced as
-- `kind: "wallet_topup"` items in /api/portal/my-upcoming.

CREATE TABLE IF NOT EXISTS "wallet_topup_requests" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "order_ref" text NOT NULL,
  "payment_ref" text,
  "amount" numeric(12, 2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'INR',
  "status" text NOT NULL DEFAULT 'pending_verification',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "wallet_topup_requests"
    ADD CONSTRAINT "wallet_topup_requests_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_topup_requests"
    ADD CONSTRAINT "wallet_topup_requests_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_topup_requests_order_unique"
  ON "wallet_topup_requests" ("order_ref");

CREATE INDEX IF NOT EXISTS "wallet_topup_requests_user_status_idx"
  ON "wallet_topup_requests" ("user_id", "status", "created_at");
