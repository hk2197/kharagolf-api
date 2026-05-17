-- Task #146: Sponsor Self-Service Portal
-- Adds portal access, asset management, and pipeline columns to sponsors table.

ALTER TABLE "sponsors"
  ADD COLUMN IF NOT EXISTS "contact_email" text,
  ADD COLUMN IF NOT EXISTS "contact_name" text,
  ADD COLUMN IF NOT EXISTS "contact_phone" text,
  ADD COLUMN IF NOT EXISTS "portal_password_hash" text,
  ADD COLUMN IF NOT EXISTS "portal_token" text,
  ADD COLUMN IF NOT EXISTS "portal_token_expiry" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "banner_url" text,
  ADD COLUMN IF NOT EXISTS "pending_logo_url" text,
  ADD COLUMN IF NOT EXISTS "pending_banner_url" text,
  ADD COLUMN IF NOT EXISTS "asset_rejection_feedback" text,
  ADD COLUMN IF NOT EXISTS "pipeline_status" text NOT NULL DEFAULT 'prospect',
  ADD COLUMN IF NOT EXISTS "renewal_date" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "notes" text,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
