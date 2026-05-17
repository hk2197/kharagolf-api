-- Task 199: itemised payment ledger for every levy charge.
-- Each payment / refund / waive writes one row here in addition to updating
-- the running totals on member_levy_charges. Treasurers and auditors can
-- reconstruct activity without parsing free-text audit reasons.


-- post-merge-guard: fresh-DB guard (table:member_levy_charges)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_levy_charges') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS member_levy_charge_events (
  id SERIAL PRIMARY KEY,
  charge_id INTEGER NOT NULL REFERENCES member_levy_charges(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  club_member_id INTEGER NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL DEFAULT '0',
  method TEXT,
  processor_reference TEXT,
  note TEXT,
  reason TEXT,
  actor_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  actor_name TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS member_levy_charge_events_charge_idx
  ON member_levy_charge_events (charge_id, occurred_at);
CREATE INDEX IF NOT EXISTS member_levy_charge_events_org_time_idx
  ON member_levy_charge_events (organization_id, occurred_at);
CREATE INDEX IF NOT EXISTS member_levy_charge_events_member_idx
  ON member_levy_charge_events (club_member_id);

\else
\echo 'parent table member_levy_charges not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

