-- Task #1658 — persist a row in manual_entry_alerts for every countersign
-- that invoked notifyManualEntryRound (including the skip paths
-- org_muted, tournament_muted, below_threshold, no_recipients, …) so
-- support can answer "why didn't this round trigger an alert?" against a
-- durable record instead of rolling structured logs. `status` mirrors
-- ManualEntryNotifyStatus ('sent' | 'skipped' | 'failed'); `reason` is
-- the canonical reason from MANUAL_ENTRY_NOTIFY_REASONS for skip/failed
-- rows and NULL for delivered alerts.
--
-- Backfill: history-starts-here. Pre-#1658 rows were only ever inserted
-- on the success path, so the column default 'sent' / NULL reason is the
-- correct retroactive value. There is no skip-path data to backfill —
-- skip outcomes were never persisted before this migration.

ALTER TABLE "manual_entry_alerts"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'sent';

ALTER TABLE "manual_entry_alerts"
  ADD COLUMN IF NOT EXISTS "reason" text;

DO $$ BEGIN
  ALTER TABLE "manual_entry_alerts"
    ADD CONSTRAINT "manual_entry_alerts_status_chk"
    CHECK ("status" IN ('sent', 'skipped', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "manual_entry_alerts_status_reason_idx"
  ON "manual_entry_alerts" ("status", "reason");
