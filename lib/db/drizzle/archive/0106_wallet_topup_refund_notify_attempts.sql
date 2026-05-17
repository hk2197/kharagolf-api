-- Task #1280 — persist per-paymentId wallet top-up auto-refund notify
-- attempts so a transient SMTP/Expo failure on the first try is retried
-- by the cron instead of silently dropping the member's only confirmation
-- that we just refunded their bank account. Mirrors the shape of
-- `wallet_withdrawal_notify_attempts` (Task #1108).

CREATE TABLE IF NOT EXISTS "wallet_topup_refund_notify_attempts" (
  "id"                       serial PRIMARY KEY,
  "payment_id"               text                     NOT NULL,
  "organization_id"          integer                  NOT NULL,
  "user_id"                  integer                  NOT NULL,
  "refund_id"                text,
  "amount"                   numeric(14, 2)           NOT NULL,
  "currency"                 text                     NOT NULL,
  "created_at"               timestamp with time zone NOT NULL DEFAULT now(),
  "email_status"             text,
  "email_attempts"           integer                  NOT NULL DEFAULT 0,
  "last_email_at"            timestamp with time zone,
  "last_email_error"         text,
  "last_email_retry_at"      timestamp with time zone,
  "next_email_retry_at"      timestamp with time zone,
  "email_retry_exhausted_at" timestamp with time zone,
  "push_status"              text,
  "push_attempts"            integer                  NOT NULL DEFAULT 0,
  "last_push_at"             timestamp with time zone,
  "last_push_error"          text,
  "last_push_retry_at"       timestamp with time zone,
  "next_push_retry_at"       timestamp with time zone,
  "push_retry_exhausted_at"  timestamp with time zone
);

DO $$ BEGIN
  ALTER TABLE "wallet_topup_refund_notify_attempts"
    ADD CONSTRAINT "wallet_topup_refund_notify_attempts_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_topup_refund_notify_attempts_payment_unique"
  ON "wallet_topup_refund_notify_attempts" ("payment_id");

CREATE INDEX IF NOT EXISTS "wallet_topup_refund_notify_attempts_email_failed_idx"
  ON "wallet_topup_refund_notify_attempts" ("email_status", "email_attempts");

CREATE INDEX IF NOT EXISTS "wallet_topup_refund_notify_attempts_push_failed_idx"
  ON "wallet_topup_refund_notify_attempts" ("push_status", "push_attempts");
