-- Task 365: heart-rate / stress overlay per shot.
-- Two new tables:
--   user_health_prefs — opt-in flag + baseline HR for the correlation widget.
--   hr_samples       — per-shot/per-hole heart-rate samples streamed from
--                      Apple Watch / Wear OS during a round.
--
-- Health data is treated as sensitive: capture is OFF by default and only
-- enabled when the player explicitly opts in from the stats screen.


-- post-merge-guard: fresh-DB guard (table:general_play_rounds)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'general_play_rounds') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "user_health_prefs" (
  "user_id" integer PRIMARY KEY NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "hr_capture_enabled" boolean DEFAULT false NOT NULL,
  "baseline_hr_bpm" integer,
  "consented_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "hr_samples" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "tournament_id" integer REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "general_play_round_id" integer REFERENCES "general_play_rounds"("id") ON DELETE CASCADE,
  "player_id" integer REFERENCES "players"("id") ON DELETE CASCADE,
  "round" integer DEFAULT 1 NOT NULL,
  "hole_number" integer,
  "shot_number" integer,
  "hr_bpm" integer NOT NULL,
  "hrv_ms" numeric(6, 2),
  "stress_score" integer,
  "source" text DEFAULT 'apple_watch' NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "hr_samples_user_round_idx"
  ON "hr_samples" ("user_id", "tournament_id", "round");
CREATE INDEX IF NOT EXISTS "hr_samples_user_gp_idx"
  ON "hr_samples" ("user_id", "general_play_round_id", "round");
CREATE INDEX IF NOT EXISTS "hr_samples_user_recorded_idx"
  ON "hr_samples" ("user_id", "recorded_at");

\else
\echo 'parent table general_play_rounds not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

