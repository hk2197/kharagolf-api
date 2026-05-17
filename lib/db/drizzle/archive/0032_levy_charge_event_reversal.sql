-- Task 219: allow admins to reverse a mistakenly recorded levy charge event.
-- A reversal is a new ledger row (event_type='reversal') that points at the
-- original event via reverses_event_id. The charge's paid/refunded totals are
-- recomputed from the surviving (non-reversed, non-reversal) ledger so the
-- compensating entry keeps the audit trail honest without polluting the
-- refund history.


-- post-merge-guard: fresh-DB guard (table:member_levy_charge_events)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_levy_charge_events') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_levy_charge_events
  ADD COLUMN IF NOT EXISTS reverses_event_id INTEGER
    REFERENCES member_levy_charge_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS member_levy_charge_events_reverses_idx
  ON member_levy_charge_events (reverses_event_id);

\else
\echo 'parent table member_levy_charge_events not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

