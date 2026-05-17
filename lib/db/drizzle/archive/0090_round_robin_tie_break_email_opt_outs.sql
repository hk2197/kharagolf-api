-- Task #1045 — let directors unsubscribe from tie-break emails with one click.
-- Per-(org, user) opt-out from `sendRoundRobinTieBreakAlertEmail` (Task #898).
-- Only the email is suppressed; push + in-app inbox delivery is unaffected.
CREATE TABLE IF NOT EXISTS "round_robin_tie_break_email_opt_outs" (
  "organization_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "opted_out_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "round_robin_tie_break_email_opt_outs"
    ADD CONSTRAINT "rr_tie_break_email_opt_outs_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "round_robin_tie_break_email_opt_outs"
    ADD CONSTRAINT "round_robin_tie_break_email_opt_outs_user_id_app_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "rr_tie_break_email_opt_out_unique"
  ON "round_robin_tie_break_email_opt_outs" ("organization_id", "user_id");
