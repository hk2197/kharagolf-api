-- Task #145: Automation Rules tables
CREATE TABLE IF NOT EXISTS automation_rules (
  id serial PRIMARY KEY,
  org_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tournament_id integer REFERENCES tournaments(id) ON DELETE CASCADE,
  league_id integer REFERENCES leagues(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_type text NOT NULL,
  trigger_params jsonb,
  channel text NOT NULL DEFAULT 'email',
  audience_filter jsonb,
  subject text,
  body text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_rules_org_idx ON automation_rules(org_id);
CREATE INDEX IF NOT EXISTS automation_rules_tournament_idx ON automation_rules(tournament_id);
CREATE INDEX IF NOT EXISTS automation_rules_league_idx ON automation_rules(league_id);

CREATE TABLE IF NOT EXISTS automation_rule_logs (
  id serial PRIMARY KEY,
  rule_id integer NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  audience_size integer NOT NULL DEFAULT 0,
  delivered_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'completed',
  error_message text
);

CREATE INDEX IF NOT EXISTS automation_rule_logs_rule_idx ON automation_rule_logs(rule_id);
