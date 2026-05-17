-- Task #726 — Track who last loaded a broadcaster cue-sheet template and when.
-- Producers sharing a tournament need to know which template was last pushed
-- live and by whom, both for in-the-moment coordination ("did Sam already cue
-- the leaderboard?") and post-event review.
--
-- Adds two nullable columns to `broadcast_overlay_state_templates`:
--   * `last_loaded_at`         — timestamp of the most recent /load call
--   * `last_loaded_by_user_id` — FK to `app_users` (SET NULL on delete)
-- Both remain NULL for templates that have never been loaded.

ALTER TABLE "broadcast_overlay_state_templates"
  ADD COLUMN IF NOT EXISTS "last_loaded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "broadcast_overlay_state_templates"
  ADD COLUMN IF NOT EXISTS "last_loaded_by_user_id" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "broadcast_overlay_state_templates"
    ADD CONSTRAINT "broadcast_overlay_state_templates_last_loaded_by_user_id_fk"
    FOREIGN KEY ("last_loaded_by_user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
