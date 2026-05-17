-- Task #1798 — Track how often a shared badge link converts into a real
-- visit to the member's public-profile/badge page.
--
-- The Badge Share Leaderboard already tells admins which badges drive
-- the most outbound share clicks (`badge_share_events` — the share
-- button being pressed) but until now there was no way to tell whether
-- those shares actually pulled visitors back to the profile. One row
-- is inserted here per visit to the `/p/<handle>/badge/<type>` web
-- page (fired client-side from the public-badge React component on
-- mount, fire-and-forget). The handle is captured as a snapshot string
-- so analytics survive a later rename.
--
-- Columns intentionally mirror `badge_share_events` so the analytics
-- endpoints can JOIN visits to share counts on `(handle, badge_type)`
-- and compute a per-badge "shares → visits" conversion ratio.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

CREATE TABLE IF NOT EXISTS "badge_share_visit_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "handle" text NOT NULL,
  "badge_type" text NOT NULL,
  "source" text NOT NULL DEFAULT 'unknown',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "badge_share_visit_events_handle_idx"
  ON "badge_share_visit_events" USING btree ("handle");

CREATE INDEX IF NOT EXISTS "badge_share_visit_events_badge_idx"
  ON "badge_share_visit_events" USING btree ("badge_type");

CREATE INDEX IF NOT EXISTS "badge_share_visit_events_handle_badge_idx"
  ON "badge_share_visit_events" USING btree ("handle", "badge_type");

CREATE INDEX IF NOT EXISTS "badge_share_visit_events_created_idx"
  ON "badge_share_visit_events" USING btree ("created_at");
