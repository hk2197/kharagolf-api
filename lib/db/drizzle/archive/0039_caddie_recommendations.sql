-- Task 356: AI Caddie club recommendation
-- Persist each recommendation event so we can learn from accept/override
-- decisions and feed personalised dispersion back into the model.


-- post-merge-guard: fresh-DB guard (table:general_play_rounds)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'general_play_rounds') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS caddie_recommendations (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER REFERENCES app_users(id) ON DELETE CASCADE,
  player_id             INTEGER REFERENCES players(id) ON DELETE CASCADE,
  tournament_id         INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  general_play_round_id INTEGER REFERENCES general_play_rounds(id) ON DELETE CASCADE,
  round                 INTEGER NOT NULL DEFAULT 1,
  hole_number           INTEGER NOT NULL,
  distance_yards        NUMERIC(8,1) NOT NULL,
  effective_yards       NUMERIC(8,1),
  wind_speed            NUMERIC(6,2),
  wind_direction        NUMERIC(6,2),
  wind_bearing          NUMERIC(6,2),
  recommended_club      TEXT,
  alternate_club        TEXT,
  ranked_clubs          JSONB,
  rationale             JSONB,
  aim_lat_offset        NUMERIC(12,9),
  aim_lng_offset        NUMERIC(12,9),
  lateral_stddev_yards  NUMERIC(6,2),
  using_fallback        BOOLEAN NOT NULL DEFAULT FALSE,
  chosen_club           TEXT,
  accepted              BOOLEAN,
  outcome_strokes       INTEGER,
  outcome_distance_to_pin NUMERIC(8,1),
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS caddie_recommendations_user_idx
  ON caddie_recommendations (user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS caddie_recommendations_player_idx
  ON caddie_recommendations (player_id, tournament_id, round, hole_number);
CREATE INDEX IF NOT EXISTS caddie_recommendations_gp_idx
  ON caddie_recommendations (user_id, general_play_round_id, hole_number);

\else
\echo 'parent table general_play_rounds not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

