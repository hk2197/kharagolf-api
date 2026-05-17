-- Task #247: Track per-channel retry attempts for levy-receipt push and SMS
-- notifications, so a scheduled job can re-attempt failed deliveries a bounded
-- number of times. Mirrors the privacy-request retry pattern (Task #191):
-- one row is inserted per receipt notification capturing the rebuilt payload
-- (kind, levy name, currency, transaction amount, new balance, note) so the
-- retry cron does not depend on the (possibly mutated) charge row.


-- post-merge-guard: fresh-DB guard (table:member_levy_charges)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_levy_charges') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS member_levy_receipt_attempts (
  id                       SERIAL PRIMARY KEY,
  organization_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  charge_id                INTEGER NOT NULL REFERENCES member_levy_charges(id) ON DELETE CASCADE,
  club_member_id           INTEGER NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
  kind                     TEXT NOT NULL,
  levy_name                TEXT NOT NULL,
  currency                 TEXT NOT NULL,
  transaction_amount       NUMERIC(12, 2) NOT NULL,
  new_balance              NUMERIC(12, 2) NOT NULL,
  note                     TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  push_status              TEXT,
  push_attempts            INTEGER NOT NULL DEFAULT 0,
  last_push_at             TIMESTAMPTZ,
  last_push_error          TEXT,
  last_push_retry_at       TIMESTAMPTZ,
  push_retry_exhausted_at  TIMESTAMPTZ,
  sms_status               TEXT,
  sms_attempts             INTEGER NOT NULL DEFAULT 0,
  last_sms_at              TIMESTAMPTZ,
  last_sms_error           TEXT,
  last_sms_retry_at        TIMESTAMPTZ,
  sms_retry_exhausted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS member_levy_receipt_attempts_charge_idx
  ON member_levy_receipt_attempts (charge_id);
CREATE INDEX IF NOT EXISTS member_levy_receipt_attempts_org_idx
  ON member_levy_receipt_attempts (organization_id);
CREATE INDEX IF NOT EXISTS member_levy_receipt_attempts_member_idx
  ON member_levy_receipt_attempts (club_member_id);

\else
\echo 'parent table member_levy_charges not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

