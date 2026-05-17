-- Migration 0076 — align FK constraint names + analytics indexes with the
-- drizzle schema so post-merge `pnpm --filter @workspace/db sync` produces
-- a clean diff (no destructive statements pending).
--
-- Two unrelated drift sources were converging here:
--   1. Task #770 wallet payouts created FK constraints with short names
--      ("..._fk") via raw SQL; drizzle expects its long-form
--      "<table>_<col>_<reftable>_<refcol>_fk" naming.
--   2. Task #935 / Wave 0 analytics_events indexes were created with
--      DESC ordering on occurred_at but the drizzle schema declares them
--      without explicit ordering, so introspect wants to recreate them.
--
-- All changes here are pure renames or index recreates — no data is lost.

BEGIN;

-- ── 1. Wallet FK constraint renames ─────────────────────────────────────
DO $$
DECLARE
  r RECORD;
BEGIN
  -- club_wallet_withdrawals
  FOR r IN VALUES
    ('club_wallet_withdrawals', 'club_wallet_withdrawals_wallet_fk',      'club_wallet_withdrawals_wallet_id_club_wallets_id_fk'),
    ('club_wallet_withdrawals', 'club_wallet_withdrawals_org_fk',         'club_wallet_withdrawals_organization_id_organizations_id_fk'),
    ('club_wallet_withdrawals', 'club_wallet_withdrawals_user_fk',        'club_wallet_withdrawals_user_id_app_users_id_fk'),
    ('club_wallet_withdrawals', 'club_wallet_withdrawals_debit_txn_fk',   'club_wallet_withdrawals_debit_txn_id_club_wallet_txns_id_fk'),
    ('club_wallet_withdrawals', 'club_wallet_withdrawals_refund_txn_fk',  'club_wallet_withdrawals_refund_txn_id_club_wallet_txns_id_fk'),
    ('wallet_payout_accounts',  'wallet_payout_accounts_org_fk',          'wallet_payout_accounts_organization_id_organizations_id_fk'),
    ('wallet_payout_accounts',  'wallet_payout_accounts_user_fk',         'wallet_payout_accounts_user_id_app_users_id_fk')
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = r.column1 AND c.conname = r.column2
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = r.column1 AND c.conname = r.column3
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.column1, r.column2, r.column3);
    END IF;
  END LOOP;
END $$;

-- ── 2. Analytics events: drop+recreate indexes without DESC ────────────
DROP INDEX IF EXISTS "analytics_events_event_idx";
DROP INDEX IF EXISTS "analytics_events_org_idx";
DROP INDEX IF EXISTS "analytics_events_user_idx";

CREATE INDEX "analytics_events_event_idx" ON "analytics_events" ("event_name", "occurred_at");
CREATE INDEX "analytics_events_org_idx"   ON "analytics_events" ("organization_id", "occurred_at");
CREATE INDEX "analytics_events_user_idx"  ON "analytics_events" ("user_id", "occurred_at");

-- ── 3. course_hole_geometry / analytics_events FK names ────────────────
-- Postgres' default name from REFERENCES inline is "<table>_<col>_fkey".
-- Drizzle schema expects long-form. Rename if needed.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN VALUES
    ('course_hole_geometry', 'course_hole_geometry_course_id_fkey',     'course_hole_geometry_course_id_courses_id_fk'),
    ('analytics_events',     'analytics_events_organization_id_fkey',   'analytics_events_organization_id_organizations_id_fk'),
    ('analytics_events',     'analytics_events_user_id_fkey',           'analytics_events_user_id_app_users_id_fk')
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = r.column1 AND c.conname = r.column2
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = r.column1 AND c.conname = r.column3
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.column1, r.column2, r.column3);
    END IF;
  END LOOP;
END $$;

COMMIT;
