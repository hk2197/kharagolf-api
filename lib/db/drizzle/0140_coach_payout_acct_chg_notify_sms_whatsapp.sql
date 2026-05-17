-- Task #1864 — extend the wallet-topup-refund SMS / WhatsApp retry pipeline
-- (Task #1508) to coach payout-account-change security alerts.
--
-- Until this task the `coach_payout_account_change_notify_attempts` row
-- only carried email + push retry bookkeeping. The notify helper sent no
-- SMS / WhatsApp at all, so a coach who had opted in to billing-category
-- SMS / WhatsApp on their `member_comm_prefs` row never received those
-- legs for the security-sensitive "your payout bank account was changed"
-- alert. Mirroring the wallet-topup-refund pattern lets the cron sweep
-- transient Twilio / WhatsApp Business outages the same way it already
-- sweeps SMTP / Expo flakes for the email + push legs.
--
-- Columns + indexes mirror `wallet_topup_refund_notify_attempts` (Task
-- #1508). Both channels are gated on the coach's billing-category
-- `member_comm_prefs` opt-in (schema defaults are OFF) and re-checked
-- at retry time.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "sms_status" text;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "sms_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "last_sms_at" timestamp with time zone;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "last_sms_error" text;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "last_sms_retry_at" timestamp with time zone;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "next_sms_retry_at" timestamp with time zone;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "sms_retry_exhausted_at" timestamp with time zone;

ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "whatsapp_status" text;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "whatsapp_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "last_whatsapp_at" timestamp with time zone;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "last_whatsapp_error" text;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "last_whatsapp_retry_at" timestamp with time zone;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "next_whatsapp_retry_at" timestamp with time zone;
ALTER TABLE "coach_payout_account_change_notify_attempts"
  ADD COLUMN IF NOT EXISTS "whatsapp_retry_exhausted_at" timestamp with time zone;

-- Hot-path indexes used by the cron sweep
-- (`retryFailedCoachPayoutAccountChangeEmailPush`) to pick up
-- failed-and-not-yet-exhausted SMS / WhatsApp rows on each 5-minute pass.
CREATE INDEX IF NOT EXISTS "coach_payout_acct_chg_notify_attempts_sms_failed_idx"
  ON "coach_payout_account_change_notify_attempts" USING btree ("sms_status","sms_attempts");
CREATE INDEX IF NOT EXISTS "coach_payout_acct_chg_notify_attempts_wa_failed_idx"
  ON "coach_payout_account_change_notify_attempts" USING btree ("whatsapp_status","whatsapp_attempts");
