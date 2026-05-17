-- Migration 0126 — analytics_event_metadata "edited by" audit (Task #1570).
--
-- Adds the editor-attribution column to `analytics_event_metadata` and
-- creates an append-only history table so the Customize tab can show
-- "Last edited by <name> on <date>" beside each customized event and
-- list the last few changes per event.
--
--   1. ALTER TABLE analytics_event_metadata
--        ADD COLUMN updated_by_user_id integer
--          REFERENCES app_users(id) ON DELETE SET NULL
--      Stamps which admin last upserted this row. SET NULL keeps the
--      attribution row intact if the editor's account is later erased
--      (Task #467 auto-erasure).
--
--   2. CREATE TABLE analytics_event_metadata_history
--        One row per upsert/delete on analytics_event_metadata. The
--        Customize tab reads the most recent rows per
--        (organization_id, event_name) to render a small "Recent
--        changes" timeline.
--
-- Both statements are idempotent so this migration is safe to re-run on
-- a partially-applied DB.

BEGIN;

ALTER TABLE "analytics_event_metadata"
  ADD COLUMN IF NOT EXISTS "updated_by_user_id" integer;

DO $$ BEGIN
  ALTER TABLE "analytics_event_metadata"
    ADD CONSTRAINT "analytics_event_metadata_updated_by_user_id_app_users_id_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "app_users"("id")
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "analytics_event_metadata_history" (
  "id"                  serial PRIMARY KEY NOT NULL,
  "organization_id"     integer NOT NULL,
  "event_name"          text NOT NULL,
  "action"              text NOT NULL,
  "display_name"        text,
  "description"         text,
  "color"               text,
  "changed_by_user_id"  integer,
  "changed_at"          timestamp with time zone NOT NULL DEFAULT now()
);

-- Explicit short FK name keeps the constraint identifier under
-- Postgres's 63-char limit (the auto-generated
-- "<table>_<col>_<reftable>_<refcol>_fk" name would be 67 chars and
-- get silently truncated). Matches the pattern in
-- lib/db/src/schema/golf.ts — see task #805.
DO $$ BEGIN
  ALTER TABLE "analytics_event_metadata_history"
    ADD CONSTRAINT "analytics_event_metadata_history_changed_by_user_fk"
    FOREIGN KEY ("changed_by_user_id") REFERENCES "app_users"("id")
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "analytics_event_metadata_history_org_event_idx"
  ON "analytics_event_metadata_history" ("organization_id", "event_name", "changed_at");

COMMIT;
