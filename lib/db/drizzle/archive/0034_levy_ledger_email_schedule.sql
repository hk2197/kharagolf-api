-- Task 229: schedule a recurring email of the levy ledger CSV to the treasurer.
-- One schedule per (organization, levy). Each enabled schedule is processed
-- by the in-process cron when next_run_at <= now(). Every send is recorded in
-- levy_ledger_email_runs so the admin UI can show history and outcomes.


-- post-merge-guard: fresh-DB guard (table:member_levies)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_levies') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS levy_ledger_email_schedules (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  levy_id integer NOT NULL REFERENCES member_levies(id) ON DELETE CASCADE,
  -- 'weekly' | 'monthly'
  frequency text NOT NULL,
  -- jsonb array of recipient email addresses (1+); validated in the API layer
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  last_sent_at timestamptz,
  next_run_at timestamptz NOT NULL,
  created_by_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS levy_ledger_email_schedules_unique
  ON levy_ledger_email_schedules(organization_id, levy_id);

CREATE INDEX IF NOT EXISTS levy_ledger_email_schedules_next_run_idx
  ON levy_ledger_email_schedules(next_run_at)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS levy_ledger_email_runs (
  id serial PRIMARY KEY,
  schedule_id integer NOT NULL REFERENCES levy_ledger_email_schedules(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  period_start timestamptz,
  period_end timestamptz NOT NULL,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  -- 'sent' | 'failed' | 'skipped'
  status text NOT NULL,
  error_message text
);

CREATE INDEX IF NOT EXISTS levy_ledger_email_runs_schedule_idx
  ON levy_ledger_email_runs(schedule_id, sent_at DESC);

\else
\echo 'parent table member_levies not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

