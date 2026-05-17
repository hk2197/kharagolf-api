-- Task #1544 — Snapshot the masked phone / push device label we tried at
-- attempt time on `coach_payout_notification_attempts` so the coach
-- earnings cell can show *which* contact details we attempted when a
-- payout-paid notification missed.
--
-- Why: today the coach earnings view tells the coach we couldn't reach
-- them but doesn't say *which* phone / device we tried. Coaches who have
-- since rotated SIMs or switched phones have no way to know whether the
-- failure is because we have a stale number on file. Showing the masked
-- phone (e.g. "+91 ●●●●●● 4321") and a short device label (e.g. "1 expo
-- device") gives them an actionable hint without leaking the full PII.
--
-- Both columns are nullable:
--   * legacy rows pre-#1544 carry no snapshot
--   * a channel with no recipient (`no_address` / `no_user`) has nothing
--     to mask
-- so existing reads never break. Retry passes (`retryCoachPayoutPush` /
-- `retryCoachPayoutSms`) re-derive and refresh these columns at retry
-- time so they reflect the live recipient — a coach who later updates
-- their phone sees the new masked digits the moment the cron picks the
-- row back up.

ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "push_target_label" text;

ALTER TABLE "coach_payout_notification_attempts"
  ADD COLUMN IF NOT EXISTS "sms_target_masked" text;
