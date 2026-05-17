-- Migration: India-first e-commerce (self-managed inventory + Shiprocket + GST)
-- Adds new tables and columns required by the new shop system.
-- Safe to run on existing DBs: uses IF NOT EXISTS / IF NOT IN enum.

-- 1. Add cod_pending to shop_order_status enum (Postgres ALTER TYPE is idempotent-safe via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.shop_order_status'::regtype
      AND enumlabel = 'cod_pending'
  ) THEN
    ALTER TYPE "public"."shop_order_status" ADD VALUE 'cod_pending';
  END IF;
END$$;

-- 2. shop_product_variants table
CREATE TABLE IF NOT EXISTS "shop_product_variants" (
  "id" serial PRIMARY KEY NOT NULL,
  "product_id" integer NOT NULL REFERENCES "shop_products"("id") ON DELETE cascade,
  "color" text,
  "size" text,
  "stock_qty" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shop_variants_product_idx" ON "shop_product_variants" USING btree ("product_id");

-- 3. shop_store_settings table
CREATE TABLE IF NOT EXISTS "shop_store_settings" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL UNIQUE REFERENCES "organizations"("id") ON DELETE cascade,
  "gstin" text,
  "seller_name" text,
  "seller_address" text,
  "seller_state" text,
  "seller_state_code" text,
  "shiprocket_email" text,
  "shiprocket_password" text,
  "shiprocket_token" text,
  "shiprocket_token_expiry" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shop_store_settings_org_idx" ON "shop_store_settings" USING btree ("organization_id");

-- 4. New columns on shop_orders
ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "variant_id" integer REFERENCES "shop_product_variants"("id") ON DELETE set null;
ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "color" text;
ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "payment_mode" text NOT NULL DEFAULT 'razorpay';
ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "shiprocket_order_id" text;
ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "awb_code" text;
ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "buyer_gstin" text;
ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "seller_gstin" text;
ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "invoice_path" text;
ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "gst_rate" numeric(4, 2);
ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "hsn_code" text;

-- 5. New columns on shop_products
ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "stock_count" integer;
ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "hsn_code" text;
ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "gst_rate" numeric(4, 2) DEFAULT 18;

-- 6. Remove legacy fulfillment/POD columns from shop_products
ALTER TABLE "shop_products" DROP COLUMN IF EXISTS "fulfillment_type";
ALTER TABLE "shop_products" DROP COLUMN IF EXISTS "affiliate_url";
