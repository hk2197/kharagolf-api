-- Task #575 — auto-finalize round-robin brackets.
--
-- Adds the columns needed to record the outcome of a match-play bracket once
-- the round-robin phase has produced a champion (and runner-up). When set,
-- `completed_at` lets the UI show a "Complete" badge and prevents further
-- result edits from re-running finalization.
--
-- All three columns are nullable so existing brackets continue to validate as
-- "in progress" until the new server logic finalizes them. The FKs target
-- `players(id)` because bracket matches store player IDs from that table
-- (which represents both registered users and guest entries).

ALTER TABLE match_play_brackets
  ADD COLUMN IF NOT EXISTS completed_at timestamp,
  ADD COLUMN IF NOT EXISTS champion_id integer REFERENCES players(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS runner_up_id integer REFERENCES players(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS match_play_brackets_champion_id_idx
  ON match_play_brackets(champion_id);
