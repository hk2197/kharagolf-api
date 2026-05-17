
-- post-merge-guard: fresh-DB guard (table:handicap_review_cases)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'handicap_review_cases') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "handicap_case_notifications" (
"id" serial PRIMARY KEY NOT NULL,
"subject_user_id" integer NOT NULL,
"case_id" integer NOT NULL,
"organization_id" integer NOT NULL,
"event" text NOT NULL,
"title" text NOT NULL,
"body" text NOT NULL,
"payload" jsonb,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"read_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_case_notifications" ADD CONSTRAINT "handicap_case_notifications_subject_user_id_app_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "app_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_case_notifications" ADD CONSTRAINT "handicap_case_notifications_case_id_handicap_review_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "handicap_review_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_case_notifications" ADD CONSTRAINT "handicap_case_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_notif_subject_idx" ON "handicap_case_notifications" ("subject_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_notif_case_idx" ON "handicap_case_notifications" ("case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_notif_unread_idx" ON "handicap_case_notifications" ("subject_user_id","read_at");

\else
\echo 'parent table handicap_review_cases not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

