-- Task #962 — per-event-type opt-out for the side-game settlement-paid
-- recipient receipt email. Lets a member who still wants other club billing
-- emails (levy receipts, statements) silence just the casual side-game
-- receipts. Defaults to true so existing recipients keep receiving them.
ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_side_game_receipts" boolean NOT NULL DEFAULT true;
