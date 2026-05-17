-- Task #109: Event & Banquet / Function Management

DO $$ BEGIN
  CREATE TYPE "function_space_layout" AS ENUM('theatre','classroom','banquet','cabaret','boardroom','cocktail','u_shape','hollow_square');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "event_enquiry_status" AS ENUM('enquiry','quote_sent','confirmed','invoiced','paid','cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "event_invoice_status" AS ENUM('draft','sent','paid','overdue','cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "function_spaces" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "capacity_seated" integer,
  "capacity_standing" integer,
  "facilities" jsonb DEFAULT '[]'::jsonb,
  "av_equipment" jsonb DEFAULT '[]'::jsonb,
  "base_price_per_day" numeric(10,2),
  "currency" text NOT NULL DEFAULT 'INR',
  "photo_urls" jsonb DEFAULT '[]'::jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "function_spaces_org_idx" ON "function_spaces" ("organization_id");

CREATE TABLE IF NOT EXISTS "event_catering_packages" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "price_per_head" numeric(10,2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'INR',
  "menu_items" jsonb DEFAULT '[]'::jsonb,
  "inclusions" jsonb DEFAULT '[]'::jsonb,
  "minimum_guests" integer,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "event_catering_packages_org_idx" ON "event_catering_packages" ("organization_id");

CREATE TABLE IF NOT EXISTS "event_bookings" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "function_space_id" integer REFERENCES "function_spaces"("id") ON DELETE SET NULL,
  "catering_package_id" integer REFERENCES "event_catering_packages"("id") ON DELETE SET NULL,
  "status" "event_enquiry_status" NOT NULL DEFAULT 'enquiry',
  "organiser_name" text NOT NULL,
  "organiser_email" text NOT NULL,
  "organiser_phone" text,
  "organiser_company" text,
  "event_name" text NOT NULL,
  "event_type" text,
  "event_date" timestamp with time zone NOT NULL,
  "start_time" text,
  "end_time" text,
  "expected_guests" integer,
  "final_guest_count" integer,
  "layout" "function_space_layout",
  "catering_notes" text,
  "av_requirements" text,
  "special_requirements" text,
  "space_hire_amount" numeric(10,2),
  "catering_amount" numeric(10,2),
  "extras" jsonb DEFAULT '[]'::jsonb,
  "total_amount" numeric(10,2),
  "deposit_amount" numeric(10,2),
  "deposit_paid" boolean NOT NULL DEFAULT false,
  "currency" text NOT NULL DEFAULT 'INR',
  "internal_notes" text,
  "assigned_to_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "event_bookings_org_idx" ON "event_bookings" ("organization_id");
CREATE INDEX IF NOT EXISTS "event_bookings_status_idx" ON "event_bookings" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "event_bookings_date_idx" ON "event_bookings" ("organization_id", "event_date");
CREATE INDEX IF NOT EXISTS "event_bookings_space_idx" ON "event_bookings" ("function_space_id", "event_date");

CREATE TABLE IF NOT EXISTS "event_invoices" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "booking_id" integer NOT NULL REFERENCES "event_bookings"("id") ON DELETE CASCADE,
  "invoice_number" text NOT NULL,
  "status" "event_invoice_status" NOT NULL DEFAULT 'draft',
  "line_items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "subtotal" numeric(10,2) NOT NULL DEFAULT '0',
  "tax_rate" numeric(5,2) NOT NULL DEFAULT '0',
  "tax_amount" numeric(10,2) NOT NULL DEFAULT '0',
  "total_amount" numeric(10,2) NOT NULL DEFAULT '0',
  "currency" text NOT NULL DEFAULT 'INR',
  "due_date" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "notes" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "event_invoices_org_idx" ON "event_invoices" ("organization_id");
CREATE INDEX IF NOT EXISTS "event_invoices_booking_idx" ON "event_invoices" ("booking_id");
CREATE UNIQUE INDEX IF NOT EXISTS "event_invoices_number_org_uidx" ON "event_invoices" ("organization_id", "invoice_number");
