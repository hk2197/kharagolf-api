-- Task #1224 — per-user opt-out for the admin "coach payout account
-- created/updated" security alert (`notifyOrgAdminsCoachPayoutAccountChanged`,
-- added in Task #1060). Defaults to true so existing org admins keep
-- receiving the alert; an admin who finds it noisy can mute just this
-- event without silencing other admin emails or flipping global digest
-- mode. The notify path treats false as audit-only — no per-event email
-- AND no digest enqueue, even when the user has digest mode enabled.
ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_coach_payout_account_changes" boolean NOT NULL DEFAULT true;
