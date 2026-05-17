-- Task #813 — Throttle the on-demand resend so admins can't spam recipients.
-- The POST .../resend endpoint bypasses the per-org schedule-edit throttle,
-- so an admin clicking Resend rapidly would dispatch repeat emails to the
-- same audit row's recipients. We add a per-(org, sendId) cooldown column
-- that the resend path atomically claims via a conditional UPDATE before
-- dispatching, returning 429 when a second click lands inside the window.
-- DB-backed (rather than in-process) so the cooldown survives an API
-- server restart and is consistent across concurrent requests.

ALTER TABLE "bounced_digest_schedule_sends"
  ADD COLUMN IF NOT EXISTS "last_resend_at" timestamp with time zone;
