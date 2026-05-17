-- Task #130: Shop Returns, Refunds & Exchanges
-- Adds shop_return_status enum, shop_return_reason enum,
-- shop_returns table, shop_return_items table, shop_return_blacklist table,
-- and shop_order_events table for order timeline logging.

-- ── ENUMS ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "shop_return_status" AS ENUM (
    'pending', 'approved', 'rejected', 'received', 'refunded', 'flagged', 'exchanged'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "shop_return_reason" AS ENUM (
    'wrong_size', 'defective', 'changed_mind', 'wrong_item', 'damaged_in_shipping', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── SHOP_RETURNS ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "shop_returns" (
  "id"                        serial PRIMARY KEY,
  "organization_id"           integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "order_id"                  integer REFERENCES "shop_orders"("id") ON DELETE RESTRICT,
  "pos_transaction_id"        integer,
  "source_type"               text NOT NULL DEFAULT 'online',
  "user_id"                   integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "customer_name"             text NOT NULL,
  "customer_email"            text NOT NULL,
  "reason"                    "shop_return_reason" NOT NULL,
  "reason_detail"             text,
  "status"                    "shop_return_status" NOT NULL DEFAULT 'pending',
  "return_type"               text NOT NULL DEFAULT 'refund',
  "refund_amount"             numeric(10,2),
  "currency"                  text NOT NULL DEFAULT 'INR',
  "razorpay_refund_id"        text,
  "pos_refund_method"         text,
  "exchange_variant_id"       integer REFERENCES "shop_product_variants"("id") ON DELETE SET NULL,
  "credit_note_amount"        numeric(10,2),
  "fraud_score"               integer NOT NULL DEFAULT 0,
  "fraud_flag"                boolean NOT NULL DEFAULT false,
  "fraud_flag_reason"         text,
  "fraud_overridden_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "fraud_overridden_at"       timestamptz,
  "admin_notes"               text,
  "resolved_by_user_id"       integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "resolved_at"               timestamptz,
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "shop_returns_org_idx"    ON "shop_returns"("organization_id");
CREATE INDEX IF NOT EXISTS "shop_returns_order_idx"  ON "shop_returns"("order_id");
CREATE INDEX IF NOT EXISTS "shop_returns_user_idx"   ON "shop_returns"("user_id");
CREATE INDEX IF NOT EXISTS "shop_returns_status_idx" ON "shop_returns"("status");

-- ── SHOP_RETURN_ITEMS ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "shop_return_items" (
  "id"                   serial PRIMARY KEY,
  "return_id"            integer NOT NULL REFERENCES "shop_returns"("id") ON DELETE CASCADE,
  "order_id"             integer REFERENCES "shop_orders"("id") ON DELETE SET NULL,
  "product_id"           integer REFERENCES "shop_products"("id") ON DELETE SET NULL,
  "variant_id"           integer REFERENCES "shop_product_variants"("id") ON DELETE SET NULL,
  "product_name"         text NOT NULL,
  "size"                 text,
  "color"                text,
  "quantity"             integer NOT NULL DEFAULT 1,
  "unit_price"           numeric(10,2) NOT NULL,
  "restocked"            boolean NOT NULL DEFAULT false,
  "exchange_variant_id"  integer REFERENCES "shop_product_variants"("id") ON DELETE SET NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "shop_return_items_return_idx" ON "shop_return_items"("return_id");

-- ── SHOP_RETURN_BLACKLIST ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "shop_return_blacklist" (
  "id"                      serial PRIMARY KEY,
  "organization_id"         integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"                 integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "reason"                  text,
  "blacklisted_by_user_id"  integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at"              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "shop_return_blacklist_org_user_unique" ON "shop_return_blacklist"("organization_id", "user_id");
CREATE INDEX IF NOT EXISTS "shop_return_blacklist_org_idx" ON "shop_return_blacklist"("organization_id");

-- ── SHOP_ORDER_EVENTS (order timeline) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS "shop_order_events" (
  "id"               serial PRIMARY KEY,
  "organization_id"  integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "order_id"         integer REFERENCES "shop_orders"("id") ON DELETE CASCADE,
  "return_id"        integer REFERENCES "shop_returns"("id") ON DELETE CASCADE,
  "event_type"       text NOT NULL,
  "description"      text NOT NULL,
  "metadata"         jsonb,
  "user_id"          integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "shop_order_events_order_idx"  ON "shop_order_events"("order_id");
CREATE INDEX IF NOT EXISTS "shop_order_events_return_idx" ON "shop_order_events"("return_id");
CREATE INDEX IF NOT EXISTS "shop_order_events_org_idx"    ON "shop_order_events"("organization_id");

-- Extend shop_order_status enum for returns lifecycle
ALTER TYPE shop_order_status ADD VALUE IF NOT EXISTS 'returned';
ALTER TYPE shop_order_status ADD VALUE IF NOT EXISTS 'exchanged';
