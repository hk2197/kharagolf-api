-- Task #1508 — Cover SMS / WhatsApp retries for wallet top-up refund notice.
--
-- Until now the Task #1280 retry pipeline only re-tried the email and
-- push channels for `wallet_topup_refund_notify_attempts`, matching the
-- wallet-withdrawal pattern from Task #1108. SMS and WhatsApp on the
-- wallet-topup-refund path remained best-effort one-shots: a transient
-- Twilio / WhatsApp Business outage during the original send was
-- silently dropped and the member never got the refund SMS they had
-- explicitly opted in to (billing SMS / WhatsApp default OFF, so a
-- delivery failure here always concerns a member who opted in).
--
-- This migration extends the attempts table with SMS and WhatsApp
-- columns mirroring the email/push columns, plus matching partial
-- indexes that back the cron's "due rows" scan.

ALTER TABLE "wallet_topup_refund_notify_attempts"
  ADD COLUMN IF NOT EXISTS "sms_status" text,
  ADD COLUMN IF NOT EXISTS "sms_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_sms_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_sms_error" text,
  ADD COLUMN IF NOT EXISTS "last_sms_retry_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "next_sms_retry_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "sms_retry_exhausted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "whatsapp_status" text,
  ADD COLUMN IF NOT EXISTS "whatsapp_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_whatsapp_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_whatsapp_error" text,
  ADD COLUMN IF NOT EXISTS "last_whatsapp_retry_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "next_whatsapp_retry_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "whatsapp_retry_exhausted_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "wallet_topup_refund_notify_attempts_sms_failed_idx"
  ON "wallet_topup_refund_notify_attempts" ("sms_status", "sms_attempts");

CREATE INDEX IF NOT EXISTS "wallet_topup_refund_notify_attempts_wa_failed_idx"
  ON "wallet_topup_refund_notify_attempts" ("whatsapp_status", "whatsapp_attempts");
