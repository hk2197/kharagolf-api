-- Task #549 — Producer cue-sheet templates broadcasters can prep ahead of time.
-- Named overlay state templates per tournament so multiple producers can pre-build
-- shows ("Sunday final round", "Hole 17 amen corner") and load them on demand.
-- The current live cue state remains in `broadcast_overlay_states`; loading a
-- template copies its JSON into that row.

CREATE TABLE IF NOT EXISTS "broadcast_overlay_state_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "tournament_id" integer NOT NULL,
  "organization_id" integer NOT NULL,
  "name" text NOT NULL,
  "state" jsonb NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "broadcast_overlay_state_templates"
    ADD CONSTRAINT "broadcast_overlay_state_templates_tournament_id_tournaments_id_fk"
    FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "broadcast_overlay_state_templates"
    ADD CONSTRAINT "broadcast_overlay_state_templates_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "broadcast_overlay_state_templates"
    ADD CONSTRAINT "broadcast_overlay_state_templates_created_by_user_id_app_users_id_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_overlay_template_tournament_name_unique"
  ON "broadcast_overlay_state_templates" ("tournament_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcast_overlay_template_tournament_idx"
  ON "broadcast_overlay_state_templates" ("tournament_id");
