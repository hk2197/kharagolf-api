
-- post-merge-guard: fresh-DB guard (table:exceptional_score_flags)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'exceptional_score_flags') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "handicap_review_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"player_id" integer,
	"subject_user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"flag_id" integer,
	"period_label" text,
	"details" text,
	"assignee_user_id" integer,
	"decision" text,
	"decision_rationale" text,
	"decision_at" timestamp with time zone,
	"decided_by_user_id" integer,
	"adjustment_id" integer,
	"closed_at" timestamp with time zone,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "handicap_case_peer_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"reviewer_user_id" integer NOT NULL,
	"token" text NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"recommendation" text,
	"comment" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "handicap_case_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" integer,
	"payload" jsonb,
	"from_status" text,
	"to_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_review_cases" ADD CONSTRAINT "handicap_review_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_review_cases" ADD CONSTRAINT "handicap_review_cases_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_review_cases" ADD CONSTRAINT "handicap_review_cases_subject_user_id_app_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "app_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_review_cases" ADD CONSTRAINT "handicap_review_cases_flag_id_exceptional_score_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "exceptional_score_flags"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_review_cases" ADD CONSTRAINT "handicap_review_cases_assignee_user_id_app_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_review_cases" ADD CONSTRAINT "handicap_review_cases_decided_by_user_id_app_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_review_cases" ADD CONSTRAINT "handicap_review_cases_adjustment_id_handicap_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "handicap_adjustments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_review_cases" ADD CONSTRAINT "handicap_review_cases_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_case_peer_reviews" ADD CONSTRAINT "handicap_case_peer_reviews_case_id_handicap_review_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "handicap_review_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_case_peer_reviews" ADD CONSTRAINT "handicap_case_peer_reviews_reviewer_user_id_app_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "app_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_case_audit_log" ADD CONSTRAINT "handicap_case_audit_log_case_id_handicap_review_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "handicap_review_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handicap_case_audit_log" ADD CONSTRAINT "handicap_case_audit_log_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_org_idx" ON "handicap_review_cases" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_subject_idx" ON "handicap_review_cases" ("subject_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_status_idx" ON "handicap_review_cases" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_kind_idx" ON "handicap_review_cases" ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hcp_case_flag_unique" ON "handicap_review_cases" ("flag_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_peer_case_idx" ON "handicap_case_peer_reviews" ("case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_peer_reviewer_idx" ON "handicap_case_peer_reviews" ("reviewer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hcp_case_peer_token_unique" ON "handicap_case_peer_reviews" ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_audit_case_idx" ON "handicap_case_audit_log" ("case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hcp_case_audit_created_idx" ON "handicap_case_audit_log" ("created_at");

\else
\echo 'parent table exceptional_score_flags not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

