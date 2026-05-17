-- Migration 0010: Add cancellation policy and members-only time window fields to tee_pricing_rules

-- post-merge-guard: fresh-DB guard (table:tee_pricing_rules)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tee_pricing_rules') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE tee_pricing_rules
  ADD COLUMN IF NOT EXISTS cancellation_policy_type VARCHAR(20) NOT NULL DEFAULT 'forfeit',
  ADD COLUMN IF NOT EXISTS cancellation_fee_flat NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS members_only_start_time TEXT,
  ADD COLUMN IF NOT EXISTS members_only_end_time TEXT;

\else
\echo 'parent table tee_pricing_rules not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

