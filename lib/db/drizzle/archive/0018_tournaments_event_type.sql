-- Migration: Add missing columns to tournaments table
-- Fixes 500 errors on tournament detail pages caused by columns referenced in schema but missing from DB

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS local_rules_config jsonb,
  ADD COLUMN IF NOT EXISTS suspend_reason text,
  ADD COLUMN IF NOT EXISTS suspended_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS resumed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS members_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS member_entry_fee numeric(10,2),
  ADD COLUMN IF NOT EXISTS notify_pairings boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pairings_published_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS payout_structure jsonb,
  ADD COLUMN IF NOT EXISTS prize_distribution_status text,
  ADD COLUMN IF NOT EXISTS scoring_close_time text,
  ADD COLUMN IF NOT EXISTS allow_self_scoring boolean NOT NULL DEFAULT false;
