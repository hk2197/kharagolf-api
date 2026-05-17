-- Task #1108 — persist per-(withdrawal × outcome) wallet-withdrawal notify
-- attempts so a transient SMTP/Expo failure on the first try is retried by
-- the cron instead of silently dropping the member's only confirmation.
-- Mirrors `side_game_settlement_receipt_attempts` (Task #961) and
-- `coach_payout_notification_attempts` (Task #967).


-- post-merge-guard: fresh-DB guard (table:club_wallet_withdrawals)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'club_wallet_withdrawals') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "wallet_withdrawal_notify_attempts" (
  "id"                       serial PRIMARY KEY,
  "withdrawal_id"            integer                  NOT NULL,
  "organization_id"          integer                  NOT NULL,
  "user_id"                  integer                  NOT NULL,
  "outcome"                  text                     NOT NULL,
  "amount"                   numeric(14, 2)           NOT NULL,
  "currency"                 text                     NOT NULL,
  "destination"              text                     NOT NULL,
  "utr"                      text,
  "reason"                   text,
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
  ALTER TABLE "wallet_withdrawal_notify_attempts"
    ADD CONSTRAINT "wallet_wd_notify_attempts_withdrawal_fk"
    FOREIGN KEY ("withdrawal_id") REFERENCES "club_wallet_withdrawals"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_withdrawal_notify_attempts"
    ADD CONSTRAINT "wallet_wd_notify_attempts_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_wd_notify_attempts_wd_outcome_unique"
  ON "wallet_withdrawal_notify_attempts" ("withdrawal_id", "outcome");

CREATE INDEX IF NOT EXISTS "wallet_wd_notify_attempts_email_failed_idx"
  ON "wallet_withdrawal_notify_attempts" ("email_status", "email_attempts");

CREATE INDEX IF NOT EXISTS "wallet_wd_notify_attempts_push_failed_idx"
  ON "wallet_withdrawal_notify_attempts" ("push_status", "push_attempts");

\else
\echo 'parent table club_wallet_withdrawals not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

