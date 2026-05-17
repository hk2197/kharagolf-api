-- Task #1188 — Org-wide mute switch for the manual-entry data-quality alert.
--
-- Per-tournament and per-user switches already exist (Task #1018). Clubs
-- that run hundreds of casual social events still have to flip the
-- per-tournament toggle on every new event. This adds an org-level
-- default so admins can say "this club doesn't care about manual-entry
-- alerts" once and have every new event inherit that setting.
--
-- `notifyManualEntryRound` short-circuits when this flag is false, and
-- the tournament-creation route seeds the per-tournament flag from this
-- column so the inheritance is captured on the row at creation time.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "notify_manual_entry_alerts" boolean NOT NULL DEFAULT true;
