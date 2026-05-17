-- Task #850 — Per-org thresholds + alert email recipient for the
-- needs_reauth wearable sweep alert. Sensible defaults match the
-- previous hardcoded constants (>= 5 connections OR >= 25% share with
-- at least 4 attempted) so existing orgs see no behaviour change.

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "wearable_reauth_alert_min_count" integer NOT NULL DEFAULT 5;--> statement-breakpoint
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "wearable_reauth_alert_min_share_pct" integer NOT NULL DEFAULT 25;--> statement-breakpoint
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "wearable_reauth_alert_min_attempted" integer NOT NULL DEFAULT 4;--> statement-breakpoint
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "wearable_reauth_alert_email" text;
