-- Task #426 — Persist broadcast overlay producer cue state across API
-- server restarts. The full producer cue (active overlays, current
-- group/hole/player/sponsor, lower-third text, leaderboard limit, theme
-- overrides) is serialised to JSON. One row per tournament.

CREATE TABLE IF NOT EXISTS "broadcast_overlay_states" (
  "id" serial PRIMARY KEY NOT NULL,
  "tournament_id" integer NOT NULL,
  "state" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "broadcast_overlay_states_tournament_id_unique" UNIQUE("tournament_id")
);

DO $$ BEGIN
  ALTER TABLE "broadcast_overlay_states"
    ADD CONSTRAINT "broadcast_overlay_states_tournament_id_tournaments_id_fk"
    FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
