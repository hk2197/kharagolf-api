-- Task #1018 — let directors mute manual-entry data-quality alerts.
-- Per-tournament toggle (default true) on the tournaments table, and
-- per-user opt-out (default true) on user_notification_prefs. Both are
-- checked by `notifyManualEntryRound` before fanning out push/email.
ALTER TABLE "tournaments"
  ADD COLUMN IF NOT EXISTS "notify_manual_entry_alerts" boolean NOT NULL DEFAULT true;

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_manual_entry_alerts" boolean NOT NULL DEFAULT true;
