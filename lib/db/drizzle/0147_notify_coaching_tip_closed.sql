-- Task #2040 — Per-player opt-out for the daily "you closed the gap"
-- coaching encouragement push (`coaching.gap.closed`, dispatched from
-- `runCoachingGapClosedDailySweep` in `lib/cron.ts`).
--
-- The push fires when a player's proximity-vs-tour trend on a club has
-- shrunk by at least 1.5 ft between the prior 30-day window and the
-- current 30-day window — the same `TREND_ENCOURAGEMENT_FT` threshold
-- the AI Caddie uses to flip its hint to encouragement (see
-- `computeProximityCoachingTips` in `lib/strokes-gained.ts`). The push
-- deep-links to the stats tab scrolled to the relevant club, and is
-- deduped per (user, clubKey) for 14 days via `member_audit_log`
-- (entity = `coaching_tip`, action = `gap_closed_notified`).
--
-- Mirrors the audit-only short-circuit pattern shipped in Task #1429
-- for the wallet auto-refund and side-game receipts digest-failed
-- alerts: a `false` value gates the per-event push to audit-only
-- without affecting the global `prefer_push` toggle. Defaults to true
-- so existing players see the nudge unless they explicitly mute it,
-- wrapped in `IF NOT EXISTS` so reruns and fresh DB bootstraps both
-- succeed.

ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_coaching_tip_closed" boolean NOT NULL DEFAULT true;
