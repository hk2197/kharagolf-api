-- Task #86: Food & Beverage On-Course Ordering

DO $$ BEGIN
  CREATE TYPE "fb_order_status" AS ENUM ('received', 'preparing', 'ready', 'delivered', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "fb_payment_method" AS ENUM ('account_charge', 'card_on_delivery');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "fb_fulfillment_stations" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "holes_served" jsonb DEFAULT '[]',
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "fb_menu_categories" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "fb_menu_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "category_id" integer REFERENCES "fb_menu_categories"("id") ON DELETE SET NULL,
  "station_id" integer REFERENCES "fb_fulfillment_stations"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "description" text,
  "price" numeric(10, 2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'INR',
  "image_url" text,
  "is_available" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "fb_orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "station_id" integer REFERENCES "fb_fulfillment_stations"("id") ON DELETE SET NULL,
  "hole_number" integer,
  "status" "fb_order_status" NOT NULL DEFAULT 'received',
  "payment_method" "fb_payment_method" NOT NULL DEFAULT 'card_on_delivery',
  "total_amount" numeric(10, 2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'INR',
  "notes" text,
  "ready_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "fb_order_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "order_id" integer NOT NULL REFERENCES "fb_orders"("id") ON DELETE CASCADE,
  "menu_item_id" integer REFERENCES "fb_menu_items"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "price" numeric(10, 2) NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "fb_stations_org_idx" ON "fb_fulfillment_stations" ("organization_id");
CREATE INDEX IF NOT EXISTS "fb_categories_org_idx" ON "fb_menu_categories" ("organization_id");
CREATE INDEX IF NOT EXISTS "fb_items_org_idx" ON "fb_menu_items" ("organization_id");
CREATE INDEX IF NOT EXISTS "fb_items_category_idx" ON "fb_menu_items" ("category_id");
CREATE INDEX IF NOT EXISTS "fb_orders_org_idx" ON "fb_orders" ("organization_id");
CREATE INDEX IF NOT EXISTS "fb_orders_user_idx" ON "fb_orders" ("user_id");
CREATE INDEX IF NOT EXISTS "fb_orders_station_idx" ON "fb_orders" ("station_id");
CREATE INDEX IF NOT EXISTS "fb_orders_status_idx" ON "fb_orders" ("status");
CREATE INDEX IF NOT EXISTS "fb_order_items_order_idx" ON "fb_order_items" ("order_id");
