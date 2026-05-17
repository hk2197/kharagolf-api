-- Task #1429 — Mirror the per-event opt-out pattern shipped in Task #1224
-- (`notify_coach_payout_account_changes`) across the remaining admin-only
-- event notifications that go through `dispatchNotification`.
--
-- These flags let an admin who finds one specific alert noisy mute just
-- that one event without flipping the global digest mode, the global
-- email/push toggles, or any other admin notification.
--
-- Honoured even when digest mode is on: false short-circuits to audit-only
-- (no per-event push/email AND no digest enqueue), matching the
-- coachPayoutAccountChangeNotify reference pattern.
--
-- Both default to true so existing admins keep receiving the alerts unless
-- they explicitly opt out; both wrapped in IF NOT EXISTS so reruns and
-- fresh DB bootstraps both succeed.

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_wallet_refund_digest_failed" boolean NOT NULL DEFAULT true;

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_side_game_receipt_digest_failed" boolean NOT NULL DEFAULT true;
