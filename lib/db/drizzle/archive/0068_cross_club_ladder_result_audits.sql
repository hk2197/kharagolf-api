-- Task #751 — Audit log for edits/deletes of posted cross-club ladder
-- results. Captures who acted, when, and the before/after field diff
-- (`field_changes`) or the full pre-delete snapshot (`snapshot`).
-- `result_id` is intentionally NOT a foreign key so delete audits
-- survive removal of the underlying result row.

-- post-merge-guard: fresh-DB guard (table:cross_club_ladders)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cross_club_ladders') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "cross_club_ladder_result_audits" (
  "id" serial PRIMARY KEY NOT NULL,
  "ladder_id" integer NOT NULL,
  "result_id" integer NOT NULL,
  "entry_id" integer NOT NULL,
  "action" text NOT NULL,
  "actor_user_id" integer,
  "actor_name" text,
  "actor_role" text,
  "field_changes" jsonb,
  "snapshot" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "cross_club_ladder_result_audits"
    ADD CONSTRAINT "cross_club_ladder_result_audits_ladder_id_cross_club_ladders_id_fk"
    FOREIGN KEY ("ladder_id") REFERENCES "public"."cross_club_ladders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cross_club_ladder_result_audits"
    ADD CONSTRAINT "cross_club_ladder_result_audits_actor_user_id_app_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ccl_result_audits_result_idx"
  ON "cross_club_ladder_result_audits" USING btree ("result_id");
CREATE INDEX IF NOT EXISTS "ccl_result_audits_ladder_created_idx"
  ON "cross_club_ladder_result_audits" USING btree ("ladder_id","created_at");
CREATE INDEX IF NOT EXISTS "ccl_result_audits_entry_idx"
  ON "cross_club_ladder_result_audits" USING btree ("entry_id");

\else
\echo 'parent table cross_club_ladders not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

