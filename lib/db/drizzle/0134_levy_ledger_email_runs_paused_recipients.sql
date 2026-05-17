-- Task #1763 — per-run snapshot of recipients filtered out by the
-- bounce-aware suppression filter (Task #1444) inside
-- `runOneLevyLedgerEmailSchedule` and `runOneLevyLedgerOrgEmailSchedule`.
-- Until now the schedule edit drawer in Member 360 → Levies (and the
-- club-wide combined ledger digest editor) only listed recipients that
-- were *currently* on the suppression list AND still in the schedule's
-- saved recipients array. But Task #1444 prunes paused addresses out of
-- `schedule.recipients` during a cron run, so the very recipients
-- admins need to see ("who was auto-removed?") were invisible to the
-- dashboard the moment the cron fired.
--
-- This column stores a JSON array of `{email, reason, bounceType,
-- description}` objects captured at send time, mirroring the metadata
-- the schedule chip surfaces. The dashboard reads the most recent run
-- and unions its `paused_recipients` snapshot with anything currently
-- still on the saved list, so the "X paused" chip + warning rows
-- accurately reflect what was pruned even after the suppression list
-- later changes. Mirrors `wallet_topup_refund_email_runs.paused_recipients`
-- (Task #1759).
--
-- Defaults to an empty JSON array so existing rows backfill cleanly and
-- the cron's three insert paths (no recipients configured / all paused
-- / normal send) can all rely on the column being non-null.
ALTER TABLE "levy_ledger_email_runs"
  ADD COLUMN IF NOT EXISTS "paused_recipients" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "levy_ledger_email_org_runs"
  ADD COLUMN IF NOT EXISTS "paused_recipients" jsonb NOT NULL DEFAULT '[]'::jsonb;
