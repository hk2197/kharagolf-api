-- Migration: GST-compliant invoice generation and commerce analytics support
-- Creates invoice_sequences, gst_invoices tables; adds default_sac_code to shop_store_settings.
-- All DDL is idempotent (IF NOT EXISTS) so the migration is safe to run even if
-- objects were already created directly via SQL in an earlier session.

-- ── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE gst_invoice_channel AS ENUM ('shop', 'pos', 'tournament', 'league');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE gst_invoice_routing AS ENUM ('cgst_sgst', 'igst', 'zero_rated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── invoice_sequences ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoice_sequences (
  id             SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel        TEXT NOT NULL,
  prefix         TEXT NOT NULL DEFAULT 'INV',
  last_seq       INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS invoice_sequences_org_channel_unique
  ON invoice_sequences (organization_id, channel);

-- ── gst_invoices ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gst_invoices (
  id                   SERIAL PRIMARY KEY,
  organization_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_number       TEXT NOT NULL,
  channel              gst_invoice_channel NOT NULL,

  shop_order_id        INTEGER REFERENCES shop_orders(id) ON DELETE SET NULL,
  pos_transaction_id   INTEGER REFERENCES pos_transactions(id) ON DELETE SET NULL,
  tournament_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  league_member_id     INTEGER REFERENCES league_members(id) ON DELETE SET NULL,

  buyer_name           TEXT NOT NULL,
  buyer_email          TEXT,
  buyer_gstin          TEXT,
  buyer_address        TEXT,
  buyer_state          TEXT,
  buyer_state_code     TEXT,
  buyer_country        TEXT NOT NULL DEFAULT 'IN',

  seller_gstin         TEXT,
  seller_name          TEXT,
  seller_address       TEXT,
  seller_state         TEXT,
  seller_state_code    TEXT,

  line_items           JSONB NOT NULL,

  taxable_amount       NUMERIC(12, 2) NOT NULL,
  cgst_amount          NUMERIC(12, 2) NOT NULL DEFAULT 0,
  sgst_amount          NUMERIC(12, 2) NOT NULL DEFAULT 0,
  igst_amount          NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_amount         NUMERIC(12, 2) NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'INR',

  gst_routing          gst_invoice_routing NOT NULL DEFAULT 'igst',
  state_of_supply      TEXT,
  lut                  TEXT,

  status               TEXT NOT NULL DEFAULT 'issued',
  pdf_path             TEXT,
  emailed_at           TIMESTAMPTZ,

  invoice_date         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite unique: org + invoice number
CREATE UNIQUE INDEX IF NOT EXISTS gst_invoices_number_org_unique
  ON gst_invoices (organization_id, invoice_number);

-- General lookup indexes
CREATE INDEX IF NOT EXISTS gst_invoices_org_idx     ON gst_invoices (organization_id);
CREATE INDEX IF NOT EXISTS gst_invoices_channel_idx ON gst_invoices (channel);

-- Source-scoped partial unique indexes (idempotency / race safety)
CREATE UNIQUE INDEX IF NOT EXISTS gst_invoices_shop_order_unique
  ON gst_invoices (organization_id, shop_order_id)
  WHERE shop_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS gst_invoices_pos_txn_unique
  ON gst_invoices (organization_id, pos_transaction_id)
  WHERE pos_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS gst_invoices_tournament_player_unique
  ON gst_invoices (organization_id, tournament_player_id)
  WHERE tournament_player_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS gst_invoices_league_member_unique
  ON gst_invoices (organization_id, league_member_id)
  WHERE league_member_id IS NOT NULL;

-- ── shop_store_settings: add default_sac_code column ─────────────────────────

ALTER TABLE shop_store_settings
  ADD COLUMN IF NOT EXISTS default_sac_code TEXT;
