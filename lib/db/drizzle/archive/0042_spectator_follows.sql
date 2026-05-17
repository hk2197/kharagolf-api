-- Task #377 — Spectator follow records with granular per-event notification opt-ins.
CREATE TABLE IF NOT EXISTS "spectator_follows" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "tournament_id" integer NOT NULL REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "player_id" integer REFERENCES "players"("id") ON DELETE CASCADE,
  "tee_time_id" integer REFERENCES "tee_times"("id") ON DELETE CASCADE,
  "notify_birdie" boolean NOT NULL DEFAULT false,
  "notify_eagle" boolean NOT NULL DEFAULT true,
  "notify_hio" boolean NOT NULL DEFAULT true,
  "notify_round_start" boolean NOT NULL DEFAULT false,
  "notify_round_finish" boolean NOT NULL DEFAULT true,
  "notify_tee_off" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spectator_follow_user_player_unique"
  ON "spectator_follows" ("user_id", "tournament_id", "player_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spectator_follow_user_group_unique"
  ON "spectator_follows" ("user_id", "tournament_id", "tee_time_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spectator_follow_player_idx"
  ON "spectator_follows" ("tournament_id", "player_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spectator_follow_group_idx"
  ON "spectator_follows" ("tournament_id", "tee_time_id");
