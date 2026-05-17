-- Migration: Create all vendor operator management tables
-- Fixes cron job failures for vendor contract renewal alerts and billing cycle auto-generation

DO $$ BEGIN CREATE TYPE vendor_billing_model AS ENUM ('fixed', 'revenue_share', 'hybrid'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vendor_billing_frequency AS ENUM ('monthly', 'annual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vendor_contract_status AS ENUM ('active', 'expired', 'terminated', 'draft'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vendor_invoice_status AS ENUM ('unpaid', 'paid', 'overdue', 'cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vendor_facility_type AS ENUM ('pro_shop', 'f_and_b', 'driving_range', 'other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS vendor_operators (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  contact_name text,
  contact_email text,
  contact_phone text,
  address text,
  gstin text,
  bank_account_name text,
  bank_account_number text,
  bank_ifsc text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_operators_org_idx ON vendor_operators(organization_id);

CREATE TABLE IF NOT EXISTS vendor_facility_assignments (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_operator_id integer NOT NULL REFERENCES vendor_operators(id) ON DELETE CASCADE,
  facility_type vendor_facility_type NOT NULL DEFAULT 'pro_shop',
  facility_name text,
  is_active boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz
);
CREATE INDEX IF NOT EXISTS vendor_facility_assignments_org_idx ON vendor_facility_assignments(organization_id);
CREATE INDEX IF NOT EXISTS vendor_facility_assignments_vendor_idx ON vendor_facility_assignments(vendor_operator_id);

CREATE TABLE IF NOT EXISTS vendor_contracts (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_operator_id integer NOT NULL REFERENCES vendor_operators(id) ON DELETE CASCADE,
  previous_contract_id integer,
  billing_model vendor_billing_model NOT NULL DEFAULT 'fixed',
  fixed_fee_amount numeric(12,2) NOT NULL DEFAULT 0,
  revenue_share_pct numeric(5,2) NOT NULL DEFAULT 0,
  revenue_share_threshold numeric(12,2),
  billing_frequency vendor_billing_frequency NOT NULL DEFAULT 'monthly',
  contract_start_date timestamptz NOT NULL,
  contract_end_date timestamptz,
  notice_period_days integer NOT NULL DEFAULT 30,
  auto_renewal boolean NOT NULL DEFAULT false,
  status vendor_contract_status NOT NULL DEFAULT 'active',
  termination_reason text,
  terminated_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_contracts_org_idx ON vendor_contracts(organization_id);
CREATE INDEX IF NOT EXISTS vendor_contracts_vendor_idx ON vendor_contracts(vendor_operator_id);

CREATE TABLE IF NOT EXISTS vendor_billing_cycles (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_operator_id integer NOT NULL REFERENCES vendor_operators(id) ON DELETE CASCADE,
  vendor_contract_id integer NOT NULL REFERENCES vendor_contracts(id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  gross_sales numeric(12,2) NOT NULL DEFAULT 0,
  member_charges_total numeric(12,2) NOT NULL DEFAULT 0,
  revenue_share_amount numeric(12,2) NOT NULL DEFAULT 0,
  fixed_fee_amount numeric(12,2) NOT NULL DEFAULT 0,
  net_amount_due numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_billing_cycles_org_idx ON vendor_billing_cycles(organization_id);
CREATE INDEX IF NOT EXISTS vendor_billing_cycles_vendor_idx ON vendor_billing_cycles(vendor_operator_id);

CREATE TABLE IF NOT EXISTS vendor_invoices (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_operator_id integer NOT NULL REFERENCES vendor_operators(id) ON DELETE CASCADE,
  vendor_billing_cycle_id integer REFERENCES vendor_billing_cycles(id) ON DELETE SET NULL,
  invoice_number text NOT NULL,
  status vendor_invoice_status NOT NULL DEFAULT 'unpaid',
  total_amount numeric(12,2) NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  due_date timestamptz,
  paid_at timestamptz,
  payment_method text,
  payment_reference text,
  razorpay_payment_link_id text,
  razorpay_payment_link_url text,
  sent_at timestamptz,
  notes text,
  line_items jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_invoices_org_idx ON vendor_invoices(organization_id);
CREATE INDEX IF NOT EXISTS vendor_invoices_vendor_idx ON vendor_invoices(vendor_operator_id);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_invoices_invoice_number_org_unique ON vendor_invoices(organization_id, invoice_number);

CREATE TABLE IF NOT EXISTS vendor_contract_alerts (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_contract_id integer NOT NULL REFERENCES vendor_contracts(id) ON DELETE CASCADE,
  alert_type text NOT NULL,
  days_before_expiry integer,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_contract_alerts_contract_idx ON vendor_contract_alerts(vendor_contract_id);
