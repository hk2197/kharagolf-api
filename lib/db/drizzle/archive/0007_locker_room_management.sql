-- Migration: Locker Room Management
-- Adds locker, locker_assignments, locker_audit, and locker_waitlist tables.
-- Safe to run on existing DBs: uses IF NOT EXISTS / DO blocks for enums.

-- 1. Enums (idempotent via DO blocks)
DO $$ BEGIN
  CREATE TYPE locker_status AS ENUM ('available', 'occupied', 'reserved', 'maintenance');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE locker_assignment_status AS ENUM ('active', 'expired', 'cancelled', 'pending_payment');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE locker_payment_method AS ENUM ('account_charge', 'razorpay');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. lockers table
CREATE TABLE IF NOT EXISTS "lockers" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "locker_number" text NOT NULL,
  "bay" text,
  "row" integer,
  "column" integer,
  "status" locker_status NOT NULL DEFAULT 'available',
  "annual_fee" numeric(10,2) NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'INR',
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "locker_org_number_unique" ON "lockers" USING btree ("organization_id", "locker_number");
CREATE INDEX IF NOT EXISTS "lockers_org_idx" ON "lockers" USING btree ("organization_id");

-- 3. locker_assignments table
CREATE TABLE IF NOT EXISTS "locker_assignments" (
  "id" serial PRIMARY KEY NOT NULL,
  "locker_id" integer NOT NULL REFERENCES "lockers"("id") ON DELETE cascade,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE restrict,
  "start_date" timestamp with time zone NOT NULL,
  "expiry_date" timestamp with time zone NOT NULL,
  "status" locker_assignment_status NOT NULL DEFAULT 'active',
  "annual_fee" numeric(10,2) NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'INR',
  "payment_method" locker_payment_method NOT NULL DEFAULT 'account_charge',
  "payment_status" payment_status NOT NULL DEFAULT 'unpaid',
  "razorpay_order_id" text,
  "razorpay_payment_id" text,
  "payment_link_id" text,
  "payment_link_url" text,
  "assigned_by" integer REFERENCES "app_users"("id") ON DELETE set null,
  "reassigned_at" timestamp with time zone,
  "reassigned_reason" text,
  "notes" text,
  "reminder_30_sent_at" timestamp with time zone,
  "reminder_7_sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "locker_assignments_locker_idx" ON "locker_assignments" USING btree ("locker_id");
CREATE INDEX IF NOT EXISTS "locker_assignments_member_idx" ON "locker_assignments" USING btree ("member_id");
CREATE INDEX IF NOT EXISTS "locker_assignments_org_idx" ON "locker_assignments" USING btree ("organization_id");
CREATE INDEX IF NOT EXISTS "locker_assignments_expiry_idx" ON "locker_assignments" USING btree ("expiry_date");

-- 4. locker_audit table
CREATE TABLE IF NOT EXISTS "locker_audit" (
  "id" serial PRIMARY KEY NOT NULL,
  "locker_id" integer NOT NULL REFERENCES "lockers"("id") ON DELETE cascade,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "action" text NOT NULL,
  "previous_member_id" integer REFERENCES "club_members"("id") ON DELETE set null,
  "new_member_id" integer REFERENCES "club_members"("id") ON DELETE set null,
  "performed_by" integer REFERENCES "app_users"("id") ON DELETE set null,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "locker_audit_locker_idx" ON "locker_audit" USING btree ("locker_id");
CREATE INDEX IF NOT EXISTS "locker_audit_org_idx" ON "locker_audit" USING btree ("organization_id");

-- 5. locker_waitlist table
CREATE TABLE IF NOT EXISTS "locker_waitlist" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "member_id" integer NOT NULL REFERENCES "club_members"("id") ON DELETE cascade,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "notified_at" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'waiting',
  "notes" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "locker_waitlist_org_member_unique" ON "locker_waitlist" USING btree ("organization_id", "member_id");
CREATE INDEX IF NOT EXISTS "locker_waitlist_org_idx" ON "locker_waitlist" USING btree ("organization_id");
