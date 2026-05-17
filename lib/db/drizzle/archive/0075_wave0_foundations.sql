-- Migration 0075 — Wave 0 / Task #935 platform foundations
--
-- Adds two tables:
--   1. analytics_events       — durable fallback store for the track() helper
--   2. course_hole_geometry   — hybrid in-house mapper polygons (greens,
--                                fairways, hazards, tee boxes, cart paths)
--
-- Both are organization-scoped from day 1 (analytics_events directly,
-- course_hole_geometry transitively via course → organization cascade)
-- so multi-tenancy isn't retrofitted later.

CREATE TABLE IF NOT EXISTS "analytics_events" (
  "id"              serial PRIMARY KEY,
  "event_name"      text NOT NULL,
  "organization_id" integer REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"         integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "surface"         text NOT NULL DEFAULT 'api',
  "payload"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "request_id"      text,
  "occurred_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "analytics_events_event_idx" ON "analytics_events" ("event_name", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "analytics_events_org_idx"   ON "analytics_events" ("organization_id", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "analytics_events_user_idx"  ON "analytics_events" ("user_id", "occurred_at" DESC);


CREATE TABLE IF NOT EXISTS "course_hole_geometry" (
  "id"           serial PRIMARY KEY,
  "course_id"    integer NOT NULL REFERENCES "courses"("id") ON DELETE CASCADE,
  "hole_number"  integer NOT NULL,
  -- green | fairway | hazard_water | hazard_bunker | hazard_oob | tee_box | cart_path
  "feature_type" text NOT NULL,
  -- GeoJSON-style geometry: {"type":"Polygon"|"LineString"|"Point","coordinates":[...]}
  "geometry"     jsonb NOT NULL,
  -- in_house | ghin | usga | user_drawn
  "source"       text NOT NULL DEFAULT 'in_house',
  "label"        text,
  "metadata"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "course_hole_geometry_course_idx" ON "course_hole_geometry" ("course_id", "hole_number");
CREATE INDEX IF NOT EXISTS "course_hole_geometry_feature_idx" ON "course_hole_geometry" ("course_id", "feature_type");
