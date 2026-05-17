-- Task #1825 — persist SMS + WhatsApp delivery results on the
-- wallet-withdrawal notify attempts row.
--
-- Task #1107 added SMS and Task #1487 added WhatsApp delivery to the
-- wallet-withdrawal lifecycle notice (alongside push + email), but the
-- per-attempt audit row (`wallet_withdrawal_notify_attempts`) only
-- persisted the email and push results. SMS / WhatsApp results lived
-- only on the in-memory `WalletWithdrawalNotifyResult` and were lost
-- as soon as `notifyWithdrawal` returned, so admins debugging "did the
-- member get pinged?" could confirm email + push but had no record
-- for the other two channels.
--
-- These columns are audit-only — neither SMS nor WhatsApp is retried
-- by the wallet-withdrawal cron, so we don't carry the
-- attempts/exhaustion/next-retry bookkeeping the email/push columns
-- already have.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

ALTER TABLE "wallet_withdrawal_notify_attempts"
  ADD COLUMN IF NOT EXISTS "sms_status" text;
ALTER TABLE "wallet_withdrawal_notify_attempts"
  ADD COLUMN IF NOT EXISTS "sms_error" text;
ALTER TABLE "wallet_withdrawal_notify_attempts"
  ADD COLUMN IF NOT EXISTS "last_sms_at" timestamp with time zone;
ALTER TABLE "wallet_withdrawal_notify_attempts"
  ADD COLUMN IF NOT EXISTS "whatsapp_status" text;
ALTER TABLE "wallet_withdrawal_notify_attempts"
  ADD COLUMN IF NOT EXISTS "whatsapp_error" text;
ALTER TABLE "wallet_withdrawal_notify_attempts"
  ADD COLUMN IF NOT EXISTS "last_whatsapp_at" timestamp with time zone;
