-- Task #1673 — additional org-wide notification defaults that follow the
-- same registry-driven inheritance pattern as `notify_manual_entry_alerts`.
-- Each gets a sibling per-tournament boolean column so the per-event
-- toggle is captured on the row at creation time and the inheritance
-- summary on /club-settings can show whether existing tournaments still
-- match the new club-wide default.
--
-- Defaults to `true` so the alerts stay on for every existing club +
-- tournament unless an admin explicitly mutes them.

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "notify_schedule_changes" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_score_corrections" boolean NOT NULL DEFAULT true;

ALTER TABLE "tournaments"
  ADD COLUMN IF NOT EXISTS "notify_schedule_changes" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notify_score_corrections" boolean NOT NULL DEFAULT true;
