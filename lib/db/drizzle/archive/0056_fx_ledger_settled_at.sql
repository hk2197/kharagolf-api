-- Task #499: Stripe webhook reconciliation.
--
-- Add an explicit `settled_at` timestamp to fx_ledger_entries so the moment
-- the processor confirmed settlement is recorded separately from the row
-- insert time (which can drift if the ledger row is written by a backfill
-- job). Backfill existing rows from `created_at`.


-- post-merge-guard: fresh-DB guard (table:fx_ledger_entries)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'fx_ledger_entries') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE fx_ledger_entries
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

UPDATE fx_ledger_entries
  SET settled_at = created_at
  WHERE settled_at IS NULL;

ALTER TABLE fx_ledger_entries
  ALTER COLUMN settled_at SET NOT NULL,
  ALTER COLUMN settled_at SET DEFAULT now();

\else
\echo 'parent table fx_ledger_entries not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

