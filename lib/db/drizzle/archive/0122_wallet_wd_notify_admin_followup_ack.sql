-- Task #1501 — admins can mark a notified-exhausted wallet-withdrawal
-- alert row as "manually followed up" so it drops off the
-- /admin/wallet-withdrawal-exhaustion-alerts list view. Stamps the
-- wall-clock at click and the acting admin's user id so we have a
-- basic audit trail of who cleared it.
--
-- The partial index keeps the open worklist query cheap as the table
-- grows: it covers the (org, notified) lookup but only includes rows
-- that are currently "open" (notified but not yet acknowledged).

-- post-merge-guard: fresh-DB guard (table:wallet_withdrawal_notify_attempts)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wallet_withdrawal_notify_attempts') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "wallet_withdrawal_notify_attempts"
  ADD COLUMN IF NOT EXISTS "admin_followup_acknowledged_at" timestamptz;

ALTER TABLE "wallet_withdrawal_notify_attempts"
  ADD COLUMN IF NOT EXISTS "admin_followup_acknowledged_by" integer;

DO $$ BEGIN
  ALTER TABLE "wallet_withdrawal_notify_attempts"
    ADD CONSTRAINT "wallet_wd_notify_attempts_admin_followup_user_fk"
    FOREIGN KEY ("admin_followup_acknowledged_by")
    REFERENCES "app_users"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "wallet_wd_notify_attempts_open_admin_alert_idx"
  ON "wallet_withdrawal_notify_attempts" ("organization_id", "admin_exhaustion_notified_at")
  WHERE "admin_exhaustion_notified_at" IS NOT NULL
    AND "admin_followup_acknowledged_at" IS NULL;

\else
\echo 'parent table wallet_withdrawal_notify_attempts not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

