-- Task #1281 — Track how often the public Year-in-Golf recap link is hit.
-- One row per request to /api/public/recap/:handle/card.png (the social
-- card PNG used as og:image and as a save-to-camera-roll fallback) or
-- /api/public/recap/:handle/og (the Open-Graph HTML stub that crawlers
-- and humans both land on). The handle is captured as a snapshot string
-- so analytics survive a member later renaming or releasing the handle,
-- and `user_id` is also stored so org-scoped reads keep working through
-- renames. The dimensions on each row mirror what the share URL carries
-- (`year`, `period`) plus how the link was distributed (`source` — copy
-- vs web_share vs native_share vs qr_open vs crawler vs unknown).

CREATE TABLE IF NOT EXISTS "recap_share_events" (
  "id"         serial                   PRIMARY KEY,
  "user_id"    integer                  NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "handle"     text                     NOT NULL,
  "asset"      text                     NOT NULL,
  "period"     text                     NOT NULL,
  "year"       integer                  NOT NULL,
  "source"     text                     NOT NULL DEFAULT 'unknown',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "recap_share_events_user_idx"
  ON "recap_share_events" ("user_id");

CREATE INDEX IF NOT EXISTS "recap_share_events_handle_idx"
  ON "recap_share_events" ("handle");

CREATE INDEX IF NOT EXISTS "recap_share_events_user_asset_idx"
  ON "recap_share_events" ("user_id", "asset");

CREATE INDEX IF NOT EXISTS "recap_share_events_created_idx"
  ON "recap_share_events" ("created_at");

-- Daily-aggregate rollup for recap_share_events. Same rationale as the
-- badge / profile share rollups (Tasks #1096 / #1259): the raw events
-- table has no natural pruning point so a scheduled job summarises
-- events older than the rollup window into one row per
-- (user_id, asset, period, year, source, day) here, then deletes the
-- raw events. Read paths UNION raw events with these aggregates so
-- totals stay correct across the rollup boundary.
CREATE TABLE IF NOT EXISTS "recap_share_daily_aggregates" (
  "user_id" integer                  NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "asset"   text                     NOT NULL,
  "period"  text                     NOT NULL,
  "year"    integer                  NOT NULL,
  "source"  text                     NOT NULL DEFAULT 'unknown',
  "day"     timestamp with time zone NOT NULL,
  "count"   integer                  NOT NULL DEFAULT 0,
  CONSTRAINT "recap_share_daily_aggregates_pk"
    PRIMARY KEY ("user_id", "asset", "period", "year", "source", "day")
);

CREATE INDEX IF NOT EXISTS "recap_share_daily_aggregates_user_idx"
  ON "recap_share_daily_aggregates" ("user_id");

CREATE INDEX IF NOT EXISTS "recap_share_daily_aggregates_day_idx"
  ON "recap_share_daily_aggregates" ("day");
