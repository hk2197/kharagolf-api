-- Task #1254: Forecast accuracy weekly/monthly digest CSV.
--
-- Mirrors the per-currency revenue pivot pattern (migration 0064): one
-- schedule per organization, hourly cron picks up enabled rows whose
-- next_run_at has elapsed, builds the CSV using the same columns as the
-- manual download in the Forecast Accuracy tab for the elapsed period,
-- emails it to the configured recipients, and records a row in the runs
-- table. The schedule can be paused (enabled=false) without losing the
-- recipient list.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) so
-- it is safe to re-run on databases that may have been touched by
-- drizzle-kit push during development.

CREATE TABLE IF NOT EXISTS forecast_accuracy_email_schedules (
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

CREATE UNIQUE INDEX IF NOT EXISTS forecast_accuracy_email_schedules_unique
  ON forecast_accuracy_email_schedules(organization_id);

CREATE INDEX IF NOT EXISTS forecast_accuracy_email_schedules_next_run_idx
  ON forecast_accuracy_email_schedules(next_run_at)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS forecast_accuracy_email_runs (
  id serial PRIMARY KEY,
  schedule_id integer NOT NULL REFERENCES forecast_accuracy_email_schedules(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS forecast_accuracy_email_runs_schedule_idx
  ON forecast_accuracy_email_runs(schedule_id, sent_at DESC);
