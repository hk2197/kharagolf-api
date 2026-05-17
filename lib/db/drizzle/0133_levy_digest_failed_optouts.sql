-- Task #1762 — Per-event opt-outs for the three new `*.digest.failed`
-- alerts wired into the registry by Task #1444:
--   * `levy.ledger.digest.failed`       — per-levy ledger CSV digest
--   * `levy.ledger.org.digest.failed`   — club-wide combined ledger CSV digest
--   * `levy.reminders.digest.failed`    — bounced-levy reminders cron digest
--
-- Mirrors the pattern shipped in Task #1429 for the wallet auto-refund and
-- side-game receipts digest-failed alerts (`notify_wallet_refund_digest_failed`,
-- `notify_side_game_receipt_digest_failed`). Each flag lets an admin /
-- treasurer / membership_secretary who already monitors the run history
-- dashboard mute one specific alert without flipping the global digest
-- mode, the global email/push toggles, or any other admin notification.
--
-- Honoured even when digest mode is on: false short-circuits to audit-only
-- (no per-event push/email AND no digest enqueue), matching
-- `coachPayoutAccountChangeNotify` and the Task #1429 reference pattern.
--
-- All three default to true so existing recipients keep receiving the
-- alerts unless they explicitly opt out; wrapped in IF NOT EXISTS so
-- reruns and fresh DB bootstraps both succeed.

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_levy_ledger_digest_failed" boolean NOT NULL DEFAULT true;

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_levy_ledger_org_digest_failed" boolean NOT NULL DEFAULT true;

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_levy_reminders_digest_failed" boolean NOT NULL DEFAULT true;
