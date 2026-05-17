-- Task #547 — tag where each shot came from.
--
-- Adds an explicit `source` column to the shots table so the round-detail map
-- (and later per-source analytics) can tell apart shots that came from the
-- Garmin watch, the phone's auto-detect, a manual entry on the web, or a
-- live scorer at a tournament station. Previously the round map treated any
-- shot with GPS coordinates as "watch-originated", which mis-categorised
-- mobile auto-detect rows.
--
-- Existing rows default to 'manual' so they are not falsely attributed to a
-- specific sensor; new ingest paths set the column explicitly.

DO $$ BEGIN
  CREATE TYPE shot_source AS ENUM ('watch', 'phone', 'manual', 'scorer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE shots
  ADD COLUMN IF NOT EXISTS source shot_source NOT NULL DEFAULT 'manual';
