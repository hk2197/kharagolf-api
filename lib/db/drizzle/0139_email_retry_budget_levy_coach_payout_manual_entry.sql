-- Tasks #1847 + #1279 — per-recipient email retry budget + hard-bounce
-- shortcut for the three remaining fire-and-forget email pipelines:
--   * `levyReceiptNotify`           (member_levy_receipt_attempts)
--   * `notifyCoachPayoutPaid`       (coach_payout_notification_attempts)
--   * `manualEntryNotify`           (manual_entry_alert_recipients)
--
-- Mirrors the wallet-withdrawal / data-request precedent (Task #1108 /
-- #961): the existing notify cron re-attempts a failed send on the
-- bounded `5/10/20/40/80` minute schedule, and a hard SMTP bounce
-- jumps the row straight to exhausted instead of consuming the
-- remaining budget. On cap reached (or first-send hard bounce) we
-- fire a single admin alert per row, deduped via
-- `email_exhaustion_notified_at`.
--
-- Coach + levy attempts also gain `push_/sms_exhaustion_notified_at`
-- so per-channel admin alerts dedup the same way.
--
-- Idempotent: every column add uses IF NOT EXISTS and every index
-- uses IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.
--
-- Note: the manual_entry_alert_recipients_status_chk widening to
-- accept 'skipped' is already handled by migration
-- 0138_manual_entry_alert_recipients_status_skipped.sql, so this
-- file does NOT touch that constraint.

-- ─── member_levy_receipt_attempts ───────────────────────────────────
ALTER TABLE "member_levy_receipt_attempts"
  ADD COLUMN IF NOT EXISTS "email_status" text;
ALTER TABLE "member_levy_receipt_attempts"
  ADD COLUMN IF NOT EXISTS "email_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "member_levy_receipt_attempts"
  ADD COLUMN IF NOT EXISTS "last_email_at" timestamp with time zone;
ALTER TABLE "member_levy_receipt_attempts"
  ADD COLUMN IF NOT EXISTS "last_email_error" text;
ALTER TABLE "member_levy_receipt_attempts"
  ADD COLUMN IF NOT EXISTS "last_email_retry_at" timestamp with time zone;
ALTER TABLE "member_levy_receipt_attempts"
  ADD COLUMN IF NOT EXISTS "next_email_retry_at" timestamp with time zone;
ALTER TABLE "member_levy_receipt_attempts"
  ADD COLUMN IF NOT EXISTS "email_retry_exhausted_at" timestamp with time zone;
ALTER TABLE "member_levy_receipt_attempts"
  ADD COLUMN IF NOT EXISTS "email_exhaustion_notified_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "member_levy_receipt_attempts_email_failed_idx"
  ON "member_levy_receipt_attempts" USING btree
    ("email_status", "email_attempts", "next_email_retry_at");

-- ─── coach_payout_notification_attempts ─────────────────────────────
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "email_status" text;
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "email_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "last_email_at" timestamp with time zone;
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "last_email_error" text;
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "last_email_retry_at" timestamp with time zone;
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "next_email_retry_at" timestamp with time zone;
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "email_retry_exhausted_at" timestamp with time zone;
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "email_exhaustion_notified_at" timestamp with time zone;
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "email_recipient" text;
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "push_exhaustion_notified_at" timestamp with time zone;
ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "sms_exhaustion_notified_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "coach_payout_notif_attempts_email_failed_idx"
  ON "coach_payout_notification_attempts" USING btree
    ("email_status", "email_attempts", "next_email_retry_at");

-- ─── manual_entry_alert_recipients ──────────────────────────────────
-- (`email_status` is not added — this table reuses its existing
-- `status` text column because each row already represents a single
-- recipient/channel attempt and there is no per-channel sub-status.)
ALTER TABLE "manual_entry_alert_recipients"
  ADD COLUMN IF NOT EXISTS "email_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "manual_entry_alert_recipients"
  ADD COLUMN IF NOT EXISTS "last_email_at" timestamp with time zone;
ALTER TABLE "manual_entry_alert_recipients"
  ADD COLUMN IF NOT EXISTS "last_email_error" text;
ALTER TABLE "manual_entry_alert_recipients"
  ADD COLUMN IF NOT EXISTS "last_email_retry_at" timestamp with time zone;
ALTER TABLE "manual_entry_alert_recipients"
  ADD COLUMN IF NOT EXISTS "next_email_retry_at" timestamp with time zone;
ALTER TABLE "manual_entry_alert_recipients"
  ADD COLUMN IF NOT EXISTS "email_retry_exhausted_at" timestamp with time zone;
ALTER TABLE "manual_entry_alert_recipients"
  ADD COLUMN IF NOT EXISTS "email_exhaustion_notified_at" timestamp with time zone;
ALTER TABLE "manual_entry_alert_recipients"
  ADD COLUMN IF NOT EXISTS "email_recipient" text;

CREATE INDEX IF NOT EXISTS "manual_entry_alert_recipients_email_failed_idx"
  ON "manual_entry_alert_recipients" USING btree
    ("channel", "status", "email_attempts", "next_email_retry_at");
