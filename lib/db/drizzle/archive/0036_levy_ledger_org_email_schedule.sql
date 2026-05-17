-- Task 278: org-level (club-wide) recurring email of the combined levy ledger.
-- One schedule per organization. Cron picks up enabled rows whose next_run_at
-- has elapsed, builds a single CSV containing every levy's events for the
-- elapsed period, emails it to all configured recipients, and records a row
-- in levy_ledger_email_org_runs so the admin UI can show history and outcomes.

CREATE TABLE IF NOT EXISTS levy_ledger_email_org_schedules (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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

CREATE UNIQUE INDEX IF NOT EXISTS levy_ledger_email_org_schedules_unique
  ON levy_ledger_email_org_schedules(organization_id);

CREATE INDEX IF NOT EXISTS levy_ledger_email_org_schedules_next_run_idx
  ON levy_ledger_email_org_schedules(next_run_at)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS levy_ledger_email_org_runs (
  id serial PRIMARY KEY,
  schedule_id integer NOT NULL REFERENCES levy_ledger_email_org_schedules(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  period_start timestamptz,
  period_end timestamptz NOT NULL,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  levy_count integer NOT NULL DEFAULT 0,
  -- 'sent' | 'failed' | 'skipped'
  status text NOT NULL,
  error_message text
);

CREATE INDEX IF NOT EXISTS levy_ledger_email_org_runs_schedule_idx
  ON levy_ledger_email_org_runs(schedule_id, sent_at DESC);
