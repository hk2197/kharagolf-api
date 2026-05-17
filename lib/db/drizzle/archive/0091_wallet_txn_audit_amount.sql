-- Task #1072 — store the refunded amount on the wallet audit row instead
-- of parsing it back out of the human-readable note text.
--
-- The `wallet_topup_refund` ledger row is written with `amount = 0` so
-- existing wallet balance arithmetic is untouched. The real refunded
-- amount used to live only in the note string, which the new
-- auto-refund admin dashboard had to regex-parse to compute totals.
--
-- A nullable structured column lets us persist the amount alongside the
-- audit row. Existing rows stay NULL and the read path falls back to
-- parsing the note for those legacy entries.

-- post-merge-guard: fresh-DB guard (table:club_wallet_txns)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'club_wallet_txns') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "club_wallet_txns"
  ADD COLUMN IF NOT EXISTS "audit_amount" numeric(12, 2);

\else
\echo 'parent table club_wallet_txns not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

