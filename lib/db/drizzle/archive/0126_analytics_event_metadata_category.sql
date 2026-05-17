-- Migration 0126 — analytics_event_metadata.category (Task #1569)
--
-- Group analytics events into categories. The Customize tab now lets
-- admins assign each event metadata row an optional free-text category
-- (e.g. "Bookings", "Payments", "Engagement") so the dashboard can
-- group totals tiles, chart lines, and the Customize tab rows by
-- category. The "admin-managed list" is implicit: the distinct set of
-- categories already in use across this org's rows.
--
-- Nullable + no default — legacy rows fall into the "Uncategorized"
-- bucket and continue to render exactly as they did pre-#1569.

ALTER TABLE "analytics_event_metadata"
  ADD COLUMN IF NOT EXISTS "category" text;
