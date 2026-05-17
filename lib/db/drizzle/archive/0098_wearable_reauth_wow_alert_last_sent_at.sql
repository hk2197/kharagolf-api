-- Task #1151 — Email admins when needs_reauth drifts up week-over-week.
--
-- The weekly drift evaluator (`evaluateWeeklyReauthDrift` in
-- artifacts/api-server/src/lib/wearables.ts) compares this week's average
-- needs_reauth count to last week's. When the increase exceeds a configurable
-- threshold it emails the org's existing wearable-reauth alert recipient.
--
-- This column is the per-org rate-limit watermark — the evaluator stamps it
-- with the moment the email is dispatched and uses an atomic conditional
-- UPDATE to make sure each org receives at most one drift alert per 7 days,
-- regardless of how often the cron tick fires.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "wearable_reauth_wow_alert_last_sent_at" timestamptz;
