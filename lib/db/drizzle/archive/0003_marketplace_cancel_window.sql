ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "marketplace_cancel_window_hours" integer NOT NULL DEFAULT 24;
