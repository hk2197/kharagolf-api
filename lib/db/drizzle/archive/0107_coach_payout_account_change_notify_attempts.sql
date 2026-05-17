-- Task #1280 — persist per-historyId coach payout-account change notify
-- attempts so a transient SMTP/Expo failure on the first try is retried
-- by the cron instead of silently dropping the security-style alert the
-- coach relies on to spot unauthorised payout-account swaps. Mirrors the
-- shape of `wallet_withdrawal_notify_attempts` (Task #1108).


-- post-merge-guard: fresh-DB guard (table:coach_payout_account_history)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'coach_payout_account_history') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "coach_payout_account_change_notify_attempts" (
  "id"                       serial PRIMARY KEY,
  "history_id"               integer                  NOT NULL,
  "organization_id"          integer                  NOT NULL,
  "pro_id"                   integer                  NOT NULL,
  "coach_user_id"            integer                  NOT NULL,
  "change_kind"              text                     NOT NULL,
  "method"                   text                     NOT NULL,
  "created_at"               timestamp with time zone NOT NULL DEFAULT now(),
  "email_status"             text,
  "email_attempts"           integer                  NOT NULL DEFAULT 0,
  "last_email_at"            timestamp with time zone,
  "last_email_error"         text,
  "last_email_retry_at"      timestamp with time zone,
  "next_email_retry_at"      timestamp with time zone,
  "email_retry_exhausted_at" timestamp with time zone,
  "push_status"              text,
  "push_attempts"            integer                  NOT NULL DEFAULT 0,
  "last_push_at"             timestamp with time zone,
  "last_push_error"          text,
  "last_push_retry_at"       timestamp with time zone,
  "next_push_retry_at"       timestamp with time zone,
  "push_retry_exhausted_at"  timestamp with time zone
);

DO $$ BEGIN
  ALTER TABLE "coach_payout_account_change_notify_attempts"
    ADD CONSTRAINT "coach_payout_acct_chg_notify_attempts_history_fk"
    FOREIGN KEY ("history_id") REFERENCES "coach_payout_account_history"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "coach_payout_account_change_notify_attempts"
    ADD CONSTRAINT "coach_payout_acct_chg_notify_attempts_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "coach_payout_account_change_notify_attempts"
    ADD CONSTRAINT "coach_payout_acct_chg_notify_attempts_pro_fk"
    FOREIGN KEY ("pro_id") REFERENCES "teaching_pros"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "coach_payout_acct_chg_notify_attempts_history_unique"
  ON "coach_payout_account_change_notify_attempts" ("history_id");

CREATE INDEX IF NOT EXISTS "coach_payout_acct_chg_notify_attempts_email_failed_idx"
  ON "coach_payout_account_change_notify_attempts" ("email_status", "email_attempts");

CREATE INDEX IF NOT EXISTS "coach_payout_acct_chg_notify_attempts_push_failed_idx"
  ON "coach_payout_account_change_notify_attempts" ("push_status", "push_attempts");

\else
\echo 'parent table coach_payout_account_history not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

