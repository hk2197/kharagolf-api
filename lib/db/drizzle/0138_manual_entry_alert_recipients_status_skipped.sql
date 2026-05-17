-- Task #1849 — widen `manual_entry_alert_recipients_status_chk` to permit
-- `skipped` so `manualEntryNotify.ts` can record a provider-misconfig
-- (`classifyMailerError() === "provider_unconfigured"`) email attempt as
-- terminal-skipped instead of inflating the per-recipient failure count
-- with a marker `status='failed' / error_message='provider_not_configured'`.
--
-- Mirrors the Task #1502 pattern already shipped on every other notify
-- pipeline (wallet-topup-refund, data-request, etc.): provider misconfig
-- is an env issue, not a delivery failure, so it must NOT show up as a
-- "failed" recipient in director-facing dashboards.
--
-- Idempotent: drops the old constraint (only if present) and re-adds the
-- widened one (only if missing) so reruns and fresh DB bootstraps both
-- succeed.

ALTER TABLE "manual_entry_alert_recipients"
  DROP CONSTRAINT IF EXISTS "manual_entry_alert_recipients_status_chk";

DO $$ BEGIN
  ALTER TABLE "manual_entry_alert_recipients"
    ADD CONSTRAINT "manual_entry_alert_recipients_status_chk"
    CHECK ("status" in ('sent','failed','no_address','no_email','opted_out','skipped'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
