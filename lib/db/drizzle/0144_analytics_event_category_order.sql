-- Migration 0144 — analytics_event_category_order (Task #1959)
--
-- Persist the admin-chosen order of analytics event categories per
-- organization. The Customize tab now lets admins drag categories
-- into a preferred order (e.g. Bookings before Marketing before
-- Engagement); we store one row per (organizationId, category) with
-- a 0-based `position`. Categories without a row fall back to
-- alphabetical, "Uncategorized" stays pinned last.

CREATE TABLE IF NOT EXISTS "analytics_event_category_order" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL,
  "category" text NOT NULL,
  "position" integer NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "analytics_event_category_order_org_category_unique"
  ON "analytics_event_category_order" ("organization_id", "category");
