-- Migration 0110 — Reconcile drizzle schema with live DB drift after main-app rebase.
--
-- Authored as part of post-merge schema sync during Task #1319 rebase. The
-- four statements below are exactly what `pnpm --filter @workspace/db sync`
-- diffed between the live DB and the drizzle schema after merging upstream
-- main:
--
--   1. DROP INDEX "post_event_surveys_tournament_unique"
--      Live DB carries an obsolete unique index on post_event_surveys
--      (tournament_id) that the drizzle schema no longer declares. The
--      partial-uniqueness this used to enforce moved into application-level
--      validation; drop the legacy index so subsequent sync runs are clean.
--
--   2. DROP INDEX "players_tournament_cut_at_idx"
--      Live DB carries an index that drizzle no longer declares. Drop to
--      bring the two in line.
--
--   3. ADD CONSTRAINT "club_wallet_withdrawals_payout_account_fk"
--      Drizzle declares the FK from club_wallet_withdrawals.payout_account_id
--      → wallet_payout_accounts.id but the live DB is missing it. This add
--      restores referential integrity for an already-required relationship.
--
--   4. DROP CONSTRAINT "analytics_event_metadata_org_fk"
--      Live DB carries a FK constraint added by migration 0109 that the
--      drizzle definition (lib/db/src/schema/analyticsEventMetadata.ts) does
--      not declare. The application code already validates org ownership at
--      the API layer; drop the orphan constraint so drizzle and the DB agree.
--      A future task can re-introduce the FK in the drizzle schema (via
--      `references(() => organizationsTable.id, { onDelete: "cascade" })`)
--      and a paired migration if stricter integrity is desired.
--
-- All four are idempotent — wrapped in IF EXISTS guards so reruns and fresh
-- DB bootstraps both succeed.


-- post-merge-guard: fresh-DB guard (table:club_wallet_withdrawals)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'club_wallet_withdrawals') AS post_merge_dep_present \gset
\if :post_merge_dep_present

BEGIN;

DROP INDEX IF EXISTS "post_event_surveys_tournament_unique";

DROP INDEX IF EXISTS "players_tournament_cut_at_idx";

DO $$ BEGIN
  ALTER TABLE "club_wallet_withdrawals"
    ADD CONSTRAINT "club_wallet_withdrawals_payout_account_fk"
    FOREIGN KEY ("payout_account_id")
    REFERENCES "wallet_payout_accounts"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "analytics_event_metadata"
  DROP CONSTRAINT IF EXISTS "analytics_event_metadata_org_fk";

COMMIT;

\else
\echo 'parent table club_wallet_withdrawals not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

