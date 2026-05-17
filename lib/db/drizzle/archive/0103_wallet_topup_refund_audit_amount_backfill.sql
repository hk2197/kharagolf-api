-- Task #1239 — backfill `audit_amount` for legacy auto-refund audit rows.
--
-- Task #1072 added `club_wallet_txns.audit_amount` (migration 0091) and
-- started writing the structured refunded amount on every new
-- `wallet_topup_refund` audit row. Rows written before that change still
-- have `audit_amount = NULL`, and the admin dashboard / CSV export had
-- to fall back to a regex over the human-readable note text to surface
-- their amount (`parseRefundAmountFromNote` /
-- `LEGACY_REFUND_AMOUNT_RE` in
-- `artifacts/api-server/src/routes/side-games-v2.ts`).
--
-- This one-shot UPDATE parses the legacy notes with the same shape used
-- by the read path — `<3-letter currency code> <amount>` where amount
-- may include thousands separators and an optional decimal — and writes
-- the result into `audit_amount`. After this migration runs we can drop
-- the read-side fallback entirely and rely on the structured column for
-- all rows, new and old.
--
-- Idempotent by design: `audit_amount IS NULL` filters out rows that
-- already have a structured amount (either freshly written by the
-- adjustment helper after Task #1072, or backfilled by a previous
-- run). The `note ~ '...'` guard prevents NULL parse failures (a row
-- whose note doesn't match the legacy shape stays NULL, mirroring the
-- read path's behaviour).

-- post-merge-guard: fresh-DB guard (table:club_wallet_txns)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'club_wallet_txns') AS post_merge_dep_present \gset
\if :post_merge_dep_present

UPDATE "club_wallet_txns"
   SET "audit_amount" = REPLACE(
         (regexp_match("note", '[A-Z]{3}[[:space:]]+([0-9,]+(\.[0-9]+)?)'))[1],
         ',', ''
       )::numeric(12, 2)
 WHERE "source_type" = 'wallet_topup_refund'
   AND "audit_amount" IS NULL
   AND "note" IS NOT NULL
   AND "note" ~ '[A-Z]{3}[[:space:]]+[0-9,]+(\.[0-9]+)?';

\else
\echo 'parent table club_wallet_txns not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

