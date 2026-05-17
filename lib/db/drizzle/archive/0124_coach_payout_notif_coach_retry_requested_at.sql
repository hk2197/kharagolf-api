-- Task #1543 — let coaches re-trigger their own missed payout notifications.
--
-- Adds a `coach_retry_requested_at` watermark column to
-- `coach_payout_notification_attempts`. The new
-- `POST /api/swing-reviews/coach/payouts/:id/retry-notification` route
-- stamps this every time the coach presses "Try again" in their earnings
-- workspace, and refuses a fresh request within the
-- `COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS` window so a coach cannot wedge
-- the retry cron into a tight loop with repeat presses.
--
-- The column is informational for admins (the existing admin Resend
-- button intentionally does NOT touch it — admin overrides the cooldown
-- by design).

ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "coach_retry_requested_at" timestamp with time zone;
