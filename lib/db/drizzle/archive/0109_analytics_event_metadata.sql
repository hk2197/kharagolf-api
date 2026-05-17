-- Migration 0109 — analytics_event_metadata (Task #1318)
--
-- Per-org friendly names, descriptions, and chart colors for analytics
-- events. The analytics dashboard previously rendered events as raw
-- snake_case strings with hash-derived colors; admins can now upsert a
-- row here to give each event a human-readable label and a stable color.
--
-- One row per (organization_id, event_name). The API treats this table
-- as upsert-only: PUT /events/metadata/:eventName creates or updates,
-- DELETE /events/metadata/:eventName removes the override (UI falls
-- back to the raw event name + deterministic palette color).

BEGIN;

CREATE TABLE IF NOT EXISTS "analytics_event_metadata" (
  "id"              serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "event_name"      text NOT NULL,
  "display_name"    text,
  "description"     text,
  "color"           text,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "analytics_event_metadata"
    ADD CONSTRAINT "analytics_event_metadata_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "analytics_event_metadata_org_event_unique"
  ON "analytics_event_metadata" ("organization_id", "event_name");

COMMIT;
